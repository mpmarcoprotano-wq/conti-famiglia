'use strict';

const APP_VERSION = '1.0.0';
const DB_NAME = 'conti-famiglia';
const STORE = 'records';

const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const DAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

// Default categories have fixed ids so two phones that start from scratch
// produce the same records and merge cleanly.
const DEFAULT_CATEGORIES = [
  ['spesa', '🛒', 'Spesa'],
  ['bollette', '💡', 'Bollette'],
  ['mutuo', '🏠', 'Mutuo / Affitto'],
  ['trasporti', '🚗', 'Auto e trasporti'],
  ['salute', '💊', 'Salute'],
  ['casa', '🛋️', 'Casa'],
  ['ristoranti', '🍕', 'Ristoranti'],
  ['svago', '🎉', 'Svago'],
  ['abbigliamento', '👕', 'Abbigliamento'],
  ['vacanze', '🏖️', 'Vacanze'],
  ['regali', '🎁', 'Regali'],
  ['altro', '📦', 'Altro'],
];

/* ---------- Storage ----------
   Every piece of data is a record {id, type, updatedAt, deleted?, ...}
   of type 'category', 'budget' or 'expense'. Deletions are kept as
   tombstones so they survive a merge with the other phone's backup. */

const records = new Map();
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    list.forEach(r => store.put(r));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function save(...list) {
  const now = Date.now();
  list.forEach(r => { r.updatedAt = now; records.set(r.id, r); });
  await dbPut(list);
}

