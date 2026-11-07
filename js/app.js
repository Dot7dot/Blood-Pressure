import {
  loadRecords, saveRecords, parseImport, uid, LIMITS,
  dayKey, keyToDate, addDays, startOfDay, fmtTime, fmtDayTitle, fmtMD, WEEK,
  isMorning, periodLabel, classify, groupByDay, round, mean,
} from './store.js';
import { Wheel } from './wheel.js';
import { renderChart } from './chart.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================= 狀態 ================= */
let records = loadRecords();
let byDay = groupByDay(records);

const PREF_KEY = 'bp-prefs';
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
})();

const today0 = startOfDay(new Date());
const state = {
  view: 'calendar',
  month: new Date(today0.getFullYear(), today0.getMonth(), 1),
  selected: dayKey(today0),
  range: ['7', '30', '90', 'all'].includes(prefs.range) ? prefs.range : '30',
  metric: prefs.metric || 'sys',
  agg: prefs.agg || 'max',
  editingId: null,
};

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ range: state.range, metric: state.metric, agg: state.agg })); } catch { /* 忽略 */ }
}

function commit() {
  records.sort((a, b) => a.t - b.t);
  byDay = groupByDay(records);
  if (!saveRecords(records)) toast('儲存失敗：瀏覽器儲存空間不足或被停用');
  renderAll();
}

/* ================= 趨勢設定 ================= */
const METRICS = [
  { id: 'sys', label: '收縮壓（高壓）', name: '收縮壓', unit: 'mmHg', get: (r) => r.sys, refs: [{ y: 130, label: '130' }],
    note: '虛線為居家血壓控制目標：收縮壓 130 mmHg。' },
  { id: 'dia', label: '舒張壓（低壓）', name: '舒張壓', unit: 'mmHg', get: (r) => r.dia, refs: [{ y: 80, label: '80' }],
    note: '虛線為居家血壓控制目標：舒張壓 80 mmHg。' },
  { id: 'both', label: '收縮＋舒張', name: '收縮壓 / 舒張壓', unit: 'mmHg', refs: [{ y: 130, label: '130' }, { y: 80, label: '80' }],
    note: '同時顯示收縮壓與舒張壓，虛線為目標 130/80 mmHg。' },
  { id: 'pulse', label: '脈搏', name: '脈搏', unit: 'bpm', get: (r) => r.pulse, refs: [],
    note: '成人安靜時脈搏一般約在每分鐘 60–100 下。' },
  { id: 'map', label: '平均血壓 MAP', name: '平均動脈壓', unit: 'mmHg', get: (r) => r.dia + (r.sys - r.dia) / 3, refs: [],
    note: '平均動脈壓（MAP）= 舒張壓 +（收縮壓 − 舒張壓）÷ 3，代表一次心跳中血管承受的平均壓力。' },
  { id: 'pp', label: '脈壓差', name: '脈壓差', unit: 'mmHg', get: (r) => r.sys - r.dia, refs: [],
    note: '脈壓差 = 收縮壓 − 舒張壓，一般約 40 mmHg 左右。' },
];
const AGGS = [
  { id: 'max', label: '當日最高', desc: '每天取最高值' },
  { id: 'avg', label: '當日平均', desc: '每天取平均值' },
  { id: 'min', label: '當日最低', desc: '每天取最低值' },
  { id: 'am', label: '只看早上', desc: '每天早上（12 點前）的平均' },
  { id: 'pm', label: '只看晚上', desc: '每天晚上（12 點後）的平均' },
];
if (!METRICS.some((m) => m.id === state.metric)) state.metric = 'sys';
if (!AGGS.some((a) => a.id === state.agg)) state.agg = 'max';

const SYS = { name: '收縮壓', color: 'var(--series-1)', css: 'var(--series-1)', get: (r) => r.sys };
const DIA = { name: '舒張壓', color: 'var(--series-2)', css: 'var(--series-2)', get: (r) => r.dia };

function aggregate(list, get, aggId) {
  let rs = list;
  if (aggId === 'am') rs = list.filter((r) => isMorning(r.t));
  if (aggId === 'pm') rs = list.filter((r) => !isMorning(r.t));
  if (!rs.length) return null;
  const vals = rs.map(get);
  if (aggId === 'max') return Math.max(...vals);
  if (aggId === 'min') return Math.min(...vals);
  return mean(vals);
}

