// 資料儲存（localStorage）與共用工具
const KEY = 'bp-records-v1';

export const LIMITS = {
  sys: [60, 260],
  dia: [30, 160],
  pulse: [30, 220],
};

function isValid(r) {
  return r && typeof r.id === 'string' && Number.isFinite(r.t) &&
    Number.isFinite(r.sys) && Number.isFinite(r.dia) && Number.isFinite(r.pulse);
}

export function loadRecords() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(isValid).sort((a, b) => a.t - b.t) : [];
  } catch {
    return [];
  }
}

export function saveRecords(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function parseImport(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data && data.records;
  if (!Array.isArray(list)) throw new Error('格式不正確');
  return list
    .map((r) => ({
      id: String(r.id || uid()),
      t: Number(r.t),
      sys: Number(r.sys),
      dia: Number(r.dia),
      pulse: Number(r.pulse),
      note: typeof r.note === 'string' ? r.note.slice(0, 60) : '',
    }))
    .filter(isValid);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- 日期 ---------- */
const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d) {
  d = d instanceof Date ? d : new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function fmtTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDayTitle(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEK[date.getDay()]}`;
}

export function fmtMD(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 早晚不硬性規定：以中午 12 點為界，之前算「早上」，之後算「晚上」 */
export function isMorning(t) {
  return new Date(t).getHours() < 12;
}

export function periodLabel(t) {
  const h = new Date(t).getHours();
  if (h < 5) return '凌晨';
  if (h < 12) return '早上';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

/* ---------- 血壓分級（2022 台灣高血壓指引，居家血壓） ---------- */
export const LEVELS = [
  { lv: 0, label: '正常', short: '正常' },
  { lv: 1, label: '偏高', short: '偏高' },
  { lv: 2, label: '高血壓第一期', short: '第一期' },
  { lv: 3, label: '高血壓第二期', short: '第二期' },
];

export function classify(sys, dia) {
  let lv = 0;
  if (sys >= 140 || dia >= 90) lv = 3;
  else if (sys >= 130 || dia >= 80) lv = 2;
  else if (sys >= 120) lv = 1;
  return LEVELS[lv];
}

export function groupByDay(records) {
  const map = new Map();
  for (const r of records) {
    const k = dayKey(r.t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t);
  return map;
}

export const round = (v) => Math.round(v);
export const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
