// 血壓計液晶螢幕（七段顯示器）數字辨識
//
// 流程：
//   1. 影像縮小 → 灰階 → Sauvola 自適應二值化（可抵抗反光與陰影）
//   2. 連通區塊 → 把同一個數字的多個筆畫合併成「數字候選框」
//   3. 依高度與位置把候選框分成「列」，挑出 收縮壓 / 舒張壓 / 脈搏 三列
//   4. 每個候選框正規化成 16×24 的小圖，交給一個很小的神經網路（MLP）判斷 0–9
//
// 全部在瀏覽器端執行，不需要上傳照片。
import { MODEL } from './digit-model.js';

export const IN_W = 16;
export const IN_H = 24;
export const INPUT_SIZE = IN_W * IN_H + 1; // +1：寬高比特徵
export const REJECT = 10; // 第 11 類：不是數字

const WORK_W = 320;

/* ---------------- 模型 ---------------- */
function decodeLayer(layer) {
  const bin = atob(layer.w);
  const q = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24;
  const W = new Float32Array(q.length);
  // 每個輸出神經元一個縮放係數（int8 量化）
  for (let o = 0; o < layer.out; o++) {
    const s = layer.scale[o];
    for (let i = 0; i < layer.in; i++) W[o * layer.in + i] = q[o * layer.in + i] * s;
  }
  return { W, b: Float32Array.from(layer.b), nIn: layer.in, nOut: layer.out };
}

let layers = null;
function getLayers() {
  if (!layers) layers = MODEL.layers.map(decodeLayer);
  return layers;
}

/** 回傳每一類的機率 */
export function classifyDigit(x) {
  let a = x;
  const L = getLayers();
  L.forEach((l, k) => {
    const out = new Float32Array(l.nOut);
    for (let o = 0; o < l.nOut; o++) {
      let s = l.b[o];
      const row = o * l.nIn;
      for (let i = 0; i < l.nIn; i++) s += l.W[row + i] * a[i];
      out[o] = k < L.length - 1 ? Math.max(0, s) : s;
    }
    a = out;
  });
  const m = Math.max(...a);
  let sum = 0;
  const p = a.map((v) => { const e = Math.exp(v - m); sum += e; return e; });
  return p.map((v) => v / sum);
}

/* ---------------- 影像前處理 ---------------- */
export function toGray(imgData) {
  const { data, width, height } = imgData;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return g;
}

/** Sauvola 自適應二值化：深色（數字）= 1 */
export function binarize(g, w, h, opts = {}) {
  const r = opts.radius || Math.max(8, Math.round(Math.min(w, h) / 7));
  const k = opts.k ?? 0.22;
  const R = 128;
  const W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  const I2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0; let s2 = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      s += v; s2 += v * v;
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s;
      I2[(y + 1) * W1 + x + 1] = I2[y * W1 + x + 1] + s2;
    }
  }
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r); const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r); const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      const s2 = I2[y1 * W1 + x1] - I2[y0 * W1 + x1] - I2[y1 * W1 + x0] + I2[y0 * W1 + x0];
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      const T = m * (1 + k * (sd / R - 1));
      // 對比太低的區域（例如純色背景）不算筆畫
      bin[y * w + x] = g[y * w + x] < T && sd > 6 ? 1 : 0;
    }
  }
  return bin;
}

function dilate(bin, w, h, rx, ry) {
  if (rx <= 0 && ry <= 0) return bin;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -rx; d <= rx && !v; d++) { const xx = x + d; if (xx >= 0 && xx < w && bin[y * w + xx]) v = 1; }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -ry; d <= ry && !v; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1; }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 8 連通區塊，回傳外框 */
function components(bin, w, h, wantLabels = false) {
  const label = new Int32Array(w * h);
  const boxes = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || label[i]) continue;
    next++;
    let sp = 0;
    stack[sp++] = i;
    label[i] = next;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let area = 0;
    while (sp) {
      const p = stack[--sp];
      const px = p % w; const py = (p - px) / w;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (bin[q] && !label[q]) { label[q] = next; stack[sp++] = q; }
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, area });
  }
  return wantLabels ? { boxes, label } : boxes;
}