// Per-device preferences (not synced): who uses this phone, last backup date.
const pref = {
  get(key, fallback = '') {
    try { return localStorage.getItem('cf-' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cf-' + key, value); } catch { /* storage unavailable */ }
  },
};

/* ---------- Data helpers ---------- */

const live = type => [...records.values()].filter(r => r.type === type && !r.deleted);
const categories = () => live('category').sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
const expenses = () => live('expense');
const expensesBetween = (from, to) => expenses().filter(e => e.date >= from && e.date < to);
const sum = list => list.reduce((a, b) => a + b, 0);

function budgetFor(year, catId) {
  const b = records.get(`b-${year}-${catId}`);
  return b && !b.deleted ? b.amount : 0;
}

function totalBudget(year) {
  return sum(categories().map(c => budgetFor(year, c.id)));
}

function catInfo(id) {
  const c = records.get(id);
  if (!c) return { id, icon: '❔', name: 'Senza categoria', order: 999 };
  if (c.deleted) return { ...c, name: c.name + ' (eliminata)', order: 998 };
  return c;
}

function sumByCat(list) {
  const m = new Map();
  list.forEach(e => m.set(e.catId, (m.get(e.catId) || 0) + e.amount));
  return m;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- Formatting ---------- */

const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const eurRound = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = cents => eur.format(cents / 100);
const fmtRound = cents => eurRound.format(Math.round(cents / 100));

function fmtAxis(cents) {
  const v = cents / 100;
  if (v >= 1000) return (v / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + 'k';
  return v.toLocaleString('it-IT', { maximumFractionDigits: 0 });
}

// "12,50" / "12.50" / "1.200" / "1.200,50" / "€ 8" -> cents
function parseCents(str) {
  let s = String(str ?? '').replace(/[\s€]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

const centsToInput = cents => cents ? (cents / 100).toLocaleString('it-IT', { minimumFractionDigits: cents % 100 ? 2 : 0, useGrouping: false }) : '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Dates (always local time, stored as YYYY-MM-DD) ---------- */

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - (x.getDay() + 6) % 7); // weeks start on Monday
  return x;
}

const shortDay = d => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;

function periodRange(kind, ref) {
  if (kind === 'week') {
    const s = startOfWeek(ref);
    const last = addDays(s, 6);
    return { from: isoDate(s), to: isoDate(addDays(s, 7)), year: s.getFullYear(), factor: 1 / 52,
      label: `${shortDay(s)} – ${shortDay(last)} ${last.getFullYear()}` };
  }
  if (kind === 'month') {
    const y = ref.getFullYear(), m = ref.getMonth();
    return { from: isoDate(new Date(y, m, 1)), to: isoDate(new Date(y, m + 1, 1)), year: y, factor: 1 / 12,
      label: `${MONTHS[m]} ${y}` };
  }
  const y = ref.getFullYear();
  return { from: `${y}-01-01`, to: `${y + 1}-01-01`, year: y, factor: 1, label: String(y) };
}

/* ---------- UI state ---------- */

const now = new Date();
const ui = {
  view: 'summary',
  period: 'month',
  ref: now,
  listMonth: { y: now.getFullYear(), m: now.getMonth() },
  listCat: '',
  trendYear: now.getFullYear(),
  trendCat: '',
  budgetYear: now.getFullYear(),
};

const $ = sel => document.querySelector(sel);
const views = { summary: renderSummary, list: renderList, trend: renderTrend, settings: renderSettings };

function show(name) {
  ui.view = name;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  document.querySelectorAll('.tab[data-view]').forEach(t => t.setAttribute('aria-current', t.dataset.view === name ? 'page' : 'false'));
  views[name]();
  window.scrollTo(0, 0);
}

const refresh = () => views[ui.view]();

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- Shared pieces ---------- */

function progressHTML(spent, budget, marker) {
  const over = budget > 0 && spent > budget;
  const pct = budget > 0 ? Math.min(spent / budget, 1) * 100 : (spent ? 100 : 0);
  const cls = over ? 'over' : budget ? '' : 'nobudget';
  const tick = marker != null ? `<i style="left:${(marker * 100).toFixed(1)}%"></i>` : '';
  return `<div class="bar ${cls}"><span style="width:${pct.toFixed(1)}%"></span>${tick}</div>`;
}

function statusHTML(spent, budget) {
  if (!budget) return '<span class="muted">Nessun budget</span>';
  const d = budget - spent;
  return d >= 0 ? `<span class="muted">Restano ${fmt(d)}</span>` : `<span class="warn">⚠ Oltre il budget di ${fmt(-d)}</span>`;
}

function navHTML(action, label) {
  return `<div class="pnav">
    <button class="arrow" data-action="${action}" data-dir="-1" aria-label="Precedente">‹</button>
    <strong>${label}</strong>
    <button class="arrow" data-action="${action}" data-dir="1" aria-label="Successivo">›</button>
  </div>`;
}

function catOptions(selected) {
  return `<option value="">Tutte le categorie</option>` + categories()
    .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('');
}

function bannersHTML() {
  const out = [];
  if (!pref.get('name')) {
    out.push(`<div class="banner"><span>Come ti chiami? Serve per sapere chi ha registrato ogni spesa.</span>
      <button class="btn" data-action="go" data-view="settings">Imposta</button></div>`);
  }
  if (!totalBudget(new Date().getFullYear())) {
    out.push(`<div class="banner"><span>Non hai ancora impostato il budget del ${new Date().getFullYear()}.</span>
      <button class="btn" data-action="go" data-view="settings">Imposta</button></div>`);
  }
  const last = Number(pref.get('lastExport', 0));
  const days = Math.floor((Date.now() - last) / 864e5);
  if (expenses().length && days >= 7) {
    out.push(`<div class="banner"><span>${last ? `Ultimo backup ${days} giorni fa.` : 'Non hai mai fatto un backup.'} Esportalo per sincronizzarti con l'altro iPhone.</span>
      <button class="btn" data-action="export">Esporta</button></div>`);
  }
  return out.join('');
}

/* ---------- Riepilogo ---------- */

function renderSummary() {
  const p = periodRange(ui.period, ui.ref);
  const spent = sumByCat(expensesBetween(p.from, p.to));
  const ids = new Set([...categories().map(c => c.id), ...spent.keys()]);
  const rows = [...ids]
    .map(id => ({ cat: catInfo(id), spent: spent.get(id) || 0, budget: Math.round(budgetFor(p.year, id) * p.factor) }))
    .filter(r => r.spent || r.budget)
    .sort((a, b) => a.cat.order - b.cat.order);
  const totSpent = sum(rows.map(r => r.spent));
  const totBud = sum(rows.map(r => r.budget));
  const t = today();
  const isCurrent = p.from <= t && t < p.to;
  const elapsed = isCurrent && totBud ? (daysBetween(p.from, t) + 1) / daysBetween(p.from, p.to) : null;

  const seg = [['week', 'Settimana'], ['month', 'Mese'], ['year', 'Anno']]
    .map(([k, l]) => `<button data-action="period" data-value="${k}" aria-pressed="${ui.period === k}">${l}</button>`).join('');

  $('#view-summary').innerHTML = `
    <h1>Riepilogo</h1>
    ${bannersHTML()}
    <div class="seg">${seg}</div>
    ${navHTML('summary-shift', p.label)}
    ${isCurrent ? '' : '<div class="today-link"><button class="link" data-action="summary-today">Torna a oggi</button></div>'}
    <section class="card hero">
      <div class="label">Speso</div>
      <div class="big num">${fmt(totSpent)}</div>
      <div class="sub">${totBud ? `su ${fmt(totBud)} di budget` : 'Nessun budget per questo periodo'}</div>
      ${progressHTML(totSpent, totBud, elapsed)}
      <div class="sub">${statusHTML(totSpent, totBud)}</div>
      ${elapsed != null ? '<p class="hint">La tacca nera indica a che punto del periodo sei oggi: se la barra la supera, stai spendendo più del previsto.</p>' : ''}
    </section>
    <section class="card">
      <h2>Per categoria</h2>
      ${rows.length ? rows.map(r => `
        <div class="row">
          <div class="row-head"><span>${esc(r.cat.icon)} ${esc(r.cat.name)}</span>
            <span class="num">${fmt(r.spent)}${r.budget ? `<small> / ${fmt(r.budget)}</small>` : ''}</span></div>
          ${progressHTML(r.spent, r.budget, null)}
          <div class="row-foot">${statusHTML(r.spent, r.budget)}</div>
        </div>`).join('') : '<p class="empty">Nessuna spesa in questo periodo.<br>Tocca + per aggiungerne una.</p>'}
    </section>`;
}

function shiftSummary(dir) {
  const r = new Date(ui.ref);
  if (ui.period === 'week') r.setDate(r.getDate() + 7 * dir);
  else if (ui.period === 'month') { r.setDate(1); r.setMonth(r.getMonth() + dir); }
  else r.setFullYear(r.getFullYear() + dir);
  ui.ref = r;
}

/* ---------- Movimenti ---------- */

function renderList() {
  const { y, m } = ui.listMonth;
  const from = isoDate(new Date(y, m, 1));
  const to = isoDate(new Date(y, m + 1, 1));
  let list = expensesBetween(from, to);
  if (ui.listCat) list = list.filter(e => e.catId === ui.listCat);
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));

  const days = new Map();
  list.forEach(e => { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); });

  const body = [...days].map(([date, items]) => {
    const d = parseDate(date);
    return `<div class="day"><span>${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].toLowerCase()}</span>
        <span class="num">${fmt(sum(items.map(e => e.amount)))}</span></div>
      <div class="items">${items.map(e => {
        const c = catInfo(e.catId);
        return `<button class="item" data-action="edit" data-id="${e.id}">
          <span class="ico">${esc(c.icon)}</span>
          <span class="txt"><b>${esc(e.note || c.name)}</b><small>${esc(c.name)}${e.who ? ' · ' + esc(e.who) : ''}</small></span>
          <span class="num">${fmt(e.amount)}</span></button>`;
      }).join('')}</div>`;
  }).join('');

  $('#view-list').innerHTML = `
    <h1>Movimenti</h1>
    ${navHTML('list-shift', `${MONTHS[m]} ${y}`)}
    <select class="filter" id="list-cat" aria-label="Filtra per categoria">${catOptions(ui.listCat)}</select>
    <div class="month-total"><span class="muted">${list.length} ${list.length === 1 ? 'spesa' : 'spese'}</span><b class="num">${fmt(sum(list.map(e => e.amount)))}</b></div>
    ${body || '<p class="empty">Nessuna spesa in questo mese.</p>'}`;
}

/* ---------- Editor (bottom sheet) ---------- */

function openEditor(id) {
  const e = id ? records.get(id) : null;
  const cats = categories();
  if (e && !cats.some(c => c.id === e.catId)) cats.push(catInfo(e.catId));
  const selected = e ? e.catId : pref.get('lastCat');
  const name = pref.get('name');
  const people = [...new Set([name, ...expenses().map(x => x.who)].filter(Boolean))];

  const sheet = $('#sheet .sheet');
  sheet.innerHTML = `
    <form id="expense-form" autocomplete="off">
      <div class="sheet-head">
        <button type="button" class="link" data-action="close">Annulla</button>
        <h2 id="sheet-title">${e ? 'Modifica spesa' : 'Nuova spesa'}</h2>
        <button type="submit" class="link">Salva</button>
      </div>
      <input class="amount" name="amount" inputmode="decimal" placeholder="0,00 €" value="${e ? centsToInput(e.amount) : ''}" aria-label="Importo in euro">
      <div class="chips" role="radiogroup" aria-label="Categoria">
        ${cats.map(c => `<label class="chip"><input type="radio" name="cat" value="${c.id}" ${c.id === selected ? 'checked' : ''}>
          <span><em>${esc(c.icon)}</em>${esc(c.name)}</span></label>`).join('')}
      </div>
      <div class="form-grid">
        <label>Data<input class="field" type="date" name="date" value="${e ? e.date : today()}" required></label>
        <label>Chi ha pagato<input class="field" name="who" list="people" value="${esc(e ? e.who : name)}"></label>
      </div>
      <datalist id="people">${people.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      <label class="full">Nota (facoltativa)<input class="field" name="note" value="${esc(e ? e.note : '')}" placeholder="Es. Esselunga, bolletta luce…"></label>
      <p class="err" id="form-err"></p>
      <button type="submit" class="btn block">Salva</button>
      ${e ? '<button type="button" class="btn danger block" data-action="delete-expense">Elimina spesa</button>' : ''}
    </form>`;
  sheet.dataset.id = id || '';
  $('#sheet').hidden = false;
  if (!e) sheet.querySelector('.amount').focus();
}

function closeEditor() {
  $('#sheet').hidden = true;
  $('#sheet .sheet').innerHTML = '';
}

async function submitExpense(form) {
  const fd = new FormData(form);
  const amount = parseCents(fd.get('amount'));
  const err = $('#form-err');
  if (!(amount > 0)) { err.textContent = 'Inserisci un importo valido.'; return; }
  const catId = fd.get('cat');
  if (!catId) { err.textContent = 'Scegli una categoria.'; return; }
  const id = $('#sheet .sheet').dataset.id;
  const rec = id ? { ...records.get(id) } : { id: uid(), type: 'expense', createdAt: Date.now() };
  Object.assign(rec, {
    amount, catId,
    date: fd.get('date') || today(),
    note: String(fd.get('note')).trim(),
    who: String(fd.get('who')).trim(),
  });
  await save(rec);
  pref.set('lastCat', catId);
  closeEditor();
  refresh();
  toast(id ? 'Spesa aggiornata' : 'Spesa salvata');
}

async function deleteExpense() {
  const id = $('#sheet .sheet').dataset.id;
  if (!id || !confirm('Eliminare questa spesa?')) return;
  await save({ ...records.get(id), deleted: true });
  closeEditor();
  refresh();
  toast('Spesa eliminata');
}

/* ---------- Andamento ---------- */

const chartTips = {};

function niceStep(raw) {
  const exp = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= raw) return m * exp;
  return 10 * exp;
}