/* ================= 日曆 ================= */
function dayInfo(key) {
  const list = byDay.get(key) || [];
  const am = list.some((r) => isMorning(r.t));
  const pm = list.some((r) => !isMorning(r.t));
  const lv = list.length ? Math.max(...list.map((r) => classify(r.sys, r.dia).lv)) : -1;
  return { list, am, pm, lv };
}

function renderCalendar() {
  const m = state.month;
  $('#calTitle').textContent = `${m.getFullYear()} 年 ${m.getMonth() + 1} 月`;
  const startDow = m.getDay();
  const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  const start = addDays(m, -startDow);
  const todayKey = dayKey(new Date());
  const now = Date.now();
  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = addDays(start, i);
    const key = dayKey(d);
    const info = dayInfo(key);
    const cls = ['cal-day'];
    if (d.getMonth() !== m.getMonth()) cls.push('out');
    if (key === todayKey) cls.push('today');
    if (key === state.selected) cls.push('selected');
    const future = d.getTime() > now;
    if (future) cls.push('future');
    if (info.lv >= 0) cls.push(`lv${info.lv}`);
    const extra = info.list.length > 2 ? `<span class="d-more">+${info.list.length - 2}</span>` : '';
    const dots = info.list.length
      ? `<span class="d-dots"><i class="dot ${info.am ? 'on' : ''}"></i><i class="dot ${info.pm ? 'on' : ''}"></i>${extra}</span>`
      : '<span class="d-dots"></span>';
    const label = `${d.getMonth() + 1}月${d.getDate()}日，${info.list.length ? `${info.list.length} 筆記錄` : '沒有記錄'}`;
    html += `<button type="button" class="${cls.join(' ')}" data-key="${key}" ${future ? 'disabled' : ''} aria-label="${label}"><span class="d-num">${d.getDate()}</span>${dots}</button>`;
  }
  $('#calGrid').innerHTML = html;
}

function renderDay() {
  const date = keyToDate(state.selected);
  const info = dayInfo(state.selected);
  const isToday = state.selected === dayKey(new Date());
  $('#dayTitle').textContent = isToday ? `今天 · ${fmtDayTitle(date)}` : fmtDayTitle(date);
  if (info.list.length) {
    const s = round(mean(info.list.map((r) => r.sys)));
    const d = round(mean(info.list.map((r) => r.dia)));
    const p = round(mean(info.list.map((r) => r.pulse)));
    $('#daySummary').textContent = `${info.list.length} 筆 · 平均 ${s}/${d} mmHg · 脈搏 ${p}`;
  } else {
    $('#daySummary').textContent = '還沒有記錄';
  }
  const ul = $('#dayList');
  if (!info.list.length) {
    ul.innerHTML = `<li class="empty">這天還沒有血壓記錄<br>點右上角「＋ 新增」開始記錄吧</li>`;
    return;
  }
  ul.innerHTML = info.list.map((r) => {
    const c = classify(r.sys, r.dia);
    return `<li><button type="button" class="record" data-id="${r.id}">
      <span class="rec-time"><b>${fmtTime(r.t)}</b><span>${periodLabel(r.t)}</span></span>
      <span class="rec-vals"><b>${r.sys}/${r.dia}</b><small>mmHg</small>
        <span class="rec-meta">脈搏 ${r.pulse} bpm${r.note ? ` · ${esc(r.note)}` : ''}</span></span>
      <span class="tag lv${c.lv}">${c.short}</span>
    </button></li>`;
  }).join('');
}

function streakDays() {
  let n = 0;
  let d = startOfDay(new Date());
  const t = dayInfo(dayKey(d));
  if (!(t.am && t.pm)) d = addDays(d, -1); // 今天還沒完成不算中斷
  for (;;) {
    const info = dayInfo(dayKey(d));
    if (info.am && info.pm) { n++; d = addDays(d, -1); } else break;
  }
  return n;
}