const bw = (b) => b.x1 - b.x0 + 1;
const bh = (b) => b.y1 - b.y0 + 1;

/** 七段顯示器的筆畫之間有空隙：把水平方向重疊、垂直距離很近的區塊合併成一個數字 */
function mergeStrokes(boxes) {
  const list = boxes.map((b) => ({ ...b }));
  // 每次只合併「相對距離最小」的一對，讓同一個數字的筆畫先合併完成
  for (;;) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
        if (ox < Math.min(bw(a), bw(b)) * 0.5) continue;
        const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;
        const size = Math.max(bh(a), bh(b), bw(a), bw(b));
        const rel = (gap - 1.5) / size;
        if (rel > 0.03) continue;
        if (!best || rel < best.rel) best = { i, j, rel };
      }
    }
    if (!best) return list;
    const a = list[best.i]; const b = list[best.j];
    list[best.i] = {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area,
    };
    list.splice(best.j, 1);
  }
}

/** 把框內的二值影像縮放成 16×24（面積平均），再附上寬高比 */
export function digitTensor(bin, w, box) {
  const x = new Float32Array(INPUT_SIZE);
  const W = bw(box); const H = bh(box);
  for (let oy = 0; oy < IN_H; oy++) {
    const sy0 = box.y0 + (oy * H) / IN_H; const sy1 = box.y0 + ((oy + 1) * H) / IN_H;
    for (let ox = 0; ox < IN_W; ox++) {
      const sx0 = box.x0 + (ox * W) / IN_W; const sx1 = box.x0 + ((ox + 1) * W) / IN_W;
      let s = 0; let n = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
          s += bin[yy * w + xx] * wx * wy; n += wx * wy;
        }
      }
      x[oy * IN_W + ox] = n ? s / n : 0;
    }
  }
  x[IN_W * IN_H] = Math.min(1.5, W / H);
  return x;
}

/* ---------------- 主流程 ---------------- */

/** 清掉螢幕外框、大片陰影與雜點，只留下可能是筆畫的部分 */
function erode(bin, w, h, r) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = bin[i] ? 0 : 1;
  const d = dilate(inv, w, h, r, r);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

function cleanBinary(bin, w, h) {
  const tooBig = (b) => bw(b) >= w * 0.45 || bh(b) >= h * 0.6;
  const minArea = w * h * 0.00012;
  const { boxes, label } = components(bin, w, h, true);
  // 外框：太大、或是框住其他區塊的空心大框（例如整張照片裡的液晶螢幕邊框）
  const inside = (a, b) => a !== b && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1;
  const isFrame = boxes.map((b) => {
    if (tooBig(b)) return true;
    if (bw(b) < w * 0.15 && bh(b) < h * 0.15) return false;
    const fill = b.area / (bw(b) * bh(b));
    let n = 0;
    for (const o of boxes) if (o.area >= minArea && inside(b, o) && ++n >= 2) break;
    return n >= 2 || fill < 0.08;
  });
  const drop = new Uint8Array(boxes.length + 1);
  const big = new Uint8Array(w * h);
  let anyBig = false;
  boxes.forEach((b, i) => {
    if (isFrame[i] || b.area < minArea) drop[i + 1] = 1;
  });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    if (!bin[i]) continue;
    if (!drop[label[i]]) out[i] = 1;
    else if (isFrame[label[i] - 1]) { big[i] = 1; anyBig = true; }
  }
  if (anyBig) {
    // 數字常常和螢幕外框黏在一起：拿掉外框的長直線，再用「開運算」切斷細連線，把數字救回來
    const lines = longRuns(big, w, h, Math.round(w * 0.22), Math.round(h * 0.3));
    const cut = dilate(lines, w, h, 1, 1);
    const rest = new Uint8Array(w * h);
    for (let i = 0; i < rest.length; i++) rest[i] = big[i] && !cut[i] ? 1 : 0;
    const opened = dilate(erode(rest, w, h, 1), w, h, 1, 1);
    const sub = components(opened, w, h, true);
    const keep = sub.boxes.map((b) => !tooBig(b) && b.area >= minArea);
    for (let i = 0; i < out.length; i++) {
      if (rest[i] && opened[i] && keep[sub.label[i] - 1]) out[i] = 1;
    }
  }
  return out;
}