function barChart(id, bars, ref) {
  const W = 340, H = 200, L = 34, R = 6, T = 12, B = 22, TICKS = 4;
  const peak = Math.max(ref || 0, ...bars.map(b => b.value), 10000);
  const step = niceStep(peak / TICKS);
  const max = step * TICKS;
  const pw = W - L - R, ph = H - T - B;
  const band = pw / bars.length;
  const bw = Math.min(band - 4, 20);
  const y = v => T + ph - (v / max) * ph;

  let svg = '';
  for (let i = 1; i <= TICKS; i++) {
    const v = step * i;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmtAxis(v)}</text>`;
  }
  svg += `<text class="tick" x="${L - 6}" y="${y(0) + 3.5}" text-anchor="end">0</text>`;
  const longest = Math.max(...bars.map(b => b.label.length));
  const labelEvery = band < longest * 6 + 4 ? 2 : 1;
  bars.forEach((b, i) => {
    const cx = L + band * i + band / 2;
    const x = cx - bw / 2;
    const h = (b.value / max) * ph;
    if (h > 0) {
      const r = Math.min(4, bw / 2, h);
      const top = y(b.value), base = y(0);
      svg += `<path class="b" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z"/>`;
    } else {
      svg += '<path class="b" d=""/>';
    }
    if (i % labelEvery === 0) svg += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  svg += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (ref) svg += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>`;
  bars.forEach((b, i) => {
    svg += `<rect class="hit" data-action="tip" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ph + B}"/>`;
  });

  chartTips[id] = bars.map(b => b.tip);
  return `<div class="chart" id="${id}"><div class="tip" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafico a barre">${svg}</svg></div>`;
}

