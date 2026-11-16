// 相機拍照辨識：即時預覽 + 對準框 + 自動辨識；也可以從相簿選照片
import { recognize } from './ocr.js';

const $ = (sel, root = document) => root.querySelector(sel);

let stream = null;
let timer = 0;
let onResult = null;
let mode = 'video'; // 'video' | 'photo'
let photoImg = null;
let history = [];
let busy = false;
const work = document.createElement('canvas');

// 照片模式的平移縮放
const view = { x: 0, y: 0, s: 1 };

function el() {
  return {
    root: $('#cam'), video: $('#camVideo'), photo: $('#camPhoto'), frame: $('#camFrame'),
    stage: $('#camStage'), status: $('#camStatus'), live: $('#camLive'),
    result: $('#camResult'), shutter: $('#camShutter'),
  };
}

function setStatus(text, kind = '') {
  const s = el().status;
  s.textContent = text;
  s.className = `cam-status ${kind}`;
}

/** 對準框在來源影像（影片或照片）中的座標 */
function frameRectInSource() {
  const { video, photo, frame } = el();
  const fr = frame.getBoundingClientRect();
  if (mode === 'video') {
    const vw = video.videoWidth; const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const er = video.getBoundingClientRect();
    // object-fit: cover
    const s = Math.max(er.width / vw, er.height / vh);
    const cw = vw * s; const ch = vh * s;
    const cx = er.left + (er.width - cw) / 2; const cy = er.top + (er.height - ch) / 2;
    return clampRect({ x: (fr.left - cx) / s, y: (fr.top - cy) / s, w: fr.width / s, h: fr.height / s }, vw, vh);
  }
  if (!photoImg) return null;
  const pr = photo.getBoundingClientRect(); // 包含 CSS transform
  const s = pr.width / photoImg.naturalWidth;
  return clampRect({ x: (fr.left - pr.left) / s, y: (fr.top - pr.top) / s, w: fr.width / s, h: fr.height / s },
    photoImg.naturalWidth, photoImg.naturalHeight);
}

function clampRect(r, W, H) {
  const x = Math.max(0, r.x); const y = Math.max(0, r.y);
  const w = Math.min(W, r.x + r.w) - x; const h = Math.min(H, r.y + r.h) - y;
  return w > 20 && h > 20 ? { x, y, w, h } : null;
}

function expand(r, k, W, H) {
  return clampRect({ x: r.x - r.w * k / 2, y: r.y - r.h * k / 2, w: r.w * (1 + k), h: r.h * (1 + k) }, W, H) || r;
}

function sourceSize() {
  const { video } = el();
  return mode === 'video' ? [video.videoWidth, video.videoHeight] : [photoImg.naturalWidth, photoImg.naturalHeight];
}

/** 用幾種裁切範圍辨識，取分數最高的結果 */
function analyze(src, rect, tries = [0, 0.15, -0.1]) {
  const [W, H] = sourceSize();
  let best = null;
  for (const k of tries) {
    const r = k ? expand(rect, k, W, H) : rect;
    const res = recognize(src, r, work);
    if (res.reading && (!best || res.reading.score > best.reading.score)) best = { ...res, rect: r };
    if (best && best.reading.pulse !== null && best.reading.conf > 0.95) break;
  }
  return best;
}

const key = (r) => `${r.sys}/${r.dia}/${r.pulse}`;

function showLive(reading) {
  const { live } = el();
  if (!reading) { live.innerHTML = ''; return; }
  live.innerHTML = `
    <span><small>收縮壓</small><b>${reading.sys}</b></span>
    <span><small>舒張壓</small><b>${reading.dia}</b></span>
    <span><small>脈搏</small><b>${reading.pulse ?? '–'}</b></span>`;
}

function tick() {
  if (busy || mode !== 'video') return;
  const { video } = el();
  const rect = frameRectInSource();
  if (!rect || video.readyState < 2) return;
  // 每次輪流用一種裁切，保持流暢
  const k = [0, 0.15, -0.1][history.length % 3];
  const [W, H] = sourceSize();
  const res = recognize(video, k ? expand(rect, k, W, H) : rect, work);
  const reading = res.reading && res.reading.pulse !== null ? res.reading : null;
  history.push(reading ? key(reading) : null);
  if (history.length > 4) history.shift();
  showLive(reading);
  if (!reading) {
    setStatus('把三排數字放進框內，保持穩定');
    return;
  }
  setStatus('辨識中…請保持不動', 'ok');
  // 連續兩次得到相同結果就自動完成
  const n = history.filter((h) => h === key(reading)).length;
  if (n >= 2) freeze(video, { ...res, rect: k ? expand(rect, k, W, H) : rect });
}

