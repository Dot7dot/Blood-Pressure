// 輕量 SVG 折線圖（含十字準線與提示框），不依賴外部函式庫
const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;

function s(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  return steps.find((v) => v >= raw) || 100;
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   series: {name:string,color:string,points:{x:number,y:number}[]}[],
 *   x0:number, x1:number,
 *   refs?: {y:number,label:string}[],
 *   fmtX: (ms:number)=>string,
 *   tooltip: (ms:number)=>string,
 *   empty?: string,
 * }} o
 */
export function renderChart(el, o) {
  el.innerHTML = '';
  const W = el.clientWidth;
  const H = el.clientHeight;
  const pts = o.series.flatMap((sr) => sr.points);
  if (!pts.length || W < 50) {
    const box = document.createElement('div');
    box.className = 'chart-empty';
    box.innerHTML = o.empty || '這段期間沒有資料';
    el.appendChild(box);
    return;
  }

  const m = { l: 34, r: 36, t: 16, b: 26 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  // ---- y 軸 ----
  const refs = (o.refs || []);
  const ys = pts.map((p) => p.y);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  for (const r of refs) {
    // 參考線距離資料不遠時才納入範圍，避免把資料擠扁
    if (r.y >= lo - 25 && r.y <= hi + 25) { lo = Math.min(lo, r.y); hi = Math.max(hi, r.y); }
  }
  const span = Math.max(hi - lo, 10);
  lo -= span * 0.12;
  hi += span * 0.12;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const yPx = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  // ---- x 軸（以「天」為單位） ----
  const N = Math.max(1, Math.round((o.x1 - o.x0) / DAY) + 1);
  const idxOf = (ms) => Math.round((ms - o.x0) / DAY);
  const xPx = (idx) => (N === 1 ? m.l + iw / 2 : m.l + (idx / (N - 1)) * iw);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '血壓趨勢圖' }, el);

  // 格線 + y 標籤
  const grid = s('g', { class: 'grid' }, svg);
  const yAxis = s('g', { class: 'axis' }, svg);
  for (let v = lo; v <= hi + 1e-6; v += step) {
    const y = yPx(v);
    s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y }, grid);
    const t = s('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, yAxis);
    t.textContent = String(v);
  }

  // x 標籤
  const xAxis = s('g', { class: 'axis' }, svg);
  const tickIdx = [];
  if (N <= 8) {
    for (let i = 0; i < N; i++) tickIdx.push(i);
  } else {
    const stp = Math.ceil((N - 1) / 4);
    for (let i = N - 1; i >= 0; i -= stp) tickIdx.unshift(i);
    if (tickIdx[0] !== 0 && tickIdx[0] * (iw / (N - 1)) > 34) tickIdx.unshift(0);
  }
  for (const i of tickIdx) {
    const t = s('text', { x: xPx(i), y: H - 6, 'text-anchor': 'middle' }, xAxis);
    t.textContent = o.fmtX(o.x0 + i * DAY);
  }

  // 參考線
  const refG = s('g', { class: 'ref' }, svg);
  for (const r of refs) {
    if (r.y < lo || r.y > hi) continue;
    const y = yPx(r.y);
    s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y }, refG);
    // 目標值標在 y 軸上；若剛好與刻度重疊就不重複標示
    const nearTick = Math.abs(((r.y - lo) / step) - Math.round((r.y - lo) / step)) < 0.35;
    if (!nearTick) {
      const t = s('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, refG);
      t.textContent = r.label;
    }
  }

  // 資料線
  const single = o.series.length === 1;
  const showMarkers = pts.length / o.series.length <= 45;
  const allIdx = new Set();
  const seriesPx = o.series.map((sr) => {
    const list = sr.points
      .map((p) => ({ i: idxOf(p.x), y: p.y, px: xPx(idxOf(p.x)), py: yPx(p.y) }))
      .sort((a, b) => a.i - b.i);
    list.forEach((p) => allIdx.add(p.i));
    return { sr, list };
  });

  for (const { sr, list } of seriesPx) {
    if (!list.length) continue;
    const g = s('g', { class: 'series' }, svg);
    const d = list.map((p, k) => `${k ? 'L' : 'M'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join('');
    if (single && list.length > 1) {
      const base = m.t + ih;
      s('path', {
        class: 'area', style: `fill:${sr.color}`,
        d: `${d}L${list[list.length - 1].px.toFixed(1)},${base}L${list[0].px.toFixed(1)},${base}Z`,
      }, g);
    }
    s('path', { class: 'line', d, style: `stroke:${sr.color}` }, g);
    if (showMarkers || list.length === 1) {
      for (const p of list) s('circle', { cx: p.px, cy: p.py, r: 3.5, style: `fill:${sr.color}` }, g);
    }
    const last = list[list.length - 1];
    s('circle', { cx: last.px, cy: last.py, r: 5, style: `fill:${sr.color}` }, g);
    const lbl = s('text', { class: 'end-label', x: last.px + 8, y: last.py + 4 }, g);
    if (last.px + 8 + 28 > W) { lbl.setAttribute('x', last.px - 8); lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('y', last.py - 10); }
    lbl.textContent = String(Math.round(last.y));
  }

  // ---- 互動：十字準線 + 提示框 ----
  const sorted = Array.from(allIdx).sort((a, b) => a - b);
  const hover = s('g', { style: 'display:none' }, svg);
  const cross = s('line', { class: 'crosshair', y1: m.t, y2: m.t + ih }, hover);
  const dots = o.series.map((sr) => s('circle', { class: 'hover-dot', r: 6, style: `fill:${sr.color}` }, hover));
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.style.display = 'none';
  el.appendChild(tip);

  const overlay = s('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' }, svg);

  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left;
    const raw = N === 1 ? 0 : ((x - m.l) / iw) * (N - 1);
    let best = sorted[0];
    for (const i of sorted) if (Math.abs(i - raw) < Math.abs(best - raw)) best = i;
    const px = xPx(best);
    hover.style.display = '';
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    seriesPx.forEach(({ list }, k) => {
      const p = list.find((q) => q.i === best);
      if (p) { dots[k].style.display = ''; dots[k].setAttribute('cx', px); dots[k].setAttribute('cy', p.py); }
      else dots[k].style.display = 'none';
    });
    tip.innerHTML = o.tooltip(o.x0 + best * DAY);
    tip.style.display = '';
    const tw = tip.offsetWidth;
    const left = Math.max(tw / 2, Math.min(W - tw / 2, px));
    tip.style.left = `${left}px`;
    // 盡量不要擋住資料點：點在上半部時把提示框放到下方
    const topPts = seriesPx.map(({ list }) => list.find((q) => q.i === best)).filter(Boolean);
    const minY = Math.min(...topPts.map((p) => p.py));
    const th = tip.offsetHeight;
    tip.style.top = `${minY - th - 14 > 0 ? minY - th - 14 : Math.min(H - th, Math.max(...topPts.map((p) => p.py)) + 14)}px`;
  };
  const hide = () => { hover.style.display = 'none'; tip.style.display = 'none'; };

  overlay.addEventListener('pointermove', (e) => show(e.clientX));
  overlay.addEventListener('pointerdown', (e) => show(e.clientX));
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('pointercancel', hide);
}
