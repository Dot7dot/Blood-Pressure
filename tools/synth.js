// 合成「血壓計液晶螢幕」影像，用來產生數字辨識模型的訓練資料
// （在瀏覽器中執行，由 tools/build-dataset.js 透過 Playwright 呼叫）
import { toWorkGray, allCandidates, REJECT } from '../js/ocr.js';

/* ---------- 亂數 ---------- */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const r = (a = 0, b = 1) => a + (b - a) * next();
  r.int = (a, b) => Math.floor(r(a, b + 1));
  r.pick = (arr) => arr[Math.floor(next() * arr.length)];
  r.chance = (p) => next() < p;
  r.gauss = () => {
    const u = Math.max(1e-9, next()); const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return r;
}

/* ---------- 七段顯示器 ---------- */
//   aaa
//  f   b
//   ggg
//  e   c
//   ddd
const SEG = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};
const VARIANTS = { 6: ['afgedc', 'fgedc'], 7: ['abc', 'abcf'], 9: ['abcdfg', 'abcfg'] };

/** 每一段的多邊形（數字格座標：寬 1、高 2 的比例，再乘上尺寸） */
function segmentPolys(w, h, t, gap, style) {
  const half = t / 2;
  const hz = (x0, x1, y) => (style === 'rect'
    ? [[x0 + gap, y - half], [x1 - gap, y - half], [x1 - gap, y + half], [x0 + gap, y + half]]
    : [[x0 + gap, y], [x0 + gap + half, y - half], [x1 - gap - half, y - half], [x1 - gap, y], [x1 - gap - half, y + half], [x0 + gap + half, y + half]]);
  const vt = (x, y0, y1) => (style === 'rect'
    ? [[x - half, y0 + gap], [x + half, y0 + gap], [x + half, y1 - gap], [x - half, y1 - gap]]
    : [[x, y0 + gap], [x + half, y0 + gap + half], [x + half, y1 - gap - half], [x, y1 - gap], [x - half, y1 - gap - half], [x - half, y0 + gap + half]]);
  const L = half; const R = w - half; const T = half; const M = h / 2; const B = h - half;
  return {
    a: hz(L, R, T), g: hz(L, R, M), d: hz(L, R, B),
    f: vt(L, T, M), b: vt(R, T, M), e: vt(L, M, B), c: vt(R, M, B),
  };
}

function drawPoly(ctx, pts, tf) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const [X, Y] = tf(x, y);
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
}

/**
 * 畫一個數字，回傳實際筆畫外框（畫布座標）
 * narrowOne：只有右側兩段的「半格 1」（血壓計百位數常見）
 */
function drawDigit(ctx, rng, d, x, y, w, h, st) {
  let segs = SEG[d];
  if (VARIANTS[d]) segs = rng.chance(0.75) ? VARIANTS[d][0] : VARIANTS[d][1];
  const polys = segmentPolys(w, h, st.t, st.gap, st.style);
  const shear = st.slant;
  const tf = (px, py) => [x + px + shear * (h - py), y + py];
  // 未亮的段（液晶殘影）
  if (st.ghost > 0) {
    ctx.fillStyle = `rgba(${st.ink},${st.ink},${st.ink},${st.ghost})`;
    for (const k of 'abcdefg') if (!segs.includes(k)) drawPoly(ctx, polys[k], tf);
  }
  ctx.fillStyle = `rgba(${st.ink},${st.ink},${st.ink},${st.alpha})`;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const k of segs) {
    drawPoly(ctx, polys[k], tf);
    for (const [px, py] of polys[k]) {
      const [X, Y] = tf(px, py);
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
  }
  return { x0, y0, x1, y1, label: d };
}

function drawNumber(ctx, rng, value, right, top, h, st, gt, opts = {}) {
  const w = h * st.wRatio;
  const pitch = w * st.pitch;
  const s = String(value);
  let x = right - w;
  for (let i = s.length - 1; i >= 0; i--) {
    const d = Number(s[i]);
    const narrow = i === 0 && s.length === 3 && d === 1 && opts.narrowHundreds;
    if (narrow) {
      // 只有右邊兩段的窄「1」
      const box = drawDigit(ctx, rng, 1, x + w - pitch * 0.15 - w, top, w, h, { ...st, ghost: 0 });
      gt.push(box);
    } else {
      gt.push(drawDigit(ctx, rng, d, x, top, w, h, st));
    }
    x -= pitch;
  }
}

const KANJI = '最高血圧低脈拍測定完了月日時分体動不規則平均値記録朝夜収縮拡張圧力単位設定電池交換確認注意'.split('');
const LATIN = 'AEFHKMNPRTUVWXYmmHg'.split('');