/** 定格畫面並顯示辨識結果 */
function freeze(src, res) {
  busy = true;
  clearInterval(timer);
  const { result, video } = el();
  // 擷取對準框內的影像作為縮圖
  const r = res.rect;
  const snap = document.createElement('canvas');
  const scale = Math.min(1, 640 / r.w);
  snap.width = Math.round(r.w * scale); snap.height = Math.round(r.h * scale);
  const sctx = snap.getContext('2d');
  sctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, snap.width, snap.height);
  // 把辨識到的數字框畫出來
  const k = snap.width / res.w;
  sctx.lineWidth = Math.max(2, snap.width / 160);
  const colors = ['#3987e5', '#eb6834', '#e0453f'];
  res.reading.rows.forEach((row, i) => {
    sctx.strokeStyle = colors[i];
    for (const d of row.digits) sctx.strokeRect(d.x0 * k - 2, d.y0 * k - 2, (d.x1 - d.x0 + 1) * k + 4, (d.y1 - d.y0 + 1) * k + 4);
  });
  if (mode === 'video') video.pause();
  const reading = res.reading;
  result.hidden = false;
  result.innerHTML = `
    <img src="${snap.toDataURL('image/jpeg', 0.85)}" alt="辨識範圍">
    <div class="cam-values">
      <span class="v sys"><small>收縮壓</small><b>${reading.sys}</b></span>
      <span class="v dia"><small>舒張壓</small><b>${reading.dia}</b></span>
      <span class="v pulse"><small>脈搏</small><b>${reading.pulse ?? '–'}</b></span>
    </div>
    <p class="cam-check">請對照血壓計確認數字是否正確</p>
    <div class="cam-actions">
      <button type="button" class="cam-btn ghost" data-act="retry">重新拍攝</button>
      <button type="button" class="cam-btn primary" data-act="use">使用這組數字</button>
    </div>`;
  result.dataset.reading = JSON.stringify({ sys: reading.sys, dia: reading.dia, pulse: reading.pulse });
  setStatus('辨識完成', 'ok');
  if (navigator.vibrate) navigator.vibrate(40);
}

function resume() {
  const { result, video } = el();
  result.hidden = true;
  busy = false;
  history = [];
  showLive(null);
  if (mode === 'video') {
    video.play().catch(() => {});
    timer = setInterval(tick, 280);
    setStatus('把三排數字放進框內，保持穩定');
  } else {
    setStatus('拖曳、縮放照片讓數字在框內，再按「辨識」');
  }
}

/** 按下快門：直接用目前畫面辨識 */
function shoot() {
  if (busy) return;
  const { video, photo } = el();
  const rect = frameRectInSource();
  if (!rect) return;
  const src = mode === 'video' ? video : photoImg;
  const res = analyze(src, rect, [0, 0.15, -0.1, 0.35]);
  if (res && res.reading) {
    freeze(src, res);
  } else {
    setStatus('沒有辨識到數字：請靠近一點、避免反光，或改用手動輸入', 'err');
    photo.classList.add('shake');
    setTimeout(() => photo.classList.remove('shake'), 400);
  }
}

async function startVideo() {
  const { video, root } = el();
  mode = 'video';
  root.classList.remove('photo-mode');
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('這個瀏覽器無法直接開啟相機，請改用「相簿」選擇照片', 'err');
    root.classList.add('no-camera');
    return;
  }
  try {
    setStatus('正在開啟相機…');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play();
    root.classList.remove('no-camera');
    resume();
  } catch (e) {
    root.classList.add('no-camera');
    setStatus(e && e.name === 'NotAllowedError'
      ? '沒有相機權限：請在設定中允許使用相機，或改用「相簿」選擇照片'
      : '無法開啟相機，請改用「相簿」選擇照片', 'err');
  }
}