function renderReminder() {
  const info = dayInfo(dayKey(new Date()));
  const hour = new Date().getHours();
  let text;
  let sub = '建議每天至少早晚各量一次，多量幾次也都可以記錄。';
  if (info.am && info.pm) {
    text = '今天早晚都量完了，太棒了！';
    sub = info.list.length > 2 ? `今天共記錄 ${info.list.length} 次，繼續保持。` : '想多量幾次也可以繼續記錄。';
  } else if (info.am) {
    text = hour < 18 ? '早上已完成 ✓ 晚上睡前記得再量一次' : '晚上了，睡前記得再量一次血壓';
  } else if (info.pm) {
    text = '晚上已完成 ✓ 明天起床後記得量一次';
  } else if (hour < 12) {
    text = '早安！起床後記得先量一次血壓';
  } else {
    text = '今天還沒有記錄，晚上睡前記得量一次';
  }
  const streak = streakDays();
  if (streak >= 2) sub = `已連續 ${streak} 天完成早晚測量 🔥 ` + (info.am && info.pm ? '' : sub);
  const el = $('#reminder');
  el.classList.toggle('done', info.am && info.pm);
  el.innerHTML = `
    <div><p class="reminder-text">${text}</p><p class="reminder-sub">${sub}</p></div>
    <div class="reminder-chips">
      <span class="r-chip ${info.am ? 'ok' : ''}"><span class="mark">${info.am ? '✓' : ''}</span>早上</span>
      <span class="r-chip ${info.pm ? 'ok' : ''}"><span class="mark">${info.pm ? '✓' : ''}</span>晚上</span>
    </div>`;
}