/** 標記很長的水平/垂直連續筆畫（螢幕外框、邊線） */
function longRuns(bin, w, h, minH, minV) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!bin[y * w + x]) { x++; continue; }
      let e = x;
      while (e < w && bin[y * w + e]) e++;
      if (e - x >= minH) for (let k = x; k < e; k++) out[y * w + k] = 1;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!bin[y * w + x]) { y++; continue; }
      let e = y;
      while (e < h && bin[e * w + x]) e++;
      if (e - y >= minV) for (let k = y; k < e; k++) out[k * w + x] = 1;
      y = e;
    }
  }
  return out;
}

/** 兩種視窗大小的二值化（大視窗抗反光；小視窗適合整張照片、螢幕較小時） */
export function binaryVariants(g, w, h) {
  const m = Math.min(w, h);
  return [m / 7, m / 15].map((r) => cleanBinary(binarize(g, w, h, { radius: Math.max(6, Math.round(r)) }), w, h));
}

export function classifyBox(bin, w, c) {
  c.x = digitTensor(bin, w, c);
  c.p = classifyDigit(c.x);
  let best = 0;
  for (let i = 1; i < c.p.length; i++) if (c.p[i] > c.p[best]) best = i;
  c.cls = best;
  c.conf = c.p[best];
}

/** 找出數字候選框（rx, ry：把同一個數字的筆畫連起來的膨脹半徑） */
export function findCandidates(bin, w, h, rx, ry) {
  const boxes = components(dilate(bin, w, h, rx, ry), w, h)
    .filter((b) => bw(b) < w * 0.45 && bh(b) < h * 0.6);
  // 膨脹後外框會變大，縮回原本筆畫的範圍
  for (const b of boxes) shrinkToInk(bin, w, b);
  return mergeStrokes(boxes).filter((b) => {
    const H = bh(b); const W = bw(b);
    if (H < h * 0.06 || H > h * 0.7) return false;
    const ar = W / H;
    if (ar > 1.0 || ar < 0.08) return false;
    const fill = b.area / (W * H);
    return fill > 0.1 && fill < 0.97;
  });
}

function shrinkToInk(bin, w, b) {
  let x0 = b.x1; let x1 = b.x0; let y0 = b.y1; let y1 = b.y0; let area = 0;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (!bin[y * w + x]) continue;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (area) Object.assign(b, { x0, x1, y0, y1, area });
}

function makeRow(row) {
  const y0 = Math.min(...row.map((d) => d.y0)); const y1 = Math.max(...row.map((d) => d.y1));
  return {
    digits: row,
    text: row.map((d) => d.cls).join(''),
    value: Number(row.map((d) => d.cls).join('')),
    h: y1 - y0 + 1, y0, y1,
    x0: row[0].x0, x1: row[row.length - 1].x1,
    conf: Math.min(...row.map((d) => d.conf)),
  };
}

/**
 * 血壓計的百位數「1」常常很窄、或上下兩段斷開而沒被辨識到。
 * 在兩位數那一列的左邊找一條細長的直線，有的話補上「1」。
 */