function tipHTML(title, spent, budget) {
  return `<b>${esc(title)}</b><br>Speso: ${fmt(spent)}` +
    (budget ? `<br>Budget: ${fmt(budget)}<br>${spent > budget ? `⚠ Oltre di ${fmt(spent - budget)}` : `Restano ${fmt(budget - spent)}`}` : '');
}

function showTip(hit) {
  const chart = hit.closest('.chart');
  const i = Number(hit.dataset.i);
  const tip = chart.querySelector('.tip');
  tip.innerHTML = chartTips[chart.id][i];
  tip.hidden = false;
  const cr = chart.getBoundingClientRect();
  const hr = hit.getBoundingClientRect();
  const center = hr.left - cr.left + hr.width / 2;
  const left = Math.max(0, Math.min(center - tip.offsetWidth / 2, cr.width - tip.offsetWidth));
  tip.style.left = left + 'px';
  chart.querySelectorAll('.b').forEach((b, j) => b.classList.toggle('dim', j !== i));
}

function hideTips() {
  document.querySelectorAll('.chart .tip').forEach(t => { t.hidden = true; });
  document.querySelectorAll('.chart .b.dim').forEach(b => b.classList.remove('dim'));
}

function renderTrend() {
  const y = ui.trendYear;
  const cat = ui.trendCat;
  const list = cat ? expenses().filter(e => e.catId === cat) : expenses();
  const annual = cat ? budgetFor(y, cat) : totalBudget(y);
  const monthBudget = Math.round(annual / 12);

  const months = MONTHS.map((name, m) => {
    const from = isoDate(new Date(y, m, 1)), to = isoDate(new Date(y, m + 1, 1));
    const value = sum(list.filter(e => e.date >= from && e.date < to).map(e => e.amount));
    return { label: MONTHS_SHORT[m], value, tip: tipHTML(`${name} ${y}`, value, monthBudget), name };
  });
  const yearSpent = sum(months.map(b => b.value));

  const thisWeek = startOfWeek(new Date());
  const weekYear = thisWeek.getFullYear();
  const weekBudget = Math.round((cat ? budgetFor(weekYear, cat) : totalBudget(weekYear)) / 52);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = addDays(thisWeek, -7 * i);
    const from = isoDate(s), to = isoDate(addDays(s, 7));
    const value = sum(list.filter(e => e.date >= from && e.date < to).map(e => e.amount));
    weeks.push({ label: `${s.getDate()}/${s.getMonth() + 1}`, value,
      tip: tipHTML(`Settimana dal ${shortDay(s)}`, value, weekBudget) });
  }

  const key = budget => `<div class="key"><span><i class="sw"></i>Speso</span>${budget ? `<span><i class="dash"></i>Budget ${fmt(budget)}</span>` : ''}</div>`;

  $('#view-trend').innerHTML = `
    <h1>Andamento</h1>
    <select class="filter" id="trend-cat" aria-label="Categoria">${catOptions(cat)}</select>
    ${navHTML('trend-shift', String(y))}
    <section class="card">
      <h2>Spese mensili</h2>
      <p class="hint" style="margin:-6px 0 10px">Totale ${y}: <b class="num">${fmt(yearSpent)}</b>${annual ? ` su ${fmt(annual)} di budget annuale` : ''}</p>
      ${key(monthBudget)}
      ${barChart('chart-months', months, monthBudget)}
      <details>
        <summary>Mostra la tabella</summary>
        <table>
          <thead><tr><th>Mese</th><th>Speso</th><th>Budget</th><th>Diff.</th></tr></thead>
          <tbody>${months.map(b => `<tr><td>${b.name}</td><td>${fmtRound(b.value)}</td><td>${monthBudget ? fmtRound(monthBudget) : '–'}</td>
            <td>${monthBudget ? (b.value > monthBudget ? '⚠ +' + fmtRound(b.value - monthBudget) : '−' + fmtRound(monthBudget - b.value)) : '–'}</td></tr>`).join('')}</tbody>
        </table>
      </details>
    </section>
    <section class="card">
      <h2>Ultime 12 settimane</h2>
      ${key(weekBudget)}
      ${barChart('chart-weeks', weeks, weekBudget)}
    </section>
    <p class="hint" style="text-align:center">Tocca una barra per vedere i dettagli.</p>`;
}