function drawText(ctx, rng, x, y, size, ink, n) {
  ctx.fillStyle = `rgba(${ink},${ink},${ink},${rng(0.6, 1)})`;
  ctx.font = `${rng.pick(['400', '700'])} ${size}px sans-serif`;
  let s = '';
  for (let i = 0; i < n; i++) s += rng.chance(0.7) ? rng.pick(KANJI) : rng.pick(LATIN);
  ctx.fillText(s, x, y);
}

function drawIcon(ctx, rng, x, y, size, ink) {
  ctx.strokeStyle = `rgb(${ink},${ink},${ink})`;
  ctx.fillStyle = `rgb(${ink},${ink},${ink})`;
  ctx.lineWidth = Math.max(1, size * rng(0.06, 0.12));
  const k = rng.int(0, 4);
  ctx.beginPath();
  if (k === 0) { ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.stroke(); }
  else if (k === 1) { // 人形
    ctx.arc(x, y - size * 0.3, size * 0.18, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - size * 0.3, y + size * 0.5); ctx.lineTo(x - size * 0.25, y); ctx.lineTo(x + size * 0.25, y); ctx.lineTo(x + size * 0.3, y + size * 0.5); ctx.closePath(); ctx.stroke();
  } else if (k === 2) { // 愛心
    ctx.moveTo(x, y + size * 0.4); ctx.bezierCurveTo(x - size * 0.7, y - size * 0.1, x - size * 0.2, y - size * 0.6, x, y - size * 0.2);
    ctx.bezierCurveTo(x + size * 0.2, y - size * 0.6, x + size * 0.7, y - size * 0.1, x, y + size * 0.4); ctx.fill();
  } else if (k === 3) { ctx.strokeRect(x - size / 2, y - size / 3, size, size * 0.66); }
  else { ctx.moveTo(x - size / 2, y); ctx.lineTo(x + size / 2, y); ctx.stroke(); } // 破折號
}

/**
 * 產生一張合成場景
 * @returns {{canvas: HTMLCanvasElement, gt: {x0,y0,x1,y1,label}[], reading:{sys,dia,pulse}}}
 */