export function recoverLeadingOnes(bin, w, h, rows) {
  return rows.map((row) => {
    if (row.digits.length !== 2) return row;
    const [a, b] = row.digits;
    const H = row.h;
    const pitch = Math.max(b.x1 - a.x1, H * 0.45);
    const sx0 = Math.max(0, Math.round(a.x0 - pitch * 1.1));
    const sx1 = a.x0 - 2;
    if (sx1 - sx0 < 3) return row;
    const cover = [];
    for (let x = sx0; x <= sx1; x++) {
      let n = 0;
      for (let y = row.y0; y <= row.y1; y++) n += bin[y * w + x];
      cover.push(n / H);
    }
    const strong = cover.map((c, i) => [c, i]).filter(([c]) => c >= 0.62);
    if (!strong.length) return row;
    const bx0 = sx0 + strong[0][1]; const bx1 = sx0 + strong[strong.length - 1][1];
    if (bx1 - bx0 + 1 > H * 0.3) return row; // 太寬就不是「1」
    // 細線旁邊要乾淨，而且不能往上下延伸太多（排除外框直線）
    const other = cover.filter((c, i) => (sx0 + i < bx0 - 2 || sx0 + i > bx1 + 2) && c > 0.25).length;
    if (other > 2) return row;
    const pad = Math.round(H * 0.18);
    let ext = 0; let tot = 0;
    for (let x = bx0; x <= bx1; x++) {
      for (let y = Math.max(0, row.y0 - pad); y < row.y0; y++) { ext += bin[y * w + x]; tot++; }
      for (let y = row.y1 + 1; y <= Math.min(h - 1, row.y1 + pad); y++) { ext += bin[y * w + x]; tot++; }
    }
    if (tot && ext / tot > 0.3) return row;
    const one = { x0: bx0, x1: bx1, y0: row.y0, y1: row.y1, cls: 1, conf: 0.9, recovered: true };
    return makeRow([one, a, b]);
  });
}

/** 依高度與位置把數字分成「列」 */
export function groupRows(cands) {
  const digits = cands.filter((c) => c.cls !== REJECT && c.conf > 0.5);
  const used = new Set();
  const rows = [];
  const byH = digits.slice().sort((a, b) => bh(b) - bh(a));
  for (const seed of byH) {
    if (used.has(seed)) continue;
    const H = bh(seed); const cy = (seed.y0 + seed.y1) / 2;
    const members = digits.filter((d) => !used.has(d) &&
      Math.abs((d.y0 + d.y1) / 2 - cy) < H * 0.3 &&
      bh(d) / H > 0.75);
    members.sort((a, b) => a.x0 - b.x0);
    // 從 seed 往左右延伸，數字之間的間距不能太大
    const si = members.indexOf(seed);
    let lo = si; let hi = si;
    while (lo > 0 && members[lo].x0 - members[lo - 1].x1 < H * 0.9) lo--;
    while (hi < members.length - 1 && members[hi + 1].x0 - members[hi].x1 < H * 0.9) hi++;
    const row = members.slice(lo, hi + 1);
    row.forEach((d) => used.add(d));
    rows.push(makeRow(row));
  }
  return rows;
}

export const CONFIGS = [[1, 1], [1, 2], [2, 3], [0, 0], [2, 5]];