/* ---------- Impostazioni ---------- */

function renderSettings() {
  const y = ui.budgetYear;
  const cats = categories();
  const last = Number(pref.get('lastExport', 0));

  $('#view-settings').innerHTML = `
    <h1>Impostazioni</h1>
    <section class="card">
      <h2>Chi usa questo iPhone</h2>
      <input class="field" id="me" value="${esc(pref.get('name'))}" placeholder="Il tuo nome" autocomplete="given-name">
      <p class="hint">Il nome viene associato alle spese che registri da qui.</p>
    </section>

    <section class="card">
      <h2>Budget annuale</h2>
      ${navHTML('budget-shift', String(y))}
      ${cats.map(c => `<label class="brow"><span>${esc(c.icon)} ${esc(c.name)}</span>
          <input class="field" data-budget="${c.id}" inputmode="decimal" placeholder="0" value="${centsToInput(budgetFor(y, c.id))}">
          <small id="bm-${c.id}">${budgetFor(y, c.id) ? '≈ ' + fmt(Math.round(budgetFor(y, c.id) / 12)) + ' al mese' : ''}</small></label>`).join('')}
      <div class="btotal"><span>Totale ${y}</span><span class="num" id="btotal">${fmt(totalBudget(y))}</span></div>
      <p class="hint" id="btotal-m">≈ ${fmt(Math.round(totalBudget(y) / 12))} al mese · ${fmt(Math.round(totalBudget(y) / 52))} a settimana</p>
      <button class="btn secondary block" data-action="copy-budget">Copia il budget dal ${y - 1}</button>
    </section>

    <section class="card">
      <h2>Categorie</h2>
      ${cats.map(c => `<div class="crow">
          <input class="field" data-cat-icon="${c.id}" value="${esc(c.icon)}" aria-label="Icona">
          <input class="field" data-cat-name="${c.id}" value="${esc(c.name)}" aria-label="Nome categoria">
          <button class="icon-btn" data-action="delete-cat" data-id="${c.id}" aria-label="Elimina ${esc(c.name)}">🗑️</button>
        </div>`).join('')}
      <button class="btn secondary block" data-action="add-cat">+ Aggiungi categoria</button>
      <p class="hint">Per l'icona puoi usare qualsiasi emoji.</p>
    </section>

    <section class="card">
      <h2>Backup e sincronizzazione</h2>
      <p class="hint" style="margin-top:0">I dati sono salvati solo su questo iPhone. Per allinearti con l'altro telefono:
        <b>Esporta</b> e salva il file nella cartella iCloud Drive condivisa, poi dall'altro iPhone tocca <b>Importa</b> e scegli quel file.
        Le spese vengono unite senza doppioni.</p>
      <div class="btns" style="margin-top:12px">
        <button class="btn" data-action="export">Esporta backup</button>
        <button class="btn secondary" data-action="import">Importa backup</button>
      </div>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
      <p class="hint">${last ? 'Ultimo backup esportato: ' + new Date(last).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : 'Nessun backup ancora esportato.'}</p>
    </section>

    <section class="card">
      <h2>Esporta per Excel</h2>
      <button class="btn secondary block" data-action="csv">Esporta le spese del ${y} (CSV)</button>
    </section>

    <p class="ver">Conti di Famiglia v${APP_VERSION}</p>`;
}

