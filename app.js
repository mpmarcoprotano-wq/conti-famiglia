'use strict';

const APP_VERSION = '1.2.0';
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
  markPending(list.map(r => r.id));
}

// Per-device preferences (not synced): who uses this phone, last backup date, sync keys.
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
  who: '',            // '' = everyone; shared by Riepilogo, Movimenti and Andamento
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

// Everyone who registered expenses, plus whoever uses this phone.
function people() {
  return [...new Set([pref.get('name'), ...expenses().map(e => e.who)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

const byWho = list => ui.who ? list.filter(e => e.who === ui.who) : list;

function whoFilterHTML() {
  const names = people();
  if (names.length < 2 && !ui.who) return '';
  return `<div class="seg" role="group" aria-label="Persona">${['', ...names].map(w =>
    `<button data-action="who" data-value="${esc(w)}" aria-pressed="${ui.who === w}">${w ? esc(w) : 'Tutti'}</button>`).join('')}</div>`;
}

// "Marco 50,00 € · Laura 30,00 €" when looking at everyone's expenses together.
function perPersonHTML(list) {
  if (ui.who) return '';
  const totals = new Map();
  list.forEach(e => { const w = e.who || 'Non indicato'; totals.set(w, (totals.get(w) || 0) + e.amount); });
  if (totals.size < 2) return '';
  return [...totals].sort((a, b) => b[1] - a[1]).map(([w, v]) => `${esc(w)} ${fmt(v)}`).join(' · ');
}

// With one person selected the budget is still the family's, so show their share of it.
function shareHTML(spent, budget) {
  if (!ui.who) return statusHTML(spent, budget);
  if (!budget) return '<span class="muted">Nessun budget</span>';
  return `<span class="muted">${Math.round(spent / budget * 100)}% del budget di famiglia</span>`;
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
  if (!sync) {
    out.push(`<div class="banner"><span>Attiva la sincronizzazione per vedere subito le spese dell'altro iPhone.</span>
      <button class="btn" data-action="go" data-view="settings">Attiva</button></div>`);
  }
  return out.join('');
}

/* ---------- Riepilogo ---------- */

function renderSummary() {
  const p = periodRange(ui.period, ui.ref);
  const exps = byWho(expensesBetween(p.from, p.to));
  const spent = sumByCat(exps);
  const split = perPersonHTML(exps);
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
    ${sync ? `<p class="sync-badge" id="sync-badge">${syncStatusHTML()}</p>` : ''}
    ${bannersHTML()}
    <div class="seg">${seg}</div>
    ${whoFilterHTML()}
    ${navHTML('summary-shift', p.label)}
    ${isCurrent ? '' : '<div class="today-link"><button class="link" data-action="summary-today">Torna a oggi</button></div>'}
    <section class="card hero">
      <div class="label">${ui.who ? 'Speso da ' + esc(ui.who) : 'Speso in totale'}</div>
      <div class="big num">${fmt(totSpent)}</div>
      ${split ? `<div class="sub num">${split}</div>` : ''}
      <div class="sub">${totBud ? `su ${fmt(totBud)} di budget${ui.who ? ' di famiglia' : ''}` : 'Nessun budget per questo periodo'}</div>
      ${progressHTML(totSpent, totBud, elapsed)}
      <div class="sub">${shareHTML(totSpent, totBud)}</div>
      ${elapsed != null ? '<p class="hint">La tacca nera indica a che punto del periodo sei oggi: se la barra la supera, stai spendendo più del previsto.</p>' : ''}
    </section>
    <section class="card">
      <h2>Per categoria</h2>
      ${rows.length ? rows.map(r => `
        <div class="row">
          <div class="row-head"><span>${esc(r.cat.icon)} ${esc(r.cat.name)}</span>
            <span class="num">${fmt(r.spent)}${r.budget ? `<small> / ${fmt(r.budget)}</small>` : ''}</span></div>
          ${progressHTML(r.spent, r.budget, null)}
          <div class="row-foot">${shareHTML(r.spent, r.budget)}</div>
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
  let list = byWho(expensesBetween(from, to));
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
    ${whoFilterHTML()}
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
  const names = people();

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
      <datalist id="people">${names.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
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

function tipHTML(title, spent, budget, items) {
  const split = items ? perPersonHTML(items) : '';
  return `<b>${esc(title)}</b><br>Speso: ${fmt(spent)}` + (split ? `<br>${split}` : '') +
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
  const list = byWho(cat ? expenses().filter(e => e.catId === cat) : expenses());
  const annual = cat ? budgetFor(y, cat) : totalBudget(y);
  const monthBudget = Math.round(annual / 12);

  const months = MONTHS.map((name, m) => {
    const from = isoDate(new Date(y, m, 1)), to = isoDate(new Date(y, m + 1, 1));
    const items = list.filter(e => e.date >= from && e.date < to);
    const value = sum(items.map(e => e.amount));
    return { label: MONTHS_SHORT[m], value, tip: tipHTML(`${name} ${y}`, value, monthBudget, items), name };
  });
  const yearSpent = sum(months.map(b => b.value));

  const thisWeek = startOfWeek(new Date());
  const weekYear = thisWeek.getFullYear();
  const weekBudget = Math.round((cat ? budgetFor(weekYear, cat) : totalBudget(weekYear)) / 52);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = addDays(thisWeek, -7 * i);
    const from = isoDate(s), to = isoDate(addDays(s, 7));
    const items = list.filter(e => e.date >= from && e.date < to);
    const value = sum(items.map(e => e.amount));
    weeks.push({ label: `${s.getDate()}/${s.getMonth() + 1}`, value,
      tip: tipHTML(`Settimana dal ${shortDay(s)}`, value, weekBudget, items) });
  }

  const key = budget => `<div class="key"><span><i class="sw"></i>Speso</span>${budget ? `<span><i class="dash"></i>Budget ${fmt(budget)}</span>` : ''}</div>`;

  $('#view-trend').innerHTML = `
    <h1>Andamento</h1>
    ${whoFilterHTML()}
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

    ${syncCardHTML()}

    <section class="card">
      <h2>Backup</h2>
      <p class="hint" style="margin-top:0">Una copia di sicurezza su file, da salvare in iCloud Drive o sul computer.
        Con <b>Importa</b> la recuperi in qualsiasi momento: le spese vengono unite senza doppioni.</p>
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
  markPending(incoming.map(r => r.id));
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

/* ---------- Sync ----------
   Records are encrypted on the phone (AES-GCM) with a key derived from the
   family password, then stored in a Firebase Realtime Database through its
   REST API. The server only ever sees ciphertext: record ids are HMAC'd and
   the family folder name is derived from the password too, so the two
   phones find each other just by typing the same password. */

const SYNC_INTERVAL = 15000;
const SYNC_SALT = 'conti-famiglia/sync/v1';
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

let sync = null;          // { url, fid, aes: CryptoKey, mac: CryptoKey }
let syncState = { busy: false, ok: true, error: '' };
let syncTimer, syncAgain = false;

const pending = new Set((() => { try { return JSON.parse(pref.get('syncPending', '[]')); } catch { return []; } })());
const savePending = () => pref.set('syncPending', JSON.stringify([...pending]));

function markPending(ids) {
  if (!sync) return;
  ids.forEach(id => pending.add(id));
  savePending();
  scheduleSync();
}

function b64(bytes) {
  let s = '';
  new Uint8Array(bytes).forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

async function deriveSyncKeys(password) {
  const base = await crypto.subtle.importKey('raw', textEnc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: textEnc.encode(SYNC_SALT), iterations: 310000 }, base, 768));
  return { aes: b64(bits.slice(0, 32)), mac: b64(bits.slice(32, 64)), fid: hex(bits.slice(64, 96)) };
}

async function loadSync() {
  let cfg = null;
  try { cfg = JSON.parse(pref.get('sync') || 'null'); } catch { cfg = null; }
  if (!cfg || !crypto.subtle) { sync = null; return; }
  sync = {
    url: cfg.url,
    fid: cfg.fid,
    aes: await crypto.subtle.importKey('raw', unb64(cfg.aes), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', unb64(cfg.mac), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}

const familyCode = fid => fid.slice(0, 6).toUpperCase().replace(/^(...)/, '$1-');
const remoteBase = () => `${sync.url}/f/${sync.fid}/r`;

async function remoteKey(id) {
  return hex(await crypto.subtle.sign('HMAC', sync.mac, textEnc.encode(id))).slice(0, 40);
}

async function encryptRecord(r) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sync.aes, textEnc.encode(JSON.stringify(r)));
  return { d: b64(data), iv: b64(iv) };
}

async function decryptRecord(v) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, sync.aes, unb64(v.d));
  return JSON.parse(textDec.decode(data));
}

async function request(url, options) {
  let res;
  try { res = await fetch(url, options); } catch { throw new Error(navigator.onLine ? 'server non raggiungibile' : 'offline'); }
  if (res.status === 401 || res.status === 403) throw new Error('accesso negato: controlla le regole del database');
  if (!res.ok) throw new Error('errore del server ' + res.status);
  return res.json();
}

async function pushPending() {
  const ids = [...pending];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(id => records.get(id)).filter(Boolean);
    const body = {};
    for (const r of chunk) body[await remoteKey(r.id)] = { u: { '.sv': 'timestamp' }, ...(await encryptRecord(r)) };
    if (chunk.length) await request(remoteBase() + '.json', { method: 'PATCH', body: JSON.stringify(body) });
    // Keep the id pending if it was edited again while we were uploading.
    chunk.forEach(r => { if (records.get(r.id) === r) pending.delete(r.id); });
    ids.slice(i, i + 100).forEach(id => { if (!records.has(id)) pending.delete(id); });
    savePending();
  }
}

async function pull() {
  const cursor = Number(pref.get('syncCursor', 0));
  // Re-read a few minutes back: harmless (merge is idempotent) and covers in-flight writes.
  const query = cursor ? `?orderBy=%22u%22&startAt=${cursor - 300000}` : '';
  const data = (await request(remoteBase() + '.json' + query)) || {};
  let max = cursor;
  const changed = [];
  for (const v of Object.values(data)) {
    if (!v || !v.d || !v.iv) continue;
    max = Math.max(max, v.u || 0);
    let r;
    try { r = await decryptRecord(v); } catch { continue; }
    const local = records.get(r.id);
    if (!local || (r.updatedAt || 0) > (local.updatedAt || 0)) { records.set(r.id, r); changed.push(r); }
  }
  if (changed.length) await dbPut(changed);
  pref.set('syncCursor', max);
  return changed;
}

function scheduleSync(delay = 400) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!sync) return;
  if (syncState.busy) { syncAgain = true; return; }
  syncState = { busy: true, ok: syncState.ok, error: syncState.error };
  updateSyncStatus();
  let changed = [];
  try {
    await pushPending();
    changed = await pull();
    syncState = { busy: false, ok: true, error: '' };
    pref.set('syncLast', Date.now());
  } catch (e) {
    syncState = { busy: false, ok: false, error: e.message };
  }
  if (changed.length) onRemoteChanges(changed);
  updateSyncStatus();
  if (syncAgain) { syncAgain = false; scheduleSync(0); }
}

function onRemoteChanges(changed) {
  const me = pref.get('name');
  const fromOthers = changed.filter(r => r.type === 'expense' && r.who && r.who !== me);
  if (fromOthers.length) {
    const names = [...new Set(fromOthers.map(r => r.who))].join(' e ');
    toast(fromOthers.length === 1 ? `Nuova spesa da ${names}` : `${fromOthers.length} aggiornamenti da ${names}`);
  }
  // Don't redraw under the user's fingers: the sheet or a settings field being edited.
  const editing = !$('#sheet').hidden || (ui.view === 'settings' && document.activeElement && document.activeElement.matches('input, select'));
  if (!editing) refresh();
}

function syncStatusHTML() {
  if (!sync) return '';
  if (syncState.busy) return '<span class="muted">🔄 Sincronizzazione…</span>';
  const waiting = pending.size ? ` · ${pending.size} ${pending.size === 1 ? 'modifica' : 'modifiche'} in attesa` : '';
  if (!syncState.ok) return `<span class="warn">⚠ Non sincronizzato (${esc(syncState.error)})${waiting}</span>`;
  const last = Number(pref.get('syncLast', 0));
  return `<span class="muted">✓ Sincronizzato${last ? ' alle ' + new Date(last).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : ''}${waiting}</span>`;
}

function updateSyncStatus() {
  document.querySelectorAll('#sync-badge, #sync-status').forEach(el => { el.innerHTML = syncStatusHTML(); });
}

function syncCardHTML() {
  if (sync) {
    return `<section class="card">
      <h2>Sincronizzazione automatica</h2>
      <p id="sync-status">${syncStatusHTML()}</p>
      <p class="hint">Codice famiglia: <b class="num">${familyCode(sync.fid)}</b><br>
        Deve essere uguale sui due iPhone: se è diverso, la password inserita non è la stessa.</p>
      <div class="btns" style="margin-top:12px">
        <button class="btn" data-action="sync-now">Sincronizza ora</button>
        <button class="btn secondary" data-action="sync-off">Disattiva</button>
      </div>
    </section>`;
  }
  return `<section class="card">
    <h2>Sincronizzazione automatica</h2>
    <p class="hint" style="margin-top:0">Le spese inserite su un iPhone compaiono sull'altro dopo pochi secondi.
      Tutto viene cifrato sul telefono con la password di famiglia: il server vede solo dati illeggibili.</p>
    <form id="sync-form" autocomplete="off">
      <label class="full">Indirizzo del database<input class="field" name="url" inputmode="url" autocapitalize="off" spellcheck="false"
        placeholder="https://….firebasedatabase.app" value="${esc(pref.get('syncUrl'))}"></label>
      <label class="full">Password di famiglia<input class="field" name="pw" type="password" autocomplete="new-password"></label>
      <label class="full">Ripeti la password<input class="field" name="pw2" type="password" autocomplete="new-password"></label>
      <p class="err" id="sync-err"></p>
      <button class="btn block" type="submit">Attiva sincronizzazione</button>
    </form>
    <p class="hint">Usate la stessa identica password su entrambi gli iPhone (almeno 10 caratteri).
      Non si può recuperare: scrivetela in un posto sicuro.</p>
  </section>`;
}

async function enableSync(form) {
  const err = $('#sync-err');
  const url = form.url.value.trim().replace(/\/+$/, '');
  const pw = form.pw.value;
  if (!/^https:\/\/[a-z0-9.-]+\.(firebasedatabase\.app|firebaseio\.com)$/i.test(url) && !/^http:\/\/localhost:\d+$/.test(url)) {
    err.textContent = "L'indirizzo deve essere quello del database Firebase (…firebasedatabase.app).";
    return;
  }
  if (pw.length < 10) { err.textContent = 'La password deve avere almeno 10 caratteri.'; return; }
  if (pw !== form.pw2.value) { err.textContent = 'Le due password non coincidono.'; return; }
  if (!crypto.subtle) { err.textContent = "La cifratura non è disponibile: apri l'app dall'indirizzo https."; return; }

  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = 'Attivazione…';
  err.textContent = '';
  try {
    const keys = await deriveSyncKeys(pw);
    await request(`${url}/f/${keys.fid}/r.json?shallow=true`);
    pref.set('syncUrl', url);
    pref.set('sync', JSON.stringify({ url, ...keys }));
    pref.set('syncCursor', 0);
    await loadSync();
    markPending([...records.keys()]);
    await runSync();
    renderSettings();
    toast('Sincronizzazione attivata');
  } catch (e) {
    err.textContent = 'Attivazione non riuscita: ' + e.message + '.';
    button.disabled = false;
    button.textContent = 'Attiva sincronizzazione';
  }
}

function disableSync() {
  if (!confirm('Disattivare la sincronizzazione su questo iPhone? I dati restano sul telefono.')) return;
  sync = null;
  pending.clear();
  savePending();
  pref.set('sync', '');
  pref.set('syncCursor', 0);
  renderSettings();
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
      case 'close': closeEditor(); refresh(); break;
      case 'sync-now': scheduleSync(0); break;
      case 'sync-off': disableSync(); break;
      case 'delete-expense': deleteExpense(); break;
      case 'period': ui.period = el.dataset.value; renderSummary(); break;
      case 'who': ui.who = el.dataset.value; refresh(); break;
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
    if (ev.target.id === 'sync-form') { ev.preventDefault(); enableSync(ev.target); }
  });

  $('#sheet').addEventListener('click', ev => { if (ev.target.id === 'sheet') { closeEditor(); refresh(); } });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(0); });
  window.addEventListener('online', () => scheduleSync(0));
  setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, SYNC_INTERVAL);
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
  await loadSync();
  bindEvents();
  show('summary');
  scheduleSync(0);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

init();