/** 訓練資料用：列出所有設定下的候選框（含正規化後的小圖） */
export function allCandidates(g, w, h) {
  const out = [];
  for (const bin of binaryVariants(g, w, h)) {
    const seen = new Set();
    for (const [rx, ry] of CONFIGS) {
      for (const c of findCandidates(bin, w, h, rx, ry)) {
        const key = `${c.x0},${c.y0},${c.x1},${c.y1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        c.x = digitTensor(bin, w, c);
        out.push(c);
      }
    }
  }
  return { cands: out };
}

/** 把來源影像的某個區域縮放到工作尺寸並轉成灰階 */
export function toWorkGray(src, rect, work = document.createElement('canvas')) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  const r = rect || { x: 0, y: 0, w: sw, h: sh };
  const scale = WORK_W / r.w;
  const W = WORK_W; const H = Math.max(16, Math.round(r.h * scale));
  work.width = W; work.height = H;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, W, H);
  return { g: toGray(ctx.getImageData(0, 0, W, H)), w: W, h: H, scale };
}

/**
 * 從灰階影像中找出血壓數字。會嘗試幾種筆畫連接方式，取最可信的結果。
 */
export function findDigits(g, w, h) {
  let best = null;
  const readings = [];
  outer:
  for (const bin of binaryVariants(g, w, h)) {
    for (const [rx, ry] of CONFIGS) {
      const cands = findCandidates(bin, w, h, rx, ry);
      for (const c of cands) classifyBox(bin, w, c);
      const rows = recoverLeadingOnes(bin, w, h, groupRows(cands));
      const reading = pickReading(rows);
      if (reading) readings.push(reading);
      const score = reading ? reading.score : -1;
      if (!best || score > best.score) best = { score, cands, rows, reading, bin };
      // 已經很確定就提早結束（收縮壓低於 100 很少見，繼續找找看有沒有漏掉的「1」）
      if (reading && reading.pulse !== null && reading.conf > 0.9 && reading.sys >= 100) break outer;
    }
  }
  if (best.reading) best.reading = consensus(best.reading, readings);
  return { w, h, ...best };
}

/** 綜合不同設定的結果：補回漏掉的百位數「1」與脈搏 */
function consensus(r, all) {
  const out = { ...r };
  for (const o of all) {
    if (o === r) continue;
    // 同一組數字，只是另一種設定多抓到了百位數的「1」
    if (o.dia === out.dia && o.sys === out.sys + 100 && out.sys < 100) out.sys = o.sys;
    if (o.sys % 100 === out.sys % 100 && o.dia === out.dia + 100 && out.dia < 100 && o.dia < o.sys) out.dia = o.dia;
  }
  for (const o of all) {
    if (o === r || o.sys !== out.sys || o.dia !== out.dia || o.pulse === null) continue;
    if (out.pulse === null || (out.pulse < 100 && o.pulse === out.pulse + 100)) out.pulse = o.pulse;
  }
  return out;
}

const inRange = (v, lo, hi) => v >= lo && v <= hi;

/** 從各列挑出 收縮壓 / 舒張壓 / 脈搏 */
export function pickReading(rows) {
  const MIN_CONF = 0.6;
  const cand = rows
    .filter((r) => r.digits.length >= 2 && r.digits.length <= 3 && r.conf >= MIN_CONF)
    .sort((a, b) => a.y0 - b.y0);
  let best = null;
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const s = cand[i]; const d = cand[j];
      if (!inRange(s.value, 60, 260) || !inRange(d.value, 30, 160) || s.value <= d.value) continue;
      // 收縮壓與舒張壓兩列大小相近、上下相鄰；左右位置也要對齊
      const hr = d.h / s.h;
      if (hr < 0.78 || hr > 1.28) continue;
      if (Math.abs(d.x1 - s.x1) > s.h * 0.6) continue;
      if (d.y0 - s.y1 > s.h * 1.2) continue;
      let pulse = null;
      for (let k = j + 1; k < cand.length; k++) {
        const p = cand[k];
        if (!inRange(p.value, 30, 220)) continue;
        if (p.y0 - d.y1 > d.h * 1.2) continue;
        if (p.h > d.h * 0.92 || p.h < d.h * 0.3) continue; // 脈搏的字比較小
        if (!pulse || p.conf > pulse.conf) pulse = p;
        break;
      }
      // 分數：字越大、越可信、位數越多越好（避免漏掉百位數的「1」）
      const nd = s.digits.length + d.digits.length + (pulse ? pulse.digits.length : 0);
      const score = s.h + d.h + (pulse ? pulse.h * 0.8 : 0) + (s.conf + d.conf) * 10 + nd * s.h * 0.15;
      if (!best || score > best.score) best = { score, sys: s, dia: d, pulse };
    }
  }
  if (!best) return null;
  return {
    sys: best.sys.value,
    dia: best.dia.value,
    pulse: best.pulse ? best.pulse.value : null,
    rows: [best.sys, best.dia, best.pulse].filter(Boolean),
    score: best.score,
    conf: Math.min(best.sys.conf, best.dia.conf, best.pulse ? best.pulse.conf : 1),
  };
}

/**
 * 辨識畫布/影像/影片中某個區域的血壓數字
 * @param {CanvasImageSource} src
 * @param {{x:number,y:number,w:number,h:number}} [rect] 來源座標中的裁切範圍
 */
export function recognize(src, rect, work) {
  const { g, w, h } = toWorkGray(src, rect, work);
  return findDigits(g, w, h);
}