function updateBudgetTotals() {
  const y = ui.budgetYear;
  const t = totalBudget(y);
  $('#btotal').textContent = fmt(t);
  $('#btotal-m').textContent = `≈ ${fmt(Math.round(t / 12))} al mese · ${fmt(Math.round(t / 52))} a settimana`;
}

async function setBudget(input) {
  const catId = input.dataset.budget;
  const amount = parseCents(input.value);
  if (Number.isNaN(amount)) { toast('Importo non valido'); input.value = centsToInput(budgetFor(ui.budgetYear, catId)); return; }
  const y = ui.budgetYear;
  await save({ id: `b-${y}-${catId}`, type: 'budget', year: y, catId, amount });
  input.value = centsToInput(amount);
  $('#bm-' + catId).textContent = amount ? '≈ ' + fmt(Math.round(amount / 12)) + ' al mese' : '';
  updateBudgetTotals();
}

async function copyBudget() {
  const y = ui.budgetYear;
  const prev = categories().filter(c => budgetFor(y - 1, c.id));
  if (!prev.length) { toast(`Nessun budget nel ${y - 1}`); return; }
  if (totalBudget(y) && !confirm(`Sovrascrivere il budget del ${y} con quello del ${y - 1}?`)) return;
  await save(...prev.map(c => ({ id: `b-${y}-${c.id}`, type: 'budget', year: y, catId: c.id, amount: budgetFor(y - 1, c.id) })));
  renderSettings();
  toast('Budget copiato');
}

