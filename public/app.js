'use strict';
// GolfBuddy client. One page; the part after # in the address picks the screen.
const TZ = 'America/Los_Angeles';
const HOUR = 3600000;
let S = null;            // everything from /api/state
let installEvt = null;   // Chrome's "install this app" prompt, saved for the button in Me
const ui = { form: null, exp: null, round: null, hole: {}, pendingPay: null, showPast: false, shareText: null, saving: {} };

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);
const dollars = (c) => (c ? (c / 100).toFixed(2).replace(/\.00$/, '') : '');
const user = (id) => S.users.find((u) => u.id === id) || { id, name: 'Someone', venmo: '' };
const first = (id) => (id === S.me.id ? 'You' : user(id).name.split(/\s+/)[0]);
const fmt = (t, o) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o }).format(new Date(t));
const fDay = (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric' });
const fTime = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });
const fWhen = (t) => `${fDay(t)}, ${fTime(t)}`;
function laParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, '0')}:${p.minute}` };
}
function laTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number), [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t) => { const p = laParts(t); const [Y, M, D] = p.date.split('-').map(Number), [H, Mi] = p.time.split(':').map(Number); return Date.UTC(Y, M - 1, D, H, Mi) - Math.floor(t / 60000) * 60000; };
  let t = wall; for (let i = 0; i < 3; i++) t = wall - off(t);
  return t;
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 && h < 10 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* the login wall may answer with a page */ }
  if (res.status === 401) { S = null; render(); throw new Error(data.error || 'Log in first'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
function route() {
  const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const seg = p.split('/').filter(Boolean);
  return { seg, q: new URLSearchParams(qs || '') };
}
const myBalance = () => (S.balances.find((b) => b.userId === S.me.id) || { balance: 0 }).balance;
const mapsUrl = (b) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(b.address || b.course)}`;
function gcalUrl(b) {
  const z = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = b.teeAt + (b.holes === 9 ? 2.5 : 4.75) * HOUR;
  const details = [`${b.players} players · ${b.holes} holes · booked by ${user(b.bookerId).name}`, b.confirmation && `Confirmation #${b.confirmation}`,
    b.cancelAt > Date.now() && `Free cancel until ${fWhen(b.cancelAt)}`, `${location.origin}/#/b/${b.id}`].filter(Boolean).join('\n');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('⛳ ' + b.course)}&dates=${z(b.teeAt)}/${z(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(b.address || b.course)}`;
}
const venmoUrl = (to, amount, note, txn = 'pay') => `https://venmo.com/${encodeURIComponent(to)}?txn=${txn}&amount=${(amount / 100).toFixed(2)}&note=${encodeURIComponent(note)}`;

// ---------- frame ----------
function frame({ title, back, right = '', body, tab }) {
  const tabs = [['tee', '#/', '⛳', 'Tee times'], ['money', '#/money', '💵', 'Money'], ['scores', '#/scores', '📋', 'Scores'], ['me', '#/me', '👤', 'Me']];
  return `<header class="top">${back ? `<a class="btn ghost back" href="${back}">‹ Back</a>` : ''}<h1 class="grow">${esc(title)}</h1>${right}</header>
  <main class="page">${body}</main>
  <nav class="nav">${tabs.map(([k, h, i, l]) => `<a href="${h}" class="${tab === k ? 'on' : ''}"><span class="i">${i}</span>${l}</a>`).join('')}</nav>`;
}
function balanceChip() {
  const b = myBalance();
  if (!b) return `<a class="pill ok" href="#/money">All square</a>`;
  return `<a class="pill ${b > 0 ? 'ok' : 'warn'}" href="#/money">${b > 0 ? `You're owed ${money(b)}` : `You owe ${money(-b)}`}</a>`;
}

// ---------- tee times ----------
function deadlinePill(b) {
  const now = Date.now();
  if (b.status === 'cancelled') return `<span class="pill bad">Cancelled</span>`;
  if (b.teeAt < now) return `<span class="pill">Played</span>`;
  if (now < b.cancelAt) {
    const left = b.cancelAt - now;
    return `<span class="pill ${left < S.remindHours * HOUR ? 'warn' : 'ok'}">Free cancel: ${dur(left)} left</span>`;
  }
  return `<span class="pill">🔒 Locked in</span>`;
}
function rosterChips(b) {
  return b.roster.map((r) => `<span class="pill ${r.rsvp === 'out' ? 'bad' : 'ok'}">${r.rsvp === 'out' ? '❌' : '✅'} ${esc(first(r.userId))}</span>`).join('');
}
function teeCard(b) {
  const off = b.status === 'cancelled' || b.teeAt < Date.now() - 5 * HOUR;
  return `<a class="tee ${off ? 'off' : ''}" href="#/b/${b.id}">
    <div class="date"><span class="wd">${fmt(b.teeAt, { weekday: 'short' })}</span><span class="d">${fmt(b.teeAt, { day: 'numeric' })}</span><span class="m">${fmt(b.teeAt, { month: 'short' })}</span></div>
    <div class="grow"><div class="name">${esc(b.course)}</div>
      <div class="dim small-text">${fTime(b.teeAt)} · ${b.holes} holes · ${b.players} players · ${esc(first(b.bookerId))} booked</div>
      <div class="who">${deadlinePill(b)}${rosterChips(b)}</div></div></a>`;
}
function viewTeeTimes() {
  const now = Date.now();
  const up = S.bookings.filter((b) => b.status === 'active' && b.teeAt > now - 5 * HOUR).sort((a, b) => a.teeAt - b.teeAt);
  const past = S.bookings.filter((b) => !up.includes(b)).sort((a, b) => b.teeAt - a.teeAt);
  const pushHint = !S.push.mine && 'Notification' in window ? `<div class="card row"><span class="grow">🔔 Turn on notifications so you hear about new tee times and cancellation deadlines.</span><button class="primary small" data-act="push-on">Turn on</button></div>` : '';
  return frame({
    title: 'GolfBuddy', tab: 'tee', right: balanceChip(),
    body: `${pushHint}<a class="btn primary block" href="#/new">＋ Add a tee time</a>
    <section class="card"><h2>Coming up</h2>${up.length ? up.map(teeCard).join('') : `<div class="empty">Nothing booked. Paste a confirmation email to add one.</div>`}</section>
    ${past.length ? `<section class="card"><div class="row"><h2 class="grow" style="margin:0">Past &amp; cancelled</h2><button class="small ghost" data-act="toggle-past">${ui.showPast ? 'Hide' : `Show ${past.length}`}</button></div>
      ${ui.showPast ? `<div style="margin-top:10px">${past.slice(0, 40).map(teeCard).join('')}</div>` : ''}</section>` : ''}`,
  });
}

function viewBooking(id) {
  const b = S.bookings.find((x) => x.id === id);
  if (!b) return frame({ title: 'Tee time', back: '#/', tab: 'tee', body: `<div class="card empty">That tee time isn't here any more.</div>` });
  const c = S.courses.find((x) => x.id === b.courseId) || {};
  const mine = b.roster.find((r) => r.userId === S.me.id);
  const exps = S.expenses.filter((e) => e.bookingId === b.id);
  const round = S.rounds.find((r) => r.bookingId === b.id);
  const ids = b.roster.map((r) => r.userId);
  const due = Math.max(0, b.total - b.deposit);
  const cancelled = b.status === 'cancelled';
  return frame({
    title: b.course, back: '#/', tab: 'tee',
    body: `<section class="card">
      <div class="hero">${fDay(b.teeAt)} · ${fTime(b.teeAt)}</div>
      <div class="dim" style="margin:4px 0 10px">${b.holes} holes · ${b.players} players · booked by ${esc(user(b.bookerId).name)}</div>
      <div class="who">${deadlinePill(b)}</div>
      ${!cancelled && b.teeAt > Date.now() ? `<label>Are you playing?</label>
      <div class="seg"><button data-act="rsvp" data-v="in" class="${mine?.rsvp !== 'out' && mine ? 'on' : ''}">✅ I'm in</button><button data-act="rsvp" data-v="out" class="${mine?.rsvp === 'out' ? 'on' : ''}">❌ Can't make it</button></div>` : ''}
      <div class="who" style="margin-top:10px">${rosterChips(b)}</div>
    </section>
    <section class="actions">
      <a class="btn" href="${mapsUrl(b)}" target="_blank" rel="noopener">🧭 Directions</a>
      <a class="btn" href="${gcalUrl(b)}" target="_blank" rel="noopener">📅 Add to Calendar</a>
      ${c.phone ? `<a class="btn" href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">📞 Call course</a>` : ''}
      ${c.bookUrl ? `<a class="btn" href="${esc(c.bookUrl)}" target="_blank" rel="noopener">🔗 Booking site</a>` : ''}
    </section>
    <section class="card"><h2>Details</h2><div class="kv">
      ${b.cancelAt ? `<span>Free cancel until</span><span>${fWhen(b.cancelAt)}</span>` : ''}
      ${b.confirmation ? `<span>Confirmation</span><span><button class="small" data-act="copy" data-v="${esc(b.confirmation)}">${esc(b.confirmation)} ⧉</button></span>` : ''}
      <span>Total cost</span><span>${b.total ? money(b.total) : '<span class="dim">not entered</span>'}</span>
      <span>Deposit</span><span>${b.deposit ? `${money(b.deposit)} paid by ${esc(first(b.bookerId))}, split ${ids.length} ways` : '<span class="dim">none</span>'}</span>
      ${b.total ? `<span>Due at course</span><span>${money(due)}</span>` : ''}
      ${b.address ? `<span>Address</span><span>${esc(b.address)}</span>` : ''}
      ${b.source ? `<span>Added from</span><span>${esc(b.source)}</span>` : ''}
    </div>${b.notes ? `<p class="small-text" style="white-space:pre-wrap;margin:12px 0 0">${esc(b.notes)}</p>` : ''}</section>
    <section class="card"><h2>Money for this round</h2>
      <div class="list">${exps.length ? exps.map(expenseLine).join('') : `<div class="empty">Nothing yet.</div>`}</div>
      <div class="chips" style="margin-top:10px">
        <a class="btn small primary" href="#/money/add?b=${b.id}&cat=${encodeURIComponent('Green fees')}${due ? `&amt=${dollars(due)}` : ''}">＋ Paid at the course</a>
        <a class="btn small" href="#/money/add?b=${b.id}&cat=${encodeURIComponent('Food & drinks')}">＋ Food &amp; drinks</a>
        <a class="btn small" href="#/money/add?b=${b.id}&cat=${encodeURIComponent('Pro shop')}">＋ Pro shop</a>
        <a class="btn small" href="#/money/add?b=${b.id}">＋ Other</a>
      </div></section>
    <section class="card"><h2>Scorecard</h2>${round ? `${roundSummary(round)}<a class="btn block" style="margin-top:10px" href="#/r/${round.id}">Open scorecard</a>`
      : `<button class="block" data-act="start-round" data-id="${b.id}">📋 Start a scorecard</button>`}</section>
    <section class="row">
      <a class="btn grow" href="#/b/${b.id}/edit">✏️ Edit</a>
      ${cancelled ? `<button class="grow" data-act="restore" data-id="${b.id}">↩️ Un-cancel</button>` : `<button class="danger grow" data-act="cancel" data-id="${b.id}">🚫 Mark cancelled</button>`}
      ${b.createdBy === S.me.id || S.me.admin ? `<button class="ghost" data-act="delete-booking" data-id="${b.id}">Delete</button>` : ''}
    </section>`,
  });
}

// ---------- add / edit a tee time ----------
function blankForm() {
  const tomorrow = laParts(Date.now() + 24 * HOUR).date;
  return { course: '', date: tomorrow, time: '07:00', players: 2, holes: 18, bookerId: S.me.id, roster: S.users.map((u) => u.id), total: '', deposit: '',
    cancelHours: 24, confirmation: '', address: '', phone: '', notes: '', source: 'Manual', paste: '' };
}
function formFromBooking(b) {
  const p = laParts(b.teeAt);
  return { id: b.id, course: b.course, date: p.date, time: p.time, players: b.players, holes: b.holes, bookerId: b.bookerId, roster: b.roster.map((r) => r.userId),
    total: dollars(b.total), deposit: dollars(b.deposit), cancelHours: Math.round((b.teeAt - b.cancelAt) / HOUR), confirmation: b.confirmation, address: b.address,
    phone: '', notes: b.notes, source: b.source };
}
function viewForm(id) {
  const editing = !!id;
  if (!ui.form || (ui.form.id || null) !== (id || null)) {
    const b = editing && S.bookings.find((x) => x.id === id);
    ui.form = b ? formFromBooking(b) : blankForm();
    if (!editing && ui.shareText) { ui.form.paste = ui.shareText; ui.shareText = null; setTimeout(() => readPaste(), 0); }
  }
  const f = ui.form;
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
  return frame({
    title: editing ? 'Edit tee time' : 'New tee time', back: editing ? `#/b/${id}` : '#/', tab: 'tee',
    body: `${editing ? '' : `<section class="card"><h2>Paste the confirmation</h2>
      <textarea id="paste" placeholder="Paste the confirmation email here (L.A. City, GolfNow, foreUP or anything else) and tap Read it.">${esc(f.paste)}</textarea>
      <div class="row" style="margin-top:8px"><button class="primary" data-act="read-paste">Read it</button><button data-act="paste-clip">Paste from clipboard</button></div>
      <p class="dim small-text" style="margin:8px 0 0">Tip: in Gmail, long-press the email text → Select all → Share → GolfBuddy.</p></section>`}
    <section class="card" id="bf">
      <label for="f-course">Course</label><input id="f-course" list="courses" value="${esc(f.course)}" placeholder="Rancho Park" autocomplete="off">
      <datalist id="courses">${S.courses.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="grid2"><div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(f.date)}"></div>
        <div><label for="f-time">Tee time</label><input id="f-time" type="time" value="${esc(f.time)}"></div></div>
      <div class="grid2"><div><label for="f-players">Players in the booking</label><select id="f-players">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => opt(n, f.players)).join('')}</select></div>
        <div><label>Holes</label><div class="seg"><button data-act="holes" data-v="18" class="${f.holes === 18 ? 'on' : ''}">18</button><button data-act="holes" data-v="9" class="${f.holes === 9 ? 'on' : ''}">9</button></div></div></div>
      <label for="f-booker">Booked (and deposit paid) by</label><select id="f-booker">${S.users.map((u) => opt(u.id, f.bookerId, u.name)).join('')}</select>
      <label>Who's splitting it</label><div class="chips">${S.users.map((u) => `<button class="chip ${f.roster.includes(u.id) ? 'on' : ''}" data-act="roster" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>
      <div class="grid2"><div><label for="f-total">Total cost ($)</label><input id="f-total" inputmode="decimal" value="${esc(f.total)}" placeholder="0"></div>
        <div><label for="f-deposit">Deposit paid ($)</label><input id="f-deposit" inputmode="decimal" value="${esc(f.deposit)}" placeholder="0"></div></div>
      <div class="grid2"><div><label for="f-cancel">Free cancel (hours before)</label><input id="f-cancel" inputmode="numeric" value="${esc(f.cancelHours)}"></div>
        <div><label for="f-conf">Confirmation #</label><input id="f-conf" value="${esc(f.confirmation)}"></div></div>
      <label for="f-address">Address (for directions)</label><input id="f-address" value="${esc(f.address)}">
      <label for="f-notes">Notes</label><textarea id="f-notes" rows="3">${esc(f.notes)}</textarea>
      <button class="primary block" style="margin-top:14px" data-act="save-booking">${editing ? 'Save changes' : 'Add tee time'}</button>
      <p class="dim small-text" style="margin:8px 0 0">The deposit is split evenly among the people above and shows up in Money right away. Everyone else on it gets a notification.</p>
    </section>`,
  });
}
function readFormInputs() {
  const f = ui.form; if (!f || !$('#bf')) return;
  const v = (id) => $('#' + id)?.value ?? '';
  Object.assign(f, { course: v('f-course'), date: v('f-date'), time: v('f-time'), players: Number(v('f-players')), bookerId: Number(v('f-booker')),
    total: v('f-total'), deposit: v('f-deposit'), cancelHours: v('f-cancel'), confirmation: v('f-conf'), address: v('f-address'), notes: v('f-notes') });
  if ($('#paste')) f.paste = $('#paste').value;
}
async function readPaste() {
  readFormInputs();
  const text = ui.form.paste;
  if (!text.trim()) return toast('Paste the email text first');
  try {
    const r = await api('POST', '/api/parse', { text });
    const f = ui.form;
    if (r.course) f.course = r.course;
    if (r.teeAt) { const p = laParts(r.teeAt); f.date = p.date; f.time = p.time; } else if (r.date) f.date = r.date;
    if (r.players) f.players = r.players;
    if (r.holes) f.holes = r.holes;
    if (r.bookerId) f.bookerId = r.bookerId;
    if (!f.roster.includes(f.bookerId)) f.roster.push(f.bookerId);
    if (r.total != null) f.total = dollars(r.total);
    if (r.deposit != null) f.deposit = dollars(r.deposit);
    if (r.cancelHours != null) f.cancelHours = r.cancelHours;
    if (r.confirmation) f.confirmation = r.confirmation;
    if (r.address) f.address = r.address;
    if (r.notes) f.notes = r.notes;
    f.source = r.source || 'Pasted';
    render();
    toast(r.missing.length ? `Read it. Please fill in: ${r.missing.map((m) => ({ teeAt: 'date/time', course: 'course', players: 'players' }[m])).join(', ')}` : `Read it from ${r.source}. Check it over, then save.`);
  } catch (e) { toast(e.message); }
}
async function saveBooking() {
  readFormInputs();
  const f = ui.form;
  if (!f.date || !f.time) return toast('Pick the date and tee time');
  const body = { course: f.course, teeAt: laTime(f.date, f.time), players: f.players, holes: f.holes, bookerId: f.bookerId, roster: f.roster, total: f.total, deposit: f.deposit,
    cancelHours: Number(f.cancelHours), confirmation: f.confirmation, address: f.address, notes: f.notes, source: f.source };
  try {
    const r = f.id ? await api('PUT', `/api/bookings/${f.id}`, body) : await api('POST', '/api/bookings', body);
    ui.form = null;
    await refresh(false);
    toast(f.id ? 'Saved' : 'Tee time added');
    go(`#/b/${r.booking.id}`);
  } catch (e) { toast(e.message); }
}

// ---------- money ----------
function expenseLine(e) {
  const mine = e.split[S.me.id] || 0;
  const effect = (e.paidBy === S.me.id ? e.amount : 0) - mine;
  const b = e.bookingId && S.bookings.find((x) => x.id === e.bookingId);
  const who = Object.keys(e.split).map(Number);
  const canDel = !e.auto && (e.createdBy === S.me.id || e.paidBy === S.me.id || S.me.admin);
  return `<div class="line"><div class="grow"><div><b>${esc(e.category)}</b>${e.description && e.category !== 'Deposit' ? ` · ${esc(e.description)}` : ''}</div>
    <div class="dim small-text">${money(e.amount)} paid by ${esc(first(e.paidBy))} · for ${who.map((id) => esc(first(id))).join(', ')}${b ? ` · ${esc(b.course)} ${fDay(b.teeAt)}` : ` · ${fDay(e.ts)}`}</div></div>
    <div class="amt num ${effect > 0 ? 'pos' : effect < 0 ? 'neg' : 'dim'}">${effect ? (effect > 0 ? '+' : '') + money(effect) : '—'}</div>
    ${canDel ? `<button class="x" data-act="del-exp" data-id="${e.id}" aria-label="Delete">✕</button>` : '<span style="width:30px"></span>'}</div>`;
}
function settlementLine(s) {
  const effect = s.fromId === S.me.id ? s.amount : s.toId === S.me.id ? -s.amount : 0;
  return `<div class="line"><div class="grow"><div><b>🤝 Settled</b> · ${esc(first(s.fromId))} → ${esc(first(s.toId))}</div>
    <div class="dim small-text">${money(s.amount)} by ${esc(s.method === 'venmo' ? 'Venmo' : s.method)} · ${fDay(s.ts)}</div></div>
    <div class="amt num ${effect > 0 ? 'pos' : effect < 0 ? 'neg' : 'dim'}">${effect ? (effect > 0 ? '+' : '') + money(effect) : '—'}</div>
    <button class="x" data-act="del-set" data-id="${s.id}" aria-label="Undo">✕</button></div>`;
}
function transferRow(t) {
  const iPay = t.fromId === S.me.id, iGet = t.toId === S.me.id;
  const note = '⛳ GolfBuddy settle-up';
  let buttons = '';
  if (iPay) {
    const v = user(t.toId).venmo;
    buttons = `${v ? `<a class="btn primary" href="${venmoUrl(v, t.amount, note)}" target="_blank" rel="noopener" data-act="venmo" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Pay with Venmo</a>` : `<span class="dim small-text">${esc(first(t.toId))} hasn't added a Venmo username yet</span>`}
      <button data-act="mark-paid" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Mark paid</button>`;
  } else if (iGet) {
    const v = user(t.fromId).venmo;
    buttons = `${v ? `<a class="btn" href="${venmoUrl(v, t.amount, note, 'charge')}" target="_blank" rel="noopener">Request on Venmo</a>` : ''}
      <button data-act="mark-paid" data-from="${t.fromId}" data-to="${t.toId}" data-amt="${t.amount}">Mark received</button>`;
  }
  return `<div class="owe"><div class="row"><span class="grow"><b>${esc(first(t.fromId))}</b> ${iPay ? 'owe' : 'owes'} <b>${esc(iGet ? 'you' : first(t.toId))}</b></span><span class="balance num" style="font-size:22px">${money(t.amount)}</span></div>
    ${buttons ? `<div class="row">${buttons}</div>` : ''}</div>`;
}
function viewMoney() {
  const b = myBalance();
  const hist = [...S.expenses.map((e) => ({ ts: e.ts, html: expenseLine(e) })), ...S.settlements.map((s) => ({ ts: s.ts, html: settlementLine(s) }))].sort((a, b) => b.ts - a.ts);
  const p = ui.pendingPay;
  return frame({
    title: 'Money', tab: 'money',
    body: `${p ? `<section class="card"><b>Did the Venmo payment go through?</b><div class="dim small-text">${money(p.amount)} to ${esc(user(p.toId).name)}. GolfBuddy can't see Venmo, so tell it.</div>
      <div class="row" style="margin-top:10px"><button class="primary" data-act="pending-yes">Yes, mark paid</button><button data-act="pending-no">Not yet</button></div></section>` : ''}
    <section class="card"><h2>Where you stand</h2>
      <div class="balance num ${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${b > 0 ? `You're owed ${money(b)}` : b < 0 ? `You owe ${money(-b)}` : 'All square ✅'}</div>
      <div class="list">${S.transfers.map(transferRow).join('')}</div></section>
    <a class="btn primary block" href="#/money/add">＋ Add an expense</a>
    <section class="card"><h2>History</h2><div class="list">${hist.length ? hist.map((h) => h.html).join('') : `<div class="empty">Deposits, green fees, food and pro-shop buys land here.</div>`}</div></section>`,
  });
}
function viewAddExpense(q) {
  if (!ui.exp) {
    const b = q.get('b') ? S.bookings.find((x) => x.id === Number(q.get('b'))) : null;
    ui.exp = { amount: q.get('amt') || '', category: q.get('cat') || 'Food & drinks', description: '', paidBy: S.me.id, mode: 'even',
      ids: b ? b.roster.map((r) => r.userId) : S.users.map((u) => u.id), full: S.users.find((u) => u.id !== S.me.id)?.id || S.me.id, shares: {}, bookingId: b ? b.id : '' };
  }
  const x = ui.exp;
  const recent = S.bookings.filter((b) => b.teeAt > Date.now() - 60 * 24 * HOUR).sort((a, b) => b.teeAt - a.teeAt);
  return frame({
    title: 'Add an expense', back: x.bookingId ? `#/b/${x.bookingId}` : '#/money', tab: 'money',
    body: `<section class="card" id="xf">
      <label>What for</label><div class="chips">${S.categories.filter((c) => c !== 'Deposit').map((c) => `<button class="chip ${x.category === c ? 'on' : ''}" data-act="x-cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="grid2"><div><label for="x-amt">Amount ($)</label><input id="x-amt" inputmode="decimal" value="${esc(x.amount)}" placeholder="0.00"></div>
        <div><label for="x-paid">Paid by</label><select id="x-paid">${S.users.map((u) => `<option value="${u.id}" ${u.id === x.paidBy ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div></div>
      <label for="x-desc">Note (optional)</label><input id="x-desc" value="${esc(x.description)}" placeholder="Burgers at the turn">
      <label>Split</label><div class="seg"><button data-act="x-mode" data-v="even" class="${x.mode === 'even' ? 'on' : ''}">Evenly</button><button data-act="x-mode" data-v="full" class="${x.mode === 'full' ? 'on' : ''}">All for one</button><button data-act="x-mode" data-v="custom" class="${x.mode === 'custom' ? 'on' : ''}">Amounts</button></div>
      <div style="margin-top:8px">${x.mode === 'even' ? `<div class="chips">${S.users.map((u) => `<button class="chip ${x.ids.includes(u.id) ? 'on' : ''}" data-act="x-id" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>`
        : x.mode === 'full' ? `<label for="x-full">It was all for</label><select id="x-full">${S.users.map((u) => `<option value="${u.id}" ${u.id === x.full ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`
        : S.users.map((u) => `<label for="x-sh-${u.id}">${esc(u.name)}'s share ($)</label><input id="x-sh-${u.id}" data-share="${u.id}" inputmode="decimal" value="${esc(x.shares[u.id] || '')}">`).join('')}</div>
      <label for="x-b">Tee time (optional)</label><select id="x-b"><option value="">None</option>${recent.map((b) => `<option value="${b.id}" ${String(b.id) === String(x.bookingId) ? 'selected' : ''}>${esc(b.course)} · ${fDay(b.teeAt)}</option>`).join('')}</select>
      <button class="primary block" style="margin-top:14px" data-act="save-exp">Add it</button></section>`,
  });
}
function readExpInputs() {
  const x = ui.exp; if (!x || !$('#xf')) return;
  x.amount = $('#x-amt').value; x.paidBy = Number($('#x-paid').value); x.description = $('#x-desc').value; x.bookingId = $('#x-b').value;
  if ($('#x-full')) x.full = Number($('#x-full').value);
  $$('[data-share]').forEach((el) => { x.shares[el.dataset.share] = el.value; });
}
async function saveExpense() {
  readExpInputs();
  const x = ui.exp;
  const split = x.mode === 'even' ? { mode: 'even', ids: x.ids } : x.mode === 'full' ? { mode: 'full', id: x.full } : { mode: 'custom', shares: x.shares };
  try {
    await api('POST', '/api/expenses', { amount: x.amount, paidBy: x.paidBy, category: x.category, description: x.description, split, bookingId: x.bookingId || null });
    const back = x.bookingId ? `#/b/${x.bookingId}` : '#/money';
    ui.exp = null; await refresh(false); toast('Added'); go(back);
  } catch (e) { toast(e.message); }
}
async function markPaid(fromId, toId, amount) {
  try { await api('POST', '/api/settlements', { fromId, toId, amount: amount / 100, method: 'venmo' }); ui.pendingPay = null; await refresh(); toast('Marked as settled'); }
  catch (e) { toast(e.message); }
}

// ---------- scorecards ----------
function totals(r, s) {
  let strokes = 0, par = 0, n = 0;
  s.strokes.forEach((x, i) => { if (x) { strokes += x; par += r.pars[i] || 4; n++; } });
  return { strokes, toPar: strokes - par, n };
}
const toParText = (d) => (d === 0 ? 'E' : d > 0 ? `+${d}` : `${d}`);
function orderedScores(r) { return [...r.scores].sort((a, b) => S.users.findIndex((u) => u.id === a.userId) - S.users.findIndex((u) => u.id === b.userId)); }
function roundSummary(r) {
  return `<div class="row">${orderedScores(r).map((s) => { const t = totals(r, s); return `<span class="pill ${t.toPar < 0 ? 'ok' : ''}">${esc(first(s.userId))}: ${t.n ? `${t.strokes} (${toParText(t.toPar)})${t.n < r.holes ? ` thru ${t.n}` : ''}` : '—'}</span>`; }).join('')}</div>`;
}
function headToHead() {
  const out = [];
  for (const u of S.users) {
    if (u.id === S.me.id) continue;
    let w = 0, l = 0, t = 0;
    for (const r of S.rounds) {
      const a = r.scores.find((s) => s.userId === S.me.id), b = r.scores.find((s) => s.userId === u.id);
      if (!a || !b) continue;
      const ta = totals(r, a), tb = totals(r, b);
      if (ta.n !== r.holes || tb.n !== r.holes) continue;
      if (ta.strokes < tb.strokes) w++; else if (ta.strokes > tb.strokes) l++; else t++;
    }
    if (w + l + t) out.push(`<div class="line"><span class="grow">You vs ${esc(u.name)}</span><b class="num">${w}–${l}${t ? `–${t}` : ''}</b></div>`);
  }
  return out.join('');
}
function viewScores() {
  if (!ui.round) ui.round = { course: '', date: laParts(Date.now()).date, holes: 18, start: 1, players: S.users.map((u) => u.id), open: false };
  const n = ui.round;
  const h2h = headToHead();
  return frame({
    title: 'Scores', tab: 'scores',
    body: `<section class="card">${n.open ? `<h2>New scorecard</h2>
      <label for="r-course">Course</label><input id="r-course" list="courses2" value="${esc(n.course)}" autocomplete="off"><datalist id="courses2">${S.courses.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <div class="grid2"><div><label for="r-date">Date</label><input id="r-date" type="date" value="${esc(n.date)}"></div>
      <div><label>Holes</label><div class="seg"><button data-act="r-holes" data-v="18" class="${n.holes === 18 ? 'on' : ''}">18</button><button data-act="r-holes" data-v="9" class="${n.holes === 9 && n.start === 1 ? 'on' : ''}">Front 9</button><button data-act="r-holes" data-v="9b" class="${n.holes === 9 && n.start === 10 ? 'on' : ''}">Back 9</button></div></div></div>
      <label>Players</label><div class="chips">${S.users.map((u) => `<button class="chip ${n.players.includes(u.id) ? 'on' : ''}" data-act="r-player" data-v="${u.id}">${esc(u.name)}</button>`).join('')}</div>
      <button class="primary block" style="margin-top:14px" data-act="r-start">Start scoring</button>`
      : `<button class="primary block" data-act="r-open">＋ New scorecard</button>`}</section>
    ${h2h ? `<section class="card"><h2>Head to head</h2><div class="list">${h2h}</div><p class="dim small-text" style="margin:6px 0 0">Completed rounds only, gross strokes.</p></section>` : ''}
    <section class="card"><h2>Rounds</h2><div class="list">${S.rounds.length ? S.rounds.map((r) => `<a class="line" style="color:inherit;text-decoration:none" href="#/r/${r.id}"><div class="grow"><b>${esc(r.course)}</b> <span class="dim small-text">${fDay(r.playedOn)} · ${r.holes === 9 ? (r.startHole === 10 ? 'back 9' : 'front 9') : '18'}</span>${roundSummary(r)}</div><span class="dim">›</span></a>`).join('')
      : `<div class="empty">No rounds yet. Start a scorecard from a tee time or here.</div>`}</div></section>`,
  });
}
async function startRound(body) {
  try { const r = await api('POST', '/api/rounds', body); await refresh(false); go(`#/r/${r.round.id}`); } catch (e) { toast(e.message); }
}
function viewRound(id) {
  const r = S.rounds.find((x) => x.id === id);
  if (!r) return frame({ title: 'Scorecard', back: '#/scores', tab: 'scores', body: `<div class="card empty">That scorecard isn't here any more.</div>` });
  const i = Math.min(ui.hole[id] ?? firstOpenHole(r), r.holes - 1);
  const holeNo = r.startHole + i;
  const par = r.pars[i] || 4;
  const sc = orderedScores(r);
  const done = (k) => sc.every((s) => s.strokes[k]);
  const cell = (s, k) => { const x = s.strokes[k]; if (!x) return '<td class="dim">·</td>'; const d = x - (r.pars[k] || 4); return `<td><span class="${d < 0 ? 'birdie tag-under' : d > 0 ? 'tag-over' : ''}">${x}</span></td>`; };
  const sum = (arr, a, b) => arr.slice(a, b).reduce((t, x) => t + (x || 0), 0) || '';
  const split18 = r.holes === 18;
  return frame({
    title: r.course, back: r.bookingId ? `#/b/${r.bookingId}` : '#/scores', tab: 'scores',
    body: `<section class="card">
      <div class="holebar">${r.pars.map((_, k) => `<button class="${k === i ? 'on' : done(k) ? 'done' : ''}" data-act="hole" data-v="${k}">${r.startHole + k}</button>`).join('')}</div>
      <div class="holehead"><span class="h">Hole ${holeNo}</span><button class="small" data-act="par" data-v="${i}">Par ${par} ↻</button></div>
      <div class="list">${sc.map((s) => { const x = s.strokes[i]; return `<div class="score"><span class="who">${esc(user(s.userId).name)}</span>
        <button data-act="stroke" data-u="${s.userId}" data-d="-1">−</button><span class="n num ${x ? '' : 'dim'}" data-act="stroke" data-u="${s.userId}" data-d="0">${x || par}</span><button data-act="stroke" data-u="${s.userId}" data-d="1">+</button></div>`; }).join('')}</div>
      <p class="dim small-text" style="margin:4px 0 10px">A grey number is just the par: tap it to confirm, or use − / +.</p>
      <div class="row"><button class="grow" data-act="hole" data-v="${Math.max(0, i - 1)}" ${i === 0 ? 'disabled' : ''}>‹ Hole ${holeNo - 1}</button><button class="grow primary" data-act="hole" data-v="${Math.min(r.holes - 1, i + 1)}" ${i === r.holes - 1 ? 'disabled' : ''}>Hole ${holeNo + 1} ›</button></div>
    </section>
    <section class="card cardtbl"><table>
      <tr><th>Hole</th>${r.pars.map((_, k) => `<th>${r.startHole + k}</th>${split18 && k === 8 ? '<th class="sum">Out</th>' : ''}`).join('')}${split18 ? '<th class="sum">In</th>' : ''}<th class="sum">Tot</th></tr>
      <tr><td class="dim">Par</td>${r.pars.map((p, k) => `<td class="dim">${p}</td>${split18 && k === 8 ? `<td class="sum dim">${sum(r.pars, 0, 9)}</td>` : ''}`).join('')}${split18 ? `<td class="sum dim">${sum(r.pars, 9, 18)}</td>` : ''}<td class="sum dim">${sum(r.pars, 0, r.holes)}</td></tr>
      ${sc.map((s) => `<tr><td>${esc(first(s.userId))}</td>${r.pars.map((_, k) => cell(s, k) + (split18 && k === 8 ? `<td class="sum">${sum(s.strokes, 0, 9)}</td>` : '')).join('')}${split18 ? `<td class="sum">${sum(s.strokes, 9, 18)}</td>` : ''}<td class="sum">${sum(s.strokes, 0, r.holes)}</td></tr>`).join('')}
    </table><div style="margin-top:10px">${roundSummary(r)}</div></section>
    <section class="card"><h2>Post to GHIN</h2><p class="dim small-text" style="margin-top:0">GHIN doesn't let personal apps post scores, so this copies your hole-by-hole scores for pasting or reading off in the GHIN app.</p>
      <div class="row"><button data-act="ghin-copy" data-id="${r.id}">⧉ Copy my scores</button><a class="btn" href="https://www.ghin.com/" target="_blank" rel="noopener">Open GHIN</a></div></section>
    <button class="ghost danger" data-act="del-round" data-id="${r.id}">Delete this scorecard</button>`,
  });
}
function firstOpenHole(r) { for (let k = 0; k < r.holes; k++) if (!r.scores.every((s) => s.strokes[k])) return k; return 0; }
function saveRoundSoon(r, payload) {
  clearTimeout(ui.saving[r.id]);
  ui.saving[r.id] = setTimeout(async () => {
    try { const x = await api('PUT', `/api/rounds/${r.id}`, payload()); Object.assign(r, x.round); } catch (e) { toast(e.message); }
  }, 500);
}

// ---------- me ----------
function viewMe() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return frame({
    title: 'Me', tab: 'me',
    body: `<section class="card" id="mf"><h2>Profile</h2>
      <label for="m-name">Name</label><input id="m-name" value="${esc(S.me.name)}">
      <label for="m-venmo">Venmo username (so your buddy can pay you in one tap)</label><input id="m-venmo" value="${esc(S.me.venmo)}" placeholder="without the @" autocapitalize="off">
      <button class="primary block" style="margin-top:12px" data-act="save-me">Save</button></section>
    <section class="card"><h2>Notifications</h2>
      <p class="small-text" style="margin-top:0">${S.push.mine ? `✅ On for ${S.push.mine} device${S.push.mine > 1 ? 's' : ''}.` : perm === 'denied' ? '🚫 Blocked. Allow notifications for this site in Chrome (lock icon › Permissions), then come back.' : perm === 'unsupported' ? 'This browser cannot do push notifications.' : 'Off on this device.'}
      You'll hear about new or changed tee times, "still in?" ${S.remindHours}h before free cancellation ends, the evening before a round, and new expenses.</p>
      <div class="row"><button class="primary" data-act="push-on">${S.push.mine ? 'Re-connect this device' : 'Turn on'}</button>${S.push.mine ? '<button data-act="push-test">Send a test</button>' : ''}</div></section>
    <section class="card"><h2>App</h2>${installEvt ? `<button class="block" data-act="install">📲 Install GolfBuddy</button>` : `<p class="small-text dim" style="margin:0">To install: Chrome menu ⋮ › Add to Home screen (or Install app). Once installed, GolfBuddy shows up in Android's Share menu, so you can share a confirmation email straight into it.</p>`}</section>
    <section class="card"><div class="row"><h2 class="grow" style="margin:0">Courses</h2><a class="btn small" href="#/course/new">＋ Add</a></div>
      <div class="list" style="margin-top:8px">${S.courses.map((c) => `<a class="line" style="color:inherit;text-decoration:none" href="#/course/${c.id}"><div class="grow"><b>${esc(c.name)}</b><div class="dim small-text">Free cancel ${c.cancelHours}h before${c.pars ? ` · par ${c.pars.reduce((a, x) => a + x, 0)}` : ''}</div></div><span class="dim">›</span></a>`).join('')}</div></section>
    ${S.me.admin ? `<section class="card"><h2>Admin</h2><div class="kv"><span>Invite code</span><span><button class="small" data-act="copy" data-v="${esc(S.invite)}">${esc(S.invite)} ⧉</button></span></div>
      <label for="a-user">Reset someone's password</label><div class="row"><select id="a-user" class="grow">${S.users.filter((u) => u.id !== S.me.id).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <input id="a-pass" class="grow" placeholder="new password"><button data-act="admin-pass">Set</button></div></section>` : ''}
    <section class="card"><h2>Password</h2><div class="grid2"><input id="p-old" type="password" placeholder="current"><input id="p-new" type="password" placeholder="new (6+)"></div>
      <button class="block" style="margin-top:10px" data-act="change-pass">Change password</button></section>
    <button class="ghost" data-act="logout">Log out</button>`,
  });
}
function viewCourse(id) {
  const c = id ? S.courses.find((x) => x.id === id) : { name: '', address: '', phone: '', cancelHours: 24, bookUrl: '', pars: null, notes: '' };
  if (!c) return frame({ title: 'Course', back: '#/me', tab: 'me', body: '<div class="card empty">Not found.</div>' });
  const pars = c.pars || Array(18).fill('');
  return frame({
    title: id ? c.name : 'New course', back: '#/me', tab: 'me',
    body: `<section class="card" id="cf">
      <label for="c-name">Name</label><input id="c-name" value="${esc(c.name)}">
      <label for="c-address">Address</label><input id="c-address" value="${esc(c.address)}">
      <div class="grid2"><div><label for="c-phone">Phone</label><input id="c-phone" value="${esc(c.phone)}" inputmode="tel"></div>
      <div><label for="c-cancel">Free cancel (hours before)</label><input id="c-cancel" value="${esc(c.cancelHours)}" inputmode="numeric"></div></div>
      <label for="c-url">Booking website</label><input id="c-url" value="${esc(c.bookUrl)}" placeholder="https://">
      <label>Pars, holes 1–18 (fills in new scorecards)</label>
      <div class="pars">${pars.map((p, k) => `<input data-par="${k}" value="${esc(p)}" inputmode="numeric" maxlength="1" aria-label="Hole ${k + 1} par">`).join('')}</div>
      <label for="c-notes">Notes</label><textarea id="c-notes" rows="2">${esc(c.notes)}</textarea>
      <button class="primary block" style="margin-top:12px" data-act="save-course" data-id="${id || ''}">Save</button></section>`,
  });
}

// ---------- login ----------
function viewAuth() {
  const reg = ui.authMode === 'register';
  return `<main class="auth card"><img class="logo" src="/icons/icon-192.png" alt=""><h1 style="text-align:center">GolfBuddy</h1>
    <div class="seg" style="margin:14px 0 4px"><button data-act="auth-mode" data-v="login" class="${reg ? '' : 'on'}">Log in</button><button data-act="auth-mode" data-v="register" class="${reg ? 'on' : ''}">Create account</button></div>
    <form id="authf"><label for="u">Username</label><input id="u" autocomplete="username" autocapitalize="off" required>
    ${reg ? '<label for="n">Your name</label><input id="n" placeholder="Mike">' : ''}
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
    ${reg ? '<label for="inv">Invite code</label><input id="inv" autocapitalize="off" required>' : ''}
    <button class="primary block" style="margin-top:16px">${reg ? 'Create account' : 'Log in'}</button></form></main>`;
}

// ---------- render & events ----------
function render() {
  const app = $('#app');
  if (!S) { app.innerHTML = viewAuth(); return; }
  const { seg, q } = route();
  const id = Number(seg[1]);
  let html;
  if (seg[0] === 'b' && seg[2] === 'edit') html = viewForm(id);
  else if (seg[0] === 'b') html = viewBooking(id);
  else if (seg[0] === 'new') html = viewForm(null);
  else if (seg[0] === 'money' && seg[1] === 'add') html = viewAddExpense(q);
  else if (seg[0] === 'money' || seg[0] === 'ledger') html = viewMoney();
  else if (seg[0] === 'scores') html = viewScores();
  else if (seg[0] === 'r') html = viewRound(id);
  else if (seg[0] === 'me') html = viewMe();
  else if (seg[0] === 'course') html = viewCourse(seg[1] === 'new' ? null : id);
  else html = viewTeeTimes();
  app.innerHTML = html;
}
// Screens with a half-filled form are not redrawn when fresh data arrives in the background.
const busyForm = () => !!$('#bf, #xf, #cf, #mf') && document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
async function refresh(draw = true) {
  try {
    const res = await fetch('/api/state', { credentials: 'include' });
    if (res.status === 401) { S = null; render(); return; }
    if (!res.ok) return;
    S = await res.json();
    if (draw && !busyForm()) render();
  } catch { /* offline: keep what we have */ }
}

window.addEventListener('hashchange', () => {
  const { seg } = route();
  if (!(seg[0] === 'new' || seg[2] === 'edit')) ui.form = null;
  if (!(seg[0] === 'money' && seg[1] === 'add')) ui.exp = null;
  render(); window.scrollTo(0, 0);
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'authf') return;
  e.preventDefault();
  const reg = ui.authMode === 'register';
  try {
    await api('POST', reg ? '/api/register' : '/api/login', { username: $('#u').value, password: $('#pw').value, name: $('#n')?.value, invite: $('#inv')?.value });
    await refresh(); syncPush();
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'f-course') {
    readFormInputs();
    const c = S.courses.find((x) => x.name.toLowerCase() === t.value.trim().toLowerCase());
    if (c) { ui.form.address = c.address || ui.form.address; ui.form.cancelHours = c.cancelHours; render(); }
  }
  if (t.id === 'r-course' || t.id === 'r-date') { ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  const { seg } = route();
  const keepGoing = act === 'venmo'; // let the Venmo link open
  if (!keepGoing) e.preventDefault();
  try {
    switch (act) {
      case 'auth-mode': ui.authMode = v; render(); break;
      case 'toggle-past': ui.showPast = !ui.showPast; render(); break;
      case 'push-on': await enablePush(); break;
      case 'push-test': { const r = await api('POST', '/api/push/test', {}); toast(r.sent ? 'Sent. It should pop up in a few seconds.' : 'No device is connected yet'); break; }
      case 'install': if (installEvt) { installEvt.prompt(); installEvt = null; } break;
      case 'copy': await navigator.clipboard.writeText(v); toast('Copied'); break;
      // tee times
      case 'rsvp': await api('POST', `/api/bookings/${seg[1]}/rsvp`, { rsvp: v }); await refresh(); toast(v === 'in' ? "You're in" : 'Marked you out. Your buddy was told.'); break;
      case 'cancel': if (confirm('Mark this tee time as cancelled? (Cancel it with the course too. The deposit stays split, since it is usually lost.)')) { await api('POST', `/api/bookings/${el.dataset.id}/cancel`, {}); await refresh(); } break;
      case 'restore': await api('POST', `/api/bookings/${el.dataset.id}/restore`, {}); await refresh(); break;
      case 'delete-booking': if (confirm('Delete this tee time and its deposit line completely?')) { await api('DELETE', `/api/bookings/${el.dataset.id}`); await refresh(false); go('#/'); } break;
      case 'read-paste': await readPaste(); break;
      case 'paste-clip': try { ui.form.paste = await navigator.clipboard.readText(); readFormInputs(); $('#paste').value = ui.form.paste; await readPaste(); } catch { toast('Long-press the box and choose Paste'); } break;
      case 'holes': readFormInputs(); ui.form.holes = Number(v); render(); break;
      case 'roster': { readFormInputs(); const id = Number(v), r = ui.form.roster; ui.form.roster = r.includes(id) ? r.filter((x) => x !== id) : [...r, id]; render(); break; }
      case 'save-booking': await saveBooking(); break;
      case 'start-round': { const b = S.bookings.find((x) => x.id === Number(el.dataset.id)); await startRound({ bookingId: b.id, holes: b.holes, startHole: /back 9/i.test(b.notes) ? 10 : 1, players: b.roster.filter((r) => r.rsvp !== 'out').map((r) => r.userId), playedOn: b.teeAt }); break; }
      // money
      case 'x-cat': readExpInputs(); ui.exp.category = v; render(); break;
      case 'x-mode': readExpInputs(); ui.exp.mode = v; render(); break;
      case 'x-id': { readExpInputs(); const id = Number(v), r = ui.exp.ids; ui.exp.ids = r.includes(id) ? r.filter((x) => x !== id) : [...r, id]; render(); break; }
      case 'save-exp': await saveExpense(); break;
      case 'del-exp': if (confirm('Delete this expense?')) { await api('DELETE', `/api/expenses/${el.dataset.id}`); await refresh(); } break;
      case 'del-set': if (confirm('Undo this settle-up?')) { await api('DELETE', `/api/settlements/${el.dataset.id}`); await refresh(); } break;
      case 'venmo': ui.pendingPay = { fromId: Number(el.dataset.from), toId: Number(el.dataset.to), amount: Number(el.dataset.amt) }; setTimeout(render, 300); break;
      case 'mark-paid': if (confirm(`Record ${money(Number(el.dataset.amt))} from ${user(Number(el.dataset.from)).name} to ${user(Number(el.dataset.to)).name}?`)) await markPaid(Number(el.dataset.from), Number(el.dataset.to), Number(el.dataset.amt)); break;
      case 'pending-yes': await markPaid(ui.pendingPay.fromId, ui.pendingPay.toId, ui.pendingPay.amount); break;
      case 'pending-no': ui.pendingPay = null; render(); break;
      // scores
      case 'r-open': ui.round.open = true; render(); break;
      case 'r-holes': ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; ui.round.holes = v === '18' ? 18 : 9; ui.round.start = v === '9b' ? 10 : 1; render(); break;
      case 'r-player': { ui.round.course = $('#r-course').value; ui.round.date = $('#r-date').value; const id = Number(v), p = ui.round.players; ui.round.players = p.includes(id) ? p.filter((x) => x !== id) : [...p, id]; render(); break; }
      case 'r-start': { const n = ui.round; n.course = $('#r-course').value; n.date = $('#r-date').value; await startRound({ course: n.course, playedOn: laTime(n.date, '12:00'), holes: n.holes, startHole: n.start, players: n.players }); ui.round = null; break; }
      case 'hole': ui.hole[Number(seg[1])] = Number(v); render(); break;
      case 'stroke': {
        const r = S.rounds.find((x) => x.id === Number(seg[1]));
        const i = Math.min(ui.hole[r.id] ?? firstOpenHole(r), r.holes - 1);
        ui.hole[r.id] = i;
        const s = r.scores.find((x) => x.userId === Number(el.dataset.u));
        const par = r.pars[i] || 4, cur = s.strokes[i] || par, d = Number(el.dataset.d);
        while (s.strokes.length < r.holes) s.strokes.push(null);
        s.strokes[i] = Math.max(1, Math.min(20, s.strokes[i] ? cur + d : par + d));
        render();
        saveRoundSoon(r, () => ({ scores: Object.fromEntries(r.scores.map((x) => [x.userId, x.strokes])) }));
        break;
      }
      case 'par': {
        const r = S.rounds.find((x) => x.id === Number(seg[1])), i = Number(v);
        r.pars[i] = ({ 3: 4, 4: 5, 5: 3 })[r.pars[i]] || 4;
        render(); saveRoundSoon(r, () => ({ pars: r.pars }));
        break;
      }
      case 'ghin-copy': {
        const r = S.rounds.find((x) => x.id === Number(el.dataset.id)), s = r.scores.find((x) => x.userId === S.me.id);
        if (!s) { toast("You're not on this card"); break; }
        const t = totals(r, s);
        const text = `${r.course} · ${fDay(r.playedOn)} · ${r.holes} holes\n` + s.strokes.slice(0, r.holes).map((x, k) => `${r.startHole + k}: ${x || '-'}`).join('  ') + `\nTotal ${t.strokes} (${toParText(t.toPar)})`;
        await navigator.clipboard.writeText(text); toast('Copied your scores');
        break;
      }
      case 'del-round': if (confirm('Delete this scorecard?')) { await api('DELETE', `/api/rounds/${el.dataset.id}`); await refresh(false); go('#/scores'); } break;
      // me
      case 'save-me': await api('POST', '/api/me', { name: $('#m-name').value, venmo: $('#m-venmo').value }); await refresh(); toast('Saved'); break;
      case 'change-pass': await api('POST', '/api/me', { name: S.me.name, venmo: S.me.venmo, password: $('#p-old').value, newPassword: $('#p-new').value }); toast('Password changed'); $('#p-old').value = $('#p-new').value = ''; break;
      case 'admin-pass': await api('POST', '/api/admin/password', { userId: Number($('#a-user').value), password: $('#a-pass').value }); toast('Password set. Tell them the new one.'); break;
      case 'save-course': {
        const pars = $$('[data-par]').map((x) => Number(x.value));
        const body = { name: $('#c-name').value, address: $('#c-address').value, phone: $('#c-phone').value, cancelHours: Number($('#c-cancel').value), bookUrl: $('#c-url').value,
          notes: $('#c-notes').value, pars: pars.every((x) => !x) ? null : pars };
        const id = el.dataset.id;
        await api(id ? 'PUT' : 'POST', id ? `/api/courses/${id}` : '/api/courses', body); await refresh(false); toast('Saved'); go('#/me');
        break;
      }
      case 'logout': await api('POST', '/api/logout', {}); S = null; render(); break;
    }
  } catch (err) { toast(err.message); }
});

// ---------- push ----------
function keyBytes(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function swReady() {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}
async function subscribe(reg) {
  const key = keyBytes(S.push.key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a different server key cannot be reused.
  if (sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() !== key.join()) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
}
async function enablePush() {
  const reg = await swReady();
  if (!reg || !('PushManager' in window)) return toast('This browser cannot do push notifications');
  const p = await Notification.requestPermission();
  if (p !== 'granted') return toast('Notifications are blocked for this site');
  await subscribe(reg); await refresh(); toast('Notifications are on');
}
// Every visit, make sure the server still has this device's subscription.
async function syncPush() {
  try { if (S && 'Notification' in window && Notification.permission === 'granted') { const reg = await swReady(); if (reg) await subscribe(reg); } else await swReady(); } catch { /* not fatal */ }
}

// ---------- start ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.go) { const h = e.data.go.replace(/^\//, ''); location.hash = h.startsWith('#') ? h : '#/'; refresh(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
(async () => {
  // Something shared into the app from another app's Share menu arrives at /share?text=...
  if (location.pathname === '/share') {
    const q = new URLSearchParams(location.search);
    ui.shareText = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n');
    history.replaceState(null, '', '/#/new');
  }
  await refresh();
  if (!S) render();
  syncPush();
})();