/* ================= 趨勢 ================= */
function renderChips() {
  $('#metricChips').innerHTML = METRICS.map((m) =>
    `<button type="button" class="chip" role="radio" data-v="${m.id}" aria-checked="${m.id === state.metric}">${m.label}</button>`).join('');
  $('#aggChips').innerHTML = AGGS.map((a) =>
    `<button type="button" class="chip" role="radio" data-v="${a.id}" aria-checked="${a.id === state.agg}">${a.label}</button>`).join('');
  $$('#rangeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.range)));
}

function trendData() {
  const x1 = startOfDay(new Date());
  let x0;
  if (state.range === 'all') x0 = records.length ? startOfDay(records[0].t) : x1;
  else x0 = addDays(x1, -(Number(state.range) - 1));
  if (x0 > x1) x0 = x1;

  const metric = METRICS.find((m) => m.id === state.metric);
  const defs = metric.id === 'both' ? [SYS, DIA] : [{ name: metric.name, color: 'var(--series-1)', get: metric.get }];
  const days = [];
  for (const [key, list] of byDay) {
    const d = keyToDate(key);
    if (d < x0 || d > x1) continue;
    const vals = defs.map((df) => aggregate(list, df.get, state.agg));
    if (vals.every((v) => v === null)) continue;
    days.push({ key, x: d.getTime(), vals, n: list.length });
  }
  days.sort((a, b) => a.x - b.x);
  const series = defs.map((df, k) => ({
    name: df.name, color: df.color,
    points: days.filter((d) => d.vals[k] !== null).map((d) => ({ x: d.x, y: d.vals[k] })),
  }));
  return { x0: x0.getTime(), x1: x1.getTime(), metric, defs, days, series };
}

function renderTrend() {
  renderChips();
  const td = trendData();
  const { metric, defs, days, series } = td;
  const agg = AGGS.find((a) => a.id === state.agg);

  // 統計方塊
  const fmtStat = (fn) => {
    const parts = series.map((sr) => (sr.points.length ? round(fn(sr.points.map((p) => p.y))) : '–'));
    return parts.join('/');
  };
  const has = days.length > 0;
  $('#stats').classList.toggle('pair', series.length > 1);
  $('#stats').innerHTML = `
    <div class="stat lead"><span>平均</span><b>${has ? fmtStat(mean) : '–'}</b></div>
    <div class="stat"><span>最高</span><b>${has ? fmtStat((v) => Math.max(...v)) : '–'}</b></div>
    <div class="stat"><span>最低</span><b>${has ? fmtStat((v) => Math.min(...v)) : '–'}</b></div>
    <div class="stat"><span>記錄天數</span><b>${days.length}</b></div>`;

  const rangeText = state.range === 'all' ? '全部期間' : `最近 ${state.range} 天`;
  $('#chartTitle').textContent = metric.name;
  $('#chartSub').textContent = `${metric.unit} · ${rangeText} · ${agg.desc}`;
  $('#chartLegend').innerHTML = defs.length > 1
    ? defs.map((d) => `<span><i style="background:${d.css}"></i>${d.name}</span>`).join('')
    : '';
  $('#chartNote').textContent = metric.note;

  const fmtVal = (v) => (v === null ? '–' : round(v));
  renderChart($('#chart'), {
    series,
    x0: td.x0,
    x1: td.x1,
    refs: metric.refs,
    fmtX: (ms) => fmtMD(new Date(ms)),
    empty: records.length
      ? '這段期間沒有符合條件的記錄<br><span class="muted small">試試看切換期間或每日取值</span>'
      : '還沒有任何記錄<br><button type="button" class="pill-btn accent" data-action="demo">載入示範資料看看</button>',
    tooltip: (ms) => {
      const d = days.find((x) => x.x === ms);
      const date = new Date(ms);
      const rows = defs.map((df, k) =>
        `<div class="tt-row"><i style="background:${df.color}"></i>${df.name} <b>${d ? fmtVal(d.vals[k]) : '–'}</b></div>`).join('');
      return `<div class="tt-date">${fmtMD(date)}（${WEEK[date.getDay()]}）· ${d ? d.n : 0} 筆</div>${rows}`;
    },
  });

  // 數據表
  const head = defs.map((d) => `<th class="r">${d.name}</th>`).join('');
  const rows = days.slice().reverse().map((d) => {
    const date = keyToDate(d.key);
    return `<tr><td>${fmtMD(date)}（${WEEK[date.getDay()]}）</td>${d.vals.map((v) => `<td class="r">${fmtVal(v)}</td>`).join('')}<td class="r">${d.n}</td></tr>`;
  }).join('');
  $('#tableWrap').innerHTML = days.length
    ? `<table><thead><tr><th>日期</th>${head}<th class="r">筆數</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted small" style="padding:4px 0 8px">沒有資料</p>';
}

/* ================= 設定 ================= */
function renderSettings() {
  const mode = currentThemeMode();
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === mode)));
  const days = byDay.size;
  $('#dataCount').textContent = records.length ? `目前共有 ${records.length} 筆記錄，分布在 ${days} 天。` : '目前還沒有記錄。';
}

/* ================= 畫面切換 ================= */
function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#settingsBtn').classList.toggle('active', view === 'settings');
  window.scrollTo(0, 0);
  renderAll();
}

function renderAll() {
  if (state.view === 'calendar') { renderReminder(); renderCalendar(); renderDay(); }
  if (state.view === 'trend') renderTrend();
  if (state.view === 'settings') renderSettings();
}

/* ================= 主題 ================= */
const mq = window.matchMedia('(prefers-color-scheme: dark)');
function currentThemeMode() {
  try { const t = localStorage.getItem('bp-theme'); if (t === 'light' || t === 'dark') return t; } catch { /* 忽略 */ }
  return 'system';
}
function effectiveTheme() {
  const m = currentThemeMode();
  return m === 'system' ? (mq.matches ? 'dark' : 'light') : m;
}
function applyTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem('bp-theme');
    else localStorage.setItem('bp-theme', mode);
  } catch { /* 忽略 */ }
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  syncThemeColor();
  renderAll();
}
function syncThemeColor() {
  const dark = effectiveTheme() === 'dark';
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#0e1014' : '#f3f4f6');
  $('#themeBtn').setAttribute('aria-label', dark ? '切換為淺色' : '切換為深色');
}
mq.addEventListener?.('change', () => { syncThemeColor(); renderAll(); });

/* ================= 新增 / 編輯表單 ================= */
const pad2 = (n) => String(n).padStart(2, '0');
const wPeriod = new Wheel($('#wPeriod'), ['上午', '下午'], { onChange: updateSheetHint, ariaText: (i) => (i ? '下午' : '上午') });
const wHour = new Wheel($('#wHour'), ['12', ...Array.from({ length: 11 }, (_, i) => String(i + 1))], {
  loop: true, onChange: updateSheetHint, ariaText: (i) => `${i === 0 ? 12 : i} 點`,
});
const wMinute = new Wheel($('#wMinute'), Array.from({ length: 60 }, (_, i) => pad2(i)), {
  loop: true, onChange: updateSheetHint, ariaText: (i) => `${i} 分`,
});

function setWheelTime(h, m) {
  wPeriod.set(h >= 12 ? 1 : 0);
  wHour.set(h % 12);
  wMinute.set(m);
}
function getWheelTime() {
  return { h: wHour.value + (wPeriod.value ? 12 : 0), m: wMinute.value };
}

const fSys = $('#fSys');
const fDia = $('#fDia');
const fPulse = $('#fPulse');
const fDate = $('#fDate');
const fNote = $('#fNote');

function sloganFor(key) {
  const info = dayInfo(key);
  const others = state.editingId ? info.list.filter((r) => r.id !== state.editingId) : info.list;
  const am = others.some((r) => isMorning(r.t));
  const pm = others.some((r) => !isMorning(r.t));
  if (am && pm) return `👍 這天早晚都量過了（${others.length} 筆），多量幾次也很好！`;
  if (am) return '☀️ 早上已記錄，別忘了晚上睡前再量一次';
  if (pm) return '🌙 晚上已記錄，早上起床後也記得量一次';
  return '💡 每天至少早晚各量一次，更能掌握血壓變化';
}

function openSheet(id) {
  const rec = id ? records.find((r) => r.id === id) : null;
  state.editingId = rec ? rec.id : null;
  $('#sheetTitle').textContent = rec ? '編輯記錄' : '新增記錄';
  $('#sheetDelete').hidden = !rec;
  const todayKey = dayKey(new Date());
  fDate.max = todayKey;

  let key; let h; let m;
  if (rec) {
    const d = new Date(rec.t);
    key = dayKey(d); h = d.getHours(); m = d.getMinutes();
    fSys.value = rec.sys; fDia.value = rec.dia; fPulse.value = rec.pulse; fNote.value = rec.note || '';
  } else {
    key = state.selected > todayKey ? todayKey : state.selected;
    if (key === todayKey) {
      const now = new Date(); h = now.getHours(); m = now.getMinutes();
    } else {
      const info = dayInfo(key);
      [h, m] = info.am && !info.pm ? [21, 0] : [7, 0];
    }
    fSys.value = ''; fDia.value = ''; fPulse.value = ''; fNote.value = '';
  }
  fDate.value = key;
  $('#slogan').textContent = sloganFor(key);
  [fSys, fDia, fPulse].forEach((el) => el.closest('.num-block').classList.remove('invalid'));
  updateSheetHint();

  const sheet = $('#sheet');
  const bd = $('#backdrop');
  sheet.hidden = false; bd.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => {
    setWheelTime(h, m);
    sheet.classList.add('show'); bd.classList.add('show');
  });
}

function closeSheet() {
  const sheet = $('#sheet');
  const bd = $('#backdrop');
  sheet.classList.remove('show'); bd.classList.remove('show');
  document.body.classList.remove('sheet-open');
  document.activeElement?.blur?.();
  setTimeout(() => { sheet.hidden = true; bd.hidden = true; }, 280);
  state.editingId = null;
}

function readNum(el) {
  const v = el.value.trim();
  return v === '' ? null : Number(v);
}

function validate() {
  const sys = readNum(fSys); const dia = readNum(fDia); const pulse = readNum(fPulse);
  const errs = [];
  const check = (v, el, [lo, hi], name) => {
    const bad = v === null || !(v >= lo && v <= hi);
    if (v !== null && bad) errs.push(`${name}應介於 ${lo}–${hi}`);
    return bad;
  };
  const bS = check(sys, fSys, LIMITS.sys, '收縮壓');
  const bD = check(dia, fDia, LIMITS.dia, '舒張壓');
  const bP = check(pulse, fPulse, LIMITS.pulse, '脈搏');
  if (!bS && !bD && sys <= dia) errs.push('收縮壓應大於舒張壓');
  return { sys, dia, pulse, errs, bad: { sys: bS, dia: bD, pulse: bP } };
}

function updateSheetHint() {
  const hint = $('#formHint');
  if (!hint) return;
  const v = validate();
  hint.classList.remove('err');
  if (v.errs.length) {
    hint.classList.add('err');
    hint.textContent = v.errs[0];
  } else if (!v.bad.sys && !v.bad.dia) {
    const c = classify(v.sys, v.dia);
    hint.innerHTML = `<span class="tag lv${c.lv}">${c.label}</span>${v.bad.pulse ? '再輸入脈搏即可儲存' : '可以儲存了'}`;
  } else {
    hint.textContent = '依序輸入血壓計上的三個數字';
  }
}

function saveSheet() {
  const v = validate();
  const markInvalid = () => {
    fSys.closest('.num-block').classList.toggle('invalid', v.bad.sys);
    fDia.closest('.num-block').classList.toggle('invalid', v.bad.dia);
    fPulse.closest('.num-block').classList.toggle('invalid', v.bad.pulse);
  };
  if (v.bad.sys || v.bad.dia || v.bad.pulse || v.errs.length) {
    markInvalid();
    const hint = $('#formHint');
    hint.classList.add('err');
    hint.textContent = v.errs[0] || '請輸入收縮壓、舒張壓與脈搏三個數值';
    return;
  }
  if (!fDate.value) { toast('請選擇日期'); return; }
  const { h, m } = getWheelTime();
  const d = keyToDate(fDate.value);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > Date.now() + 60000) {
    const hint = $('#formHint');
    hint.classList.add('err');
    hint.textContent = '記錄時間不能晚於現在，請調整時間';
    return;
  }
  const key = dayKey(d);
  const before = dayInfo(key);
  const data = { t: d.getTime(), sys: v.sys, dia: v.dia, pulse: v.pulse, note: fNote.value.trim() };
  if (state.editingId) {
    const r = records.find((x) => x.id === state.editingId);
    if (r) Object.assign(r, data);
  } else {
    records.push({ id: uid(), ...data });
  }
  const editing = !!state.editingId;
  closeSheet();
  state.selected = key;
  state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  commit();
  const after = dayInfo(key);
  if (!editing && !(before.am && before.pm) && after.am && after.pm) toast('🎉 這天早晚都完成了！');
  else toast(editing ? '已更新記錄' : `已記錄 ${fmtTime(d)} 的血壓`);
}

function deleteRecord() {
  if (!state.editingId) return;
  if (!confirm('確定要刪除這筆記錄嗎？')) return;
  records = records.filter((r) => r.id !== state.editingId);
  closeSheet();
  commit();
  toast('已刪除');
}

// 數字輸入：只允許數字，輸入完整後自動跳到下一格
function bindNum(el, next) {
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(0, 3);
    el.closest('.num-block').classList.remove('invalid');
    updateSheetHint();
    const v = el.value;
    const done = v.length === 3 || (v.length === 2 && v[0] !== '1' && v[0] !== '2');
    if (done && next) next.focus();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (next) next.focus(); else { el.blur(); saveSheet(); }
    }
  });
}
bindNum(fSys, fDia);
bindNum(fDia, fPulse);
bindNum(fPulse, null);
fDate.addEventListener('change', () => { $('#slogan').textContent = sloganFor(fDate.value || dayKey(new Date())); });

/* ================= 匯出 / 匯入 ================= */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => dayKey(new Date()).replace(/-/g, '');

function exportCsv() {
  if (!records.length) { toast('目前沒有記錄可以匯出'); return; }
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['日期,時間,時段,收縮壓,舒張壓,脈搏,分級,備註'];
  for (const r of records) {
    lines.push([dayKey(r.t), fmtTime(r.t), periodLabel(r.t), r.sys, r.dia, r.pulse, classify(r.sys, r.dia).label, q(r.note || '')].join(','));
  }
  download(`血壓記錄-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}
function exportJson() {
  if (!records.length) { toast('目前沒有記錄可以匯出'); return; }
  download(`blood-pressure-backup-${stamp()}.json`, JSON.stringify({ app: 'bp-diary', version: 1, exported: new Date().toISOString(), records }, null, 2), 'application/json');
}
async function importJson(file) {
  try {
    const list = parseImport(await file.text());
    const ids = new Set(records.map((r) => r.id));
    let added = 0;
    for (const r of list) if (!ids.has(r.id)) { records.push(r); added++; }
    commit();
    toast(`已匯入 ${added} 筆記錄`);
  } catch {
    toast('匯入失敗：檔案格式不正確');
  }
}

function loadDemo() {
  if (records.length && !confirm('示範資料會加入到現有記錄中，確定要載入嗎？')) return;
  const today = startOfDay(new Date());
  const rnd = (a) => (Math.random() * 2 - 1) * a;
  for (let i = 59; i >= 0; i--) {
    const day = addDays(today, -i);
    if (Math.random() < 0.06) continue; // 偶爾忘記量
    const trend = (i / 59) * 10; // 慢慢改善
    const slots = [[7, 10 + Math.floor(Math.random() * 40)], [21, Math.floor(Math.random() * 50)]];
    if (Math.random() < 0.18) slots.push([13, Math.floor(Math.random() * 59)]);
    if (Math.random() < 0.08) slots.splice(1, 1);
    for (const [h, m] of slots) {
      const t = new Date(day); t.setHours(h, m, 0, 0);
      if (t.getTime() > Date.now()) continue;
      const am = h < 12 ? 5 : 0;
      const sys = Math.round(123 + trend + am + rnd(7));
      const dia = Math.round(78 + trend * 0.5 + am * 0.6 + rnd(4));
      const pulse = Math.round(72 + rnd(7) - (h < 12 ? 2 : 0));
      records.push({ id: uid(), t: t.getTime(), sys, dia, pulse, note: '' });
    }
  }
  commit();
  toast('已載入 60 天示範資料');
}

/* ================= 提示訊息 ================= */
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ================= 事件綁定 ================= */
$$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('#settingsBtn').addEventListener('click', () => setView(state.view === 'settings' ? 'calendar' : 'settings'));
$('#themeBtn').addEventListener('click', () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
$('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.v); });

$('#addBtn').addEventListener('click', () => openSheet(null));
$('#dayAdd').addEventListener('click', () => openSheet(null));
$('#dayList').addEventListener('click', (e) => { const b = e.target.closest('.record'); if (b) openSheet(b.dataset.id); });

$('#calGrid').addEventListener('click', (e) => {
  const b = e.target.closest('.cal-day');
  if (!b || b.disabled) return;
  state.selected = b.dataset.key;
  const d = keyToDate(b.dataset.key);
  if (d.getMonth() !== state.month.getMonth()) state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar(); renderDay();
});
const shiftMonth = (n) => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
  renderCalendar();
};
$('#calPrev').addEventListener('click', () => shiftMonth(-1));
$('#calNext').addEventListener('click', () => shiftMonth(1));
$('#calToday').addEventListener('click', () => {
  const t = new Date();
  state.month = new Date(t.getFullYear(), t.getMonth(), 1);
  state.selected = dayKey(t);
  renderCalendar(); renderDay();
});
// 左右滑動切換月份
(() => {
  let sx = 0; let sy = 0;
  const grid = $('#calGrid');
  grid.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

$('#rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.range = b.dataset.v; savePrefs(); renderTrend();
});
$('#metricChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.metric = b.dataset.v; savePrefs(); renderTrend();
});
$('#aggChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.agg = b.dataset.v; savePrefs(); renderTrend();
});
$('#chart').addEventListener('click', (e) => { if (e.target.closest('[data-action="demo"]')) loadDemo(); });

$('#sheetCancel').addEventListener('click', closeSheet);
$('#backdrop').addEventListener('click', closeSheet);
$('#sheetSave').addEventListener('click', saveSheet);
$('#sheetSave2').addEventListener('click', saveSheet);
$('#sheetDelete').addEventListener('click', deleteRecord);
$('.quick-times').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quick]'); if (!b) return;
  if (b.dataset.quick === 'now') {
    const n = new Date();
    fDate.value = dayKey(n);
    setWheelTime(n.getHours(), n.getMinutes());
  } else {
    const [h, m] = b.dataset.quick.split(':').map(Number);
    setWheelTime(h, m);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

$('#exportCsv').addEventListener('click', exportCsv);
$('#exportJson').addEventListener('click', exportJson);
$('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importJson(f); e.target.value = ''; });
$('#loadDemo').addEventListener('click', loadDemo);
$('#clearAll').addEventListener('click', () => {
  if (!records.length) { toast('目前沒有記錄'); return; }
  if (!confirm(`確定要清除全部 ${records.length} 筆記錄嗎？此動作無法復原，建議先匯出備份。`)) return;
  records = [];
  commit();
  toast('已清除所有記錄');
});

// 圖表隨寬度重繪
let lastW = 0;
new ResizeObserver((entries) => {
  const w = Math.round(entries[0].contentRect.width);
  if (w && w !== lastW && state.view === 'trend') { lastW = w; renderTrend(); }
}).observe($('#chart'));

// 回到 App 時（例如隔天打開）更新提醒與日曆
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });

/* ================= 啟動 ================= */
syncThemeColor();
renderAll();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