export function renderScene(rng, canvas = document.createElement('canvas')) {
  const W = rng.int(360, 720);
  const H = Math.round(W * rng(0.75, 1.5));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';

  // 底色：液晶灰綠色 + 漸層
  const base = [rng(150, 220), rng(160, 225), rng(150, 215)];
  const tint = rng(-30, 30);
  const g = ctx.createLinearGradient(rng(0, W), 0, rng(0, W), H);
  const c = (k) => `rgb(${base.map((v) => Math.max(0, Math.min(255, v + k))).join(',')})`;
  g.addColorStop(0, c(tint)); g.addColorStop(1, c(-tint));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 螢幕外框（有時候框到外面）
  if (rng.chance(0.6)) {
    const m = rng(-0.02, 0.08) * W;
    ctx.strokeStyle = `rgb(${rng.int(40, 110)},${rng.int(40, 110)},${rng.int(40, 110)})`;
    ctx.lineWidth = rng(4, 30);
    ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
  }

  // 整體變形（傾斜、旋轉、縮放）
  const rot = rng(-0.07, 0.07);
  const sx = rng(0.85, 1.12);
  const shy = rng(-0.05, 0.05);
  ctx.translate(W / 2, H / 2);
  ctx.transform(sx * Math.cos(rot), Math.sin(rot) + shy, -Math.sin(rot), Math.cos(rot), 0, 0);
  ctx.translate(-W / 2, -H / 2);
  const M = ctx.getTransform();

  const ink = rng.int(10, 90);
  const st = {
    ink,
    alpha: rng(0.75, 1),
    ghost: rng.chance(0.4) ? rng(0.02, 0.14) : 0,
    t: 0, gap: 0,
    style: rng.chance(0.7) ? 'hex' : 'rect',
    slant: rng.chance(0.5) ? rng(0, 0.12) : rng(-0.02, 0.02),
    wRatio: rng(0.42, 0.62),
    pitch: rng(1.2, 1.5),
  };

  // 三列數字
  const sys = rng.chance(0.75) ? rng.int(95, 199) : rng.int(60, 260);
  let dia = rng.chance(0.8) ? rng.int(50, 109) : rng.int(30, 160);
  if (dia > sys - 10) dia = Math.max(30, sys - rng.int(10, 60));
  const pulse = rng.chance(0.85) ? rng.int(48, 110) : rng.int(30, 199);
  const h1 = H * rng(0.17, 0.3);
  const h2 = h1 * rng(0.88, 1.08);
  const h3 = h1 * rng(0.4, 0.72);
  const gap12 = h1 * rng(0.07, 0.35);
  const gap23 = h1 * rng(0.07, 0.35);
  const total = h1 + gap12 + h2 + gap23 + h3;
  const top = rng(0.06, Math.max(0.07, 0.94 - total / H)) * H;
  const right = W * rng(0.7, 0.96);
  const gt = [];
  const thick = rng(0.1, 0.19);
  const gapR = rng(0.005, 0.04);
  const narrowHundreds = rng.chance(0.6);
  const rowsY = [top, top + h1 + gap12, top + h1 + gap12 + h2 + gap23];
  [[sys, h1], [dia, h2], [pulse, h3]].forEach(([v, h], i) => {
    const t = h * thick;
    const r2 = i === 2 && rng.chance(0.5) ? right - rng(0, 0.1) * W : right;
    drawNumber(ctx, rng, v, r2, rowsY[i], h, { ...st, t, gap: h * gapR }, gt, { narrowHundreds });
  });

  // 干擾物：左側文字標籤、圖示、小字
  const leftMax = right - Math.max(h1 * st.wRatio * st.pitch * 3, W * 0.35);
  if (rng.chance(0.6)) {
    for (let i = 0; i < 3; i++) {
      const size = h3 * rng(0.25, 0.6);
      drawText(ctx, rng, rng(0, Math.max(1, leftMax - size * 4)), rowsY[i] + h1 * rng(0.2, 0.6), size, ink, rng.int(1, 4));
    }
  }
  if (rng.chance(0.4)) drawIcon(ctx, rng, rng(0.05, 0.3) * W, rng(0.05, 0.2) * H, h3 * rng(0.4, 0.9), ink);
  if (rng.chance(0.4)) drawText(ctx, rng, rng(0.3, 0.6) * W, top * rng(0.3, 0.9) + 10, h3 * rng(0.2, 0.4), ink, rng.int(3, 8));
  if (rng.chance(0.25)) {
    // 數字大小的干擾字（訓練「不是數字」）
    const size = h1 * rng(0.6, 1);
    drawText(ctx, rng, rng(0, Math.max(1, leftMax - size)), rowsY[rng.int(0, 1)] + size * 0.9, size, ink, 1);
  }
  if (rng.chance(0.3)) {
    // 小型時間/日期數字（也是數字）
    const hs = h3 * rng(0.3, 0.5);
    const v = rng.int(1, 59);
    drawNumber(ctx, rng, v, rng(0.5, 0.95) * W, Math.max(2, top - hs * rng(1.3, 2.2)), hs, { ...st, t: hs * thick, gap: hs * gapR }, gt, {});
  }

  // 套用變形到外框
  const mapPt = (x, y) => [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f];
  const gtT = gt.map((b) => {
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => mapPt(x, y));
    return {
      x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
      label: b.label,
    };
  });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 反光
  const glare = rng.int(0, 3);
  for (let i = 0; i < glare; i++) {
    ctx.save();
    ctx.filter = `blur(${rng(2, 14)}px)`;
    ctx.strokeStyle = `rgba(255,255,255,${rng(0.2, 0.75)})`;
    ctx.lineWidth = rng(3, 40);
    ctx.beginPath();
    const x = rng(0, W);
    ctx.moveTo(x, rng(0, H)); ctx.lineTo(x + rng(-W, W) * 0.6, rng(0, H));
    ctx.stroke();
    ctx.restore();
  }
  // 陰影
  if (rng.chance(0.35)) {
    const sg = ctx.createLinearGradient(rng(0, W), rng(0, H), rng(0, W), rng(0, H));
    sg.addColorStop(0, `rgba(0,0,0,${rng(0.1, 0.45)})`); sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
  }

  let out = { canvas, gt: gtT, reading: { sys, dia, pulse } };
  if (rng.chance(0.3)) out = placeInDevice(rng, out);
  finalize(rng, out.canvas);
  return out;
}

const BRAND = ['OMRON', 'MICROLIFE', 'ROSSMAX', 'TERUMO', 'HEALTH', 'BP', 'START', 'STOP', 'MEMORY', 'SET'];