async function addCategory() {
  const name = (prompt('Nome della nuova categoria') || '').trim();
  if (!name) return;
  const order = Math.max(0, ...categories().map(c => c.order)) + 1;
  await save({ id: 'cat-' + uid(), type: 'category', icon: '🏷️', name, order });
  renderSettings();
}

async function deleteCategory(id) {
  const c = records.get(id);
  if (!confirm(`Eliminare la categoria "${c.name}"? Le spese già registrate restano.`)) return;
  await save({ ...c, deleted: true });
  renderSettings();
}

/* ---------- Backup / import / CSV ---------- */

async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

async function exportBackup() {
  const name = pref.get('name');
  const data = { app: 'conti-famiglia', version: 1, exportedAt: new Date().toISOString(), by: name, records: [...records.values()] };
  const filename = `conti-famiglia-${name ? slug(name) + '-' : ''}${today()}.json`;
  const done = await shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), filename);
  if (done) {
    pref.set('lastExport', Date.now());
    refresh();
  }
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'conti-famiglia' || !Array.isArray(data.records)) {
    alert('Questo file non è un backup di Conti di Famiglia.');
    return;
  }
  // Last write wins, record by record.
  const incoming = data.records.filter(r => r && r.id && r.type && (r.updatedAt || 0) > ((records.get(r.id) || {}).updatedAt || 0));
  incoming.forEach(r => records.set(r.id, r));
  await dbPut(incoming);
  const newExpenses = incoming.filter(r => r.type === 'expense').length;
  alert(incoming.length
    ? `Importazione completata${data.by ? ' dal backup di ' + data.by : ''}: ${newExpenses} ${newExpenses === 1 ? 'spesa nuova o modificata' : 'spese nuove o modificate'}` +
      (incoming.length > newExpenses ? `, più ${incoming.length - newExpenses} modifiche a budget e categorie.` : '.')
    : 'Nessuna novità: i dati erano già allineati.');
  refresh();
}