function stopVideo() {
  clearInterval(timer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  const { video } = el();
  video.srcObject = null;
}

/* ---------- 照片模式 ---------- */
function applyView() {
  el().photo.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
}

async function usePhoto(file) {
  const { photo, root } = el();
  stopVideo();
  mode = 'photo';
  root.classList.add('photo-mode');
  busy = false;
  el().result.hidden = true;
  setStatus('辨識照片中…');
  const url = URL.createObjectURL(file);
  photo.src = url;
  await photo.decode().catch(() => {});
  photoImg = photo;
  // 先讓整張照片塞進對準框
  fitPhoto();
  await new Promise((r) => requestAnimationFrame(r));
  // 先試整張照片、再試目前框內
  const full = { x: 0, y: 0, w: photo.naturalWidth, h: photo.naturalHeight };
  let res = analyze(photo, full, [0]);
  if (!res) res = analyze(photo, frameRectInSource() || full);
  if (!res) {
    // 再試中間區域（血壓計螢幕通常在照片中央）
    const c = { x: full.w * 0.15, y: full.h * 0.2, w: full.w * 0.7, h: full.h * 0.6 };
    res = analyze(photo, c);
  }
  if (res && res.reading) freeze(photo, res);
  else setStatus('沒有自動找到數字：拖曳、縮放照片讓三排數字在框內，再按「辨識」', 'err');
}

function fitPhoto() {
  const { photo, frame, stage } = el();
  const fr = frame.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const s = Math.min(fr.width / photo.naturalWidth, fr.height / photo.naturalHeight);
  view.s = s;
  view.x = fr.left - sr.left + (fr.width - photo.naturalWidth * s) / 2;
  view.y = fr.top - sr.top + (fr.height - photo.naturalHeight * s) / 2;
  applyView();
}

function bindPanZoom() {
  const { stage } = el();
  const pts = new Map();
  let last = null;
  const state = () => {
    const arr = [...pts.values()];
    if (arr.length === 1) return { cx: arr[0].x, cy: arr[0].y, d: 0 };
    const [a, b] = arr;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'photo' || busy) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last = state();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = state();
    const sr = stage.getBoundingClientRect();
    if (last.d && cur.d) {
      const k = cur.d / last.d;
      const px = cur.cx - sr.left; const py = cur.cy - sr.top;
      view.x = px - (px - view.x) * k; view.y = py - (py - view.y) * k; view.s *= k;
    }
    view.x += cur.cx - last.cx; view.y += cur.cy - last.cy;
    last = cur;
    applyView();
  });
  const up = (e) => { pts.delete(e.pointerId); last = pts.size ? state() : null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    if (mode !== 'photo' || busy) return;
    e.preventDefault();
    const sr = stage.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * 0.0015);
    const px = e.clientX - sr.left; const py = e.clientY - sr.top;
    view.x = px - (px - view.x) * k; view.y = py - (py - view.y) * k; view.s *= k;
    applyView();
  }, { passive: false });
}

/* ---------- 對外介面 ---------- */
let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  const { root } = el();
  bindPanZoom();
  $('#camClose').addEventListener('click', () => closeCamera());
  $('#camShutter').addEventListener('click', shoot);
  $('#camManual').addEventListener('click', () => closeCamera({ manual: true }));
  $('#camFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) usePhoto(f);
  });
  $('#camBackToVideo').addEventListener('click', () => { photoImg = null; startVideo(); });
  el().result.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'retry') resume();
    if (b.dataset.act === 'use') {
      const r = JSON.parse(el().result.dataset.reading);
      closeCamera({ reading: r });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !root.hidden && mode === 'video') stopVideo();
    else if (!document.hidden && !root.hidden && mode === 'video' && !stream && !busy) startVideo();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) closeCamera(); });
}

/**
 * 開啟相機
 * @param {(r: {reading?:{sys,dia,pulse}, manual?:boolean}|null)=>void} cb
 */
export function openCamera(cb) {
  bind();
  onResult = cb;
  const { root, result, live } = el();
  root.hidden = false;
  result.hidden = true;
  live.innerHTML = '';
  busy = false;
  history = [];
  document.body.classList.add('cam-open');
  requestAnimationFrame(() => root.classList.add('show'));
  startVideo();
}

export function closeCamera(out = null) {
  const { root, photo } = el();
  stopVideo();
  root.classList.remove('show', 'photo-mode', 'no-camera');
  document.body.classList.remove('cam-open');
  setTimeout(() => { root.hidden = true; }, 200);
  if (photo.src.startsWith('blob:')) URL.revokeObjectURL(photo.src);
  photo.removeAttribute('src');
  photoImg = null;
  mode = 'video';
  const cb = onResult;
  onResult = null;
  if (cb) cb(out);
}