/** 把液晶螢幕放進一台「血壓計」裡（外殼、按鈕、品牌字），模擬拍整台機器的照片 */
function placeInDevice(rng, { canvas: lcd, gt, reading }) {
  const k = rng(0.35, 0.7);
  const W = Math.round(lcd.width / k);
  const H = Math.round(W * rng(0.9, 1.45));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const body = rng.int(195, 245);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `rgb(${body},${body - rng.int(0, 15)},${body - rng.int(0, 25)})`);
  g.addColorStop(1, `rgb(${body - 30},${body - 35},${body - 40})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 上方的壓脈帶或桌面等深色區塊
  if (rng.chance(0.6)) {
    const d = rng.int(15, 70);
    ctx.fillStyle = `rgb(${d},${d},${d + rng.int(0, 20)})`;
    ctx.fillRect(rng(-0.1, 0.2) * W, -10, W * rng(0.6, 1.1), H * rng(0.08, 0.25));
  }
  const ox = rng(0.03, Math.max(0.04, 0.97 - lcd.width / W)) * W;
  const oy = rng(0.15, Math.max(0.16, 0.95 - lcd.height / H)) * H;
  // 銀色邊框
  const bez = rng(4, 28);
  ctx.fillStyle = `rgb(${rng.int(140, 200)},${rng.int(140, 200)},${rng.int(140, 205)})`;
  ctx.beginPath();
  ctx.roundRect(ox - bez, oy - bez, lcd.width + 2 * bez, lcd.height + 2 * bez, bez);
  ctx.fill();
  ctx.drawImage(lcd, ox, oy);
  // 按鈕與品牌字
  const right = ox + lcd.width + bez * 2;
  const ink = rng.int(40, 100);
  ctx.fillStyle = `rgb(${ink},${ink},${ink})`;
  ctx.font = `700 ${Math.round(lcd.height * rng(0.05, 0.1))}px sans-serif`;
  ctx.fillText(rng.pick(BRAND), Math.min(right + 8, W - 60), oy + rng(0, 0.1) * lcd.height + 20);
  for (let i = 0; i < rng.int(1, 4); i++) {
    const bw = lcd.width * rng(0.12, 0.3);
    ctx.strokeStyle = `rgb(${ink},${ink},${ink})`;
    ctx.lineWidth = rng(1, 4);
    ctx.beginPath();
    ctx.roundRect(rng(right, Math.max(right + 1, W - bw)), oy + rng(0.2, 0.9) * lcd.height, bw, bw * 0.6, bw * 0.2);
    ctx.stroke();
  }
  return {
    canvas: c,
    gt: gt.map((b) => ({ ...b, x0: b.x0 + ox, x1: b.x1 + ox, y0: b.y0 + oy, y1: b.y1 + oy })),
    reading,
  };
}

/** 模糊、對比、雜訊 */
function finalize(rng, canvas) {
  const W = canvas.width; const H = canvas.height;
  const ctx = canvas.getContext('2d');
  const blur = rng.chance(0.7) ? rng(0, 2.2) : rng(2.2, 3.5);
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.filter = blur > 0.2 ? `blur(${blur * W / 500}px)` : 'none';
  tctx.drawImage(canvas, 0, 0);
  const id = tctx.getImageData(0, 0, W, H);
  const noise = rng(0, 14);
  const contrast = rng(0.55, 1.15);
  const bright = rng(-25, 25);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = noise * rng.gauss();
    for (let k = 0; k < 3; k++) {
      id.data[i + k] = Math.max(0, Math.min(255, (id.data[i + k] - 128) * contrast + 128 + bright + n));
    }
  }
  ctx.putImageData(id, 0, 0);
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

/**
 * 產生一批訓練樣本
 * @returns {{X: Uint8Array, y: Uint8Array, n: number}}
 */
export function makeBatch(seed, scenes) {
  const rng = makeRng(seed);
  const xs = [];
  const ys = [];
  const canvas = document.createElement('canvas');
  const work = document.createElement('canvas');
  for (let s = 0; s < scenes; s++) {
    const scene = renderScene(rng, canvas);
    const { gt } = scene;
    // 「整台機器」模式會回傳另一張比較大的畫布
    const { g, w, h, scale } = toWorkGray(scene.canvas, null, work);
    const gtW = gt.map((b) => ({ x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale, label: b.label }));
    const { cands } = allCandidates(g, w, h);
    for (const c of cands) {
      const box = { x0: c.x0, y0: c.y0, x1: c.x1 + 1, y1: c.y1 + 1 };
      let best = 0; let lab = -1;
      for (const b of gtW) {
        const v = iou(box, b);
        if (v > best) { best = v; lab = b.label; }
      }
      let y;
      if (best > 0.6) y = lab;
      else if (best < 0.25) y = REJECT;
      else continue; // 模稜兩可的不要
      xs.push(c.x); ys.push(y);
    }
  }
  const D = xs.length ? xs[0].length : 0;
  const X = new Uint8Array(xs.length * D);
  xs.forEach((x, i) => { for (let j = 0; j < D; j++) X[i * D + j] = Math.round(Math.min(1, x[j] / 1.5 * (j === D - 1 ? 1 : 1.5)) * 255); });
  return { X, y: Uint8Array.from(ys), n: xs.length, D };
}