function exportCSV() {
  const y = ui.budgetYear;
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = expensesBetween(`${y}-01-01`, `${y + 1}-01-01`).sort((a, b) => a.date.localeCompare(b.date));
  const lines = ['Data;Categoria;Importo;Nota;Chi'].concat(rows.map(e => {
    const [yy, mm, dd] = e.date.split('-');
    return [`${dd}/${mm}/${yy}`, q(catInfo(e.catId).name), (e.amount / 100).toFixed(2).replace('.', ','), q(e.note), q(e.who)].join(';');
  }));
  shareOrDownload(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `spese-${y}.csv`);
}

/* ---------- Events ---------- */

function bindEvents() {
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-view], [data-action]');
    if (!el || el.dataset.action !== 'tip') hideTips();
    if (!el) return;
    if (el.matches('.tab[data-view]')) { show(el.dataset.view); return; }
    const dir = Number(el.dataset.dir);
    switch (el.dataset.action) {
      case 'go': show(el.dataset.view); break;
      case 'add': openEditor(null); break;
      case 'edit': openEditor(el.dataset.id); break;
      case 'close': closeEditor(); break;
      case 'delete-expense': deleteExpense(); break;
      case 'period': ui.period = el.dataset.value; renderSummary(); break;
      case 'summary-shift': shiftSummary(dir); renderSummary(); break;
      case 'summary-today': ui.ref = new Date(); renderSummary(); break;
      case 'list-shift': {
        const d = new Date(ui.listMonth.y, ui.listMonth.m + dir, 1);
        ui.listMonth = { y: d.getFullYear(), m: d.getMonth() };
        renderList();
        break;
      }
      case 'trend-shift': ui.trendYear += dir; renderTrend(); break;
      case 'budget-shift': ui.budgetYear += dir; renderSettings(); break;
      case 'tip': showTip(el); break;
      case 'copy-budget': copyBudget(); break;
      case 'add-cat': addCategory(); break;
      case 'delete-cat': deleteCategory(el.dataset.id); break;
      case 'export': exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'csv': exportCSV(); break;
    }
  });

  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.id === 'me') pref.set('name', el.value.trim());
    else if (el.id === 'list-cat') { ui.listCat = el.value; renderList(); }
    else if (el.id === 'trend-cat') { ui.trendCat = el.value; renderTrend(); }
    else if (el.id === 'import-file' && el.files[0]) { importBackup(el.files[0]); el.value = ''; }
    else if (el.dataset.budget) setBudget(el);
    else if (el.dataset.catName && el.value.trim()) save({ ...records.get(el.dataset.catName), name: el.value.trim() });
    else if (el.dataset.catIcon && el.value.trim()) save({ ...records.get(el.dataset.catIcon), icon: el.value.trim() });
  });

  document.addEventListener('submit', ev => {
    if (ev.target.id === 'expense-form') { ev.preventDefault(); submitExpense(ev.target); }
  });

  $('#sheet').addEventListener('click', ev => { if (ev.target.id === 'sheet') closeEditor(); });
}

async function init() {
  (await dbAll()).forEach(r => records.set(r.id, r));
  if (![...records.values()].some(r => r.type === 'category')) {
    // updatedAt 1: any edit made on either phone always wins over the defaults.
    const defaults = DEFAULT_CATEGORIES.map(([key, icon, name], i) => ({ id: 'cat-' + key, type: 'category', icon, name, order: i, updatedAt: 1 }));
    defaults.forEach(r => records.set(r.id, r));
    await dbPut(defaults);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  bindEvents();
  show('summary');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

init();
