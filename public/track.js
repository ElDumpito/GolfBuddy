'use strict';
// Shot tracking, the gear closet ("Your bag") and trends. Plugs into app.js through
// extraViews (screens), handlers (button actions) and afterRender (GPS and the map).

// ---------- geometry (same formulas as the server) ----------
const RADS = Math.PI / 180;
function ydsBetween(a, b) {
  const dLat = (b.lat - a.lat) * RADS, dLon = (b.lon - a.lon) * RADS;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RADS) * Math.cos(b.lat * RADS) * Math.sin(dLon / 2) ** 2;
  return (2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))) / 0.9144;
}
function brg(a, b) {
  const y = Math.sin((b.lon - a.lon) * RADS) * Math.cos(b.lat * RADS);
  const x = Math.cos(a.lat * RADS) * Math.sin(b.lat * RADS) - Math.sin(a.lat * RADS) * Math.cos(b.lat * RADS) * Math.cos((b.lon - a.lon) * RADS);
  return (Math.atan2(y, x) / RADS + 360) % 360;
}
// Distance in yards from point p to the line segment a→b (flat-earth is fine at golf-hole scale).
function ydsToSegment(p, a, b) {
  const kx = Math.cos(p.lat * RADS) * 111320 / 0.9144, ky = 110574 / 0.9144;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function measure(points, green) {
  const pin = points.find((p) => p.kind === 'pin'), target = pin || green;
  return points.filter((p) => p.kind === 'shot').map((a) => {
    const i = points.indexOf(a), b = points[i + 1];
    const m = { ...a, yards: b ? Math.round(ydsBetween(a, b)) : null, offline: null };
    if (b && target && ydsBetween(a, target) > 40 && m.yards > 20) {
      const diff = ((brg(a, b) - brg(a, target) + 540) % 360) - 180;
      m.offline = Math.round(m.yards * Math.sin(diff * RADS));
    }
    return m;
  });
}

// ---------- shot tracker ----------
const T = { roundId: null, data: null, loading: false, auto: true, club: null, pos: null, heading: null, watch: null, suggest: null, map: null, mapEl: null, overlays: [], busy: false };
function trackRound() { const { seg } = route(); return seg[0] === 'r' && seg[2] === 'shots' ? Number(seg[1]) : null; }
async function loadShots(id) {
  T.loading = true;
  try { T.data = await api('GET', `/api/rounds/${id}/shots`); T.roundId = id; } catch (e) { toast(e.message); }
  T.loading = false; render();
}
const holeIndex = (r) => Math.min(ui.hole[r.id] ?? firstOpenHole(r), r.holes - 1);
const myPoints = (holeNo) => (T.data?.shots || []).filter((s) => s.userId === S.me.id && s.hole === holeNo).sort((a, b) => a.seq - b.seq);
const layout = (holeNo) => (T.data?.holes || []).find((h) => h.hole === holeNo) || null;

function suggestHole(r) {
  if (!T.pos || !T.data) return null;
  let best = null;
  for (const h of T.data.holes) {
    if (!h.tee || !h.green || h.hole < r.startHole || h.hole >= r.startHole + r.holes) continue;
    const d = ydsToSegment(T.pos, h.tee, h.green);
    if (!best || d < best.d) best = { hole: h.hole, d };
  }
  return best && best.d < 45 ? best.hole : null;
}
function onPosition(p) {
  T.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy / 0.9144), ts: p.timestamp };
  const r = S && S.rounds.find((x) => x.id === trackRound());
  if (r) {
    const cur = r.startHole + holeIndex(r), sug = suggestHole(r);
    const pts = myPoints(cur), finished = !pts.length || pts[pts.length - 1].kind === 'pin';
    T.suggest = sug && sug !== cur ? sug : null;
    // Auto: move on by itself only when this hole is untouched or finished, so a wayward shot onto
    // the next fairway doesn't jump you ahead mid-hole.
    if (T.auto && T.suggest && finished) { ui.hole[r.id] = T.suggest - r.startHole; T.suggest = null; }
  }
  if (!busyForm() && trackRound()) updateLive();
}
// Only the live numbers change on each GPS fix; the rest of the screen isn't redrawn.
function updateLive() {
  const r = S.rounds.find((x) => x.id === trackRound());
  if (!r) return;
  const holeNo = r.startHole + holeIndex(r);
  const L = layout(holeNo), pts = myPoints(holeNo), last = pts.filter((x) => x.kind === 'shot').pop();
  const set = (sel, v) => { const el = $(sel); if (el) el.innerHTML = v; };
  set('#live-green', T.pos && L?.green ? Math.round(ydsBetween(T.pos, L.green)) : '–');
  set('#live-last', T.pos && last ? Math.round(ydsBetween(last, T.pos)) : '–');
  set('#live-acc', T.pos ? `GPS ±${T.pos.acc} yd` : 'Waiting for GPS…');
  const sb = $('#suggest');
  if (sb) sb.innerHTML = T.suggest ? `<div class="note row"><span class="grow">Looks like you're on hole ${T.suggest}.</span><button class="chip" data-act="t-go-hole" data-v="${T.suggest}">Switch</button></div>` : '';
  drawMap(r, holeNo);
}
function startGps() {
  if (T.watch != null || !navigator.geolocation) return;
  T.watch = navigator.geolocation.watchPosition(onPosition, (e) => { if (e.code === 1) toast('Location is blocked for this site'); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  const onOrient = (e) => { if (e.absolute && e.alpha != null) T.heading = Math.round((360 - e.alpha) % 360); };
  window.addEventListener('deviceorientationabsolute', onOrient);
  T.stopOrient = () => window.removeEventListener('deviceorientationabsolute', onOrient);
}
function stopGps() {
  if (T.watch != null) navigator.geolocation.clearWatch(T.watch);
  T.watch = null; T.stopOrient?.(); T.stopOrient = null;
}

// --- the map: Google satellite when the browser key is set, otherwise a simple drawing ---
let mapsLoading = null;
function loadMaps() {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (mapsLoading) return mapsLoading;
  mapsLoading = new Promise((ok, no) => {
    window.__gbMapsReady = ok;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(S.mapsKey)}&v=weekly&loading=async&callback=__gbMapsReady`;
    s.async = true; s.onerror = () => { mapsLoading = null; no(new Error('Google Maps did not load')); };
    document.head.appendChild(s);
  });
  return mapsLoading;
}
function drawMap(r, holeNo) {
  const box = $('#shotmap');
  if (!box) return;
  const L = layout(holeNo);
  const mine = myPoints(holeNo);
  const theirs = (T.data?.shots || []).filter((s) => s.userId !== S.me.id && s.hole === holeNo).sort((a, b) => a.seq - b.seq);
  if (S.mapsKey) {
    if (!T.mapEl) { T.mapEl = document.createElement('div'); T.mapEl.style.cssText = 'position:absolute;inset:0'; }
    if (T.mapEl.parentNode !== box) { box.innerHTML = ''; box.appendChild(T.mapEl); }
    loadMaps().then(() => googleDraw(L, mine, theirs, holeNo)).catch(() => svgDraw(box, L, mine, theirs));
  } else svgDraw(box, L, mine, theirs);
}
function googleDraw(L, mine, theirs, holeNo) {
  const g = google.maps;
  if (!T.map) {
    T.map = new g.Map(T.mapEl, { mapTypeId: 'satellite', tilt: 0, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', backgroundColor: '#0e1512' });
  }
  T.overlays.forEach((o) => o.setMap(null)); T.overlays = [];
  const add = (o) => { T.overlays.push(o); return o; };
  const dot = (p, color, label, scale = 7) => add(new g.Marker({ map: T.map, position: { lat: p.lat, lng: p.lon }, label: label ? { text: String(label), color: '#111', fontSize: '11px', fontWeight: '700' } : undefined,
    icon: { path: g.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 } }));
  const line = (pts, color) => pts.length > 1 && add(new g.Polyline({ map: T.map, path: pts.map((p) => ({ lat: p.lat, lng: p.lon })), strokeColor: color, strokeOpacity: 0.95, strokeWeight: 2.5 }));
  const bounds = new g.LatLngBounds();
  const ext = (p) => p && bounds.extend({ lat: p.lat, lng: p.lon });
  if (L?.tee) { dot(L.tee, '#ece6d6', 'T', 8); ext(L.tee); }
  if (L?.green) { add(new g.Marker({ map: T.map, position: { lat: L.green.lat, lng: L.green.lon }, icon: { path: 'M0 0 L0 -26 L14 -20 L0 -14', strokeColor: '#fff', strokeWeight: 2, fillColor: '#cbab6b', fillOpacity: 1, scale: 1 } })); ext(L.green); }
  line(theirs, '#93b8d8'); theirs.forEach((p) => { dot(p, '#93b8d8', null, 5); ext(p); });
  line(mine, '#e3c88f'); mine.forEach((p, k) => { dot(p, p.kind === 'pin' ? '#86ba95' : '#e3c88f', p.kind === 'pin' ? '' : k + 1); ext(p); });
  if (T.pos) { dot(T.pos, '#4f8ef7', null, 6); ext(T.pos); }
  if (T.lastFit !== `${holeNo}:${mine.length}` && !bounds.isEmpty()) { T.map.fitBounds(bounds, 40); T.lastFit = `${holeNo}:${mine.length}`; if (T.map.getZoom() > 19) T.map.setZoom(19); }
}
function svgDraw(box, L, mine, theirs) {
  const pts = [L?.tee, L?.green, ...mine, ...theirs, T.pos].filter(Boolean);
  if (!pts.length) { box.innerHTML = `<div class="ph">${S.mapsKey ? 'Loading map…' : 'Your shots draw here as you mark them.<br>Add the Google browser key in Me › Admin for the satellite view.'}</div>`; return; }
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, kx = Math.cos(lat0 * RADS);
  const xy = (p) => ({ x: p.lon * kx, y: -p.lat });
  const P = pts.map(xy), minX = Math.min(...P.map((p) => p.x)), maxX = Math.max(...P.map((p) => p.x)), minY = Math.min(...P.map((p) => p.y)), maxY = Math.max(...P.map((p) => p.y));
  const W = box.clientWidth || 340, H = box.clientHeight || 340, pad = 30, span = Math.max(maxX - minX, maxY - minY, 1e-5);
  const s = (Math.min(W, H) - pad * 2) / span;
  const at = (p) => { const q = xy(p); return [(W - (maxX - minX) * s) / 2 + (q.x - minX) * s, (H - (maxY - minY) * s) / 2 + (q.y - minY) * s]; };
  const path = (arr, c) => arr.length > 1 ? `<polyline points="${arr.map((p) => at(p).join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="2"/>` : '';
  const circ = (p, c, r = 6, t = '') => { const [x, y] = at(p); return `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="#0b100e" stroke-width="1.5"/>${t ? `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="9" font-weight="700" fill="#111">${t}</text>` : ''}`; };
  box.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" style="display:block;background:radial-gradient(circle at 50% 40%, #183022, #0e1512)">
    ${L?.tee && L?.green ? `<line x1="${at(L.tee)[0]}" y1="${at(L.tee)[1]}" x2="${at(L.green)[0]}" y2="${at(L.green)[1]}" stroke="rgba(236,230,214,.18)" stroke-width="16" stroke-linecap="round"/>` : ''}
    ${L?.green ? circ(L.green, '#86ba95', 11) : ''}${L?.tee ? circ(L.tee, '#ece6d6', 6, 'T') : ''}
    ${path(theirs, '#93b8d8')}${theirs.map((p) => circ(p, '#93b8d8', 4)).join('')}
    ${path(mine, '#e3c88f')}${mine.map((p, k) => circ(p, p.kind === 'pin' ? '#86ba95' : '#e3c88f', 8, p.kind === 'pin' ? '' : k + 1)).join('')}
    ${T.pos ? circ(T.pos, '#4f8ef7', 6) : ''}</svg>`;
}

function viewShots(id) {
  const r = S.rounds.find((x) => x.id === id);
  if (!r) return frame({ title: 'Shots', back: '#/scores', tab: 'scores', body: `<div class="card empty">That scorecard isn't here any more.</div>` });
  if (T.roundId !== id && !T.loading) { T.data = null; T.map = null; T.mapEl = null; T.lastFit = null; loadShots(id); }
  const i = holeIndex(r), holeNo = r.startHole + i, par = r.pars[i] || 4;
  const L = layout(holeNo), pts = myPoints(holeNo), shots = measure(pts, L?.green);
  const club = T.club || (pts.filter((p) => p.kind === 'shot').length ? S.clubs[Math.min(9, S.clubs.length - 1)] : par === 3 ? (S.clubs.find((c) => /^7i$/i.test(c)) || S.clubs[0]) : S.clubs[0]);
  const holed = pts.some((p) => p.kind === 'pin');
  const theirs = S.users.filter((u) => u.id !== S.me.id).map((u) => ({ u, n: (T.data?.shots || []).filter((s) => s.userId === u.id && s.hole === holeNo && s.kind === 'shot').length })).filter((x) => x.n);
  const gear = T.data?.gear?.[S.me.id] || {};
  const pick = (kind, label) => { const items = S.gear.filter((g) => g.kind === kind && !g.retired); return items.length ? `<div><label for="pg-${kind}">${label}</label><select id="pg-${kind}" data-pg="${kind}"><option value="">—</option>${items.map((g) => `<option value="${g.id}" ${gear[kind] === g.id ? 'selected' : ''}>${esc(`${g.brand} ${g.model}`.trim())}</option>`).join('')}</select></div>` : ''; };
  const gearPicks = pick('ball', 'Ball') + pick('glove', 'Glove') + pick('shoes', 'Shoes');
  return frame({
    title: `Hole ${holeNo}`, back: `#/r/${r.id}`, tab: 'scores',
    right: `<button class="chip ${T.auto ? 'on' : ''}" data-act="t-auto">${icon('locate', 'sm')} Auto</button>`,
    body: `<div class="holebar">${r.pars.map((_, k) => `<button class="${k === i ? 'on' : myPoints(r.startHole + k).length ? 'done' : ''}" data-act="t-hole" data-v="${k}">${r.startHole + k}</button>`).join('')}</div>
    <div id="suggest"></div>
    <section class="card">
      <div class="grid2" style="align-items:end">
        <div><div class="over">To green</div><div class="yard num"><span id="live-green">–</span><span class="small dim"> yds</span></div></div>
        <div style="text-align:right"><div class="over">Since last shot</div><div class="big num"><span id="live-last">–</span><span class="small dim"> yds</span></div></div>
      </div>
      <div class="row tiny faint" style="margin-top:6px"><span id="live-acc" class="grow">Waiting for GPS…</span><span>Par ${par}${holeFacts(r, holeNo) ? ` · ${holeFacts(r, holeNo)}` : ''}</span></div>
      ${!L?.green ? `<div class="tiny faint" style="margin-top:6px">This hole's green isn't mapped yet. Tap “In the hole” at the cup once and it's remembered.</div>` : ''}
    </section>
    <div class="map" id="shotmap"><div class="ph">${T.loading ? 'Loading…' : ''}</div></div>
    <section class="card">
      <div class="over" style="margin-bottom:8px">Club for this shot</div>
      <div class="clubs">${S.clubs.map((c) => `<button class="${c === club ? 'on' : ''}" data-act="t-club" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <button class="primary block" style="margin-top:12px;min-height:54px;font-size:16px" data-act="t-mark" data-club="${esc(club)}" ${holed ? 'disabled' : ''}>${icon('locate')} Mark ball here · ${esc(club)}</button>
      ${T.pinAsk ? `<div class="note" style="margin-top:10px"><b>Holed out.</b> Putts after your last mark?<div class="seg" style="margin-top:8px">${[0, 1, 2, 3, 4].map((n) => `<button data-act="t-putts" data-v="${n}">${n}</button>`).join('')}</div>
        <div class="tiny faint" style="margin-top:6px">Your score for the hole = marked shots + these. It goes straight onto the scorecard.</div></div>` : ''}
      <div class="row" style="margin-top:8px"><button class="grow outline" data-act="t-pin" ${pts.length ? '' : 'disabled'}>${icon('flag')} In the hole</button>
        <label class="btn grow outline" style="margin:0" ${pts.length ? '' : 'aria-disabled="true"'}>${icon('camera')} Photo<input type="file" accept="image/*" capture="environment" id="t-photo" hidden ${pts.length ? '' : 'disabled'}></label></div>
      <p class="tiny faint" style="margin:10px 0 0">Stand by your ball, pick the club you're about to hit, tap Mark. Distances are the straight line between marks, good to a few yards.</p>
    </section>
    ${shots.length || holed ? `<section class="card"><div class="card-head"><h2>Your shots</h2>${holed ? `<span class="pill ok">${pts.filter((p) => p.kind === 'shot').length} to the hole</span>` : ''}</div>
      <div class="list">${shots.map((s, k) => `<div class="shot"><span class="no">${k + 1}</span>
        <select data-shot-club="${s.id}" style="width:auto;padding:6px 8px">${[...new Set([s.club, ...S.clubs])].filter(Boolean).map((c) => `<option ${c === s.club ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <span class="grow num">${s.yards != null ? `<b>${s.yards}</b> yds` : '<span class="faint">…</span>'}${s.offline != null && Math.abs(s.offline) > 5 ? ` <span class="tiny dim">${Math.abs(s.offline)} ${s.offline > 0 ? 'right' : 'left'}</span>` : ''}</span>
        ${s.photo ? `<a href="/api/photos/${s.id}" target="_blank"><img class="thumb" src="/api/photos/${s.id}" alt="" loading="lazy"></a>` : ''}
        <button class="x" data-act="t-del" data-id="${s.id}" aria-label="Remove">✕</button></div>`).join('')}
      ${holed ? `<div class="shot"><span class="no">${icon('flag', 'sm')}</span><span class="grow dim">In the hole</span><button class="x" data-act="t-del" data-id="${pts.find((p) => p.kind === 'pin').id}" aria-label="Remove">✕</button></div>` : ''}</div></section>` : ''}
    ${theirs.length ? `<div class="tiny faint">${theirs.map((x) => `${esc(x.u.name.split(/\s+/)[0])}: ${x.n} shot${x.n > 1 ? 's' : ''} on this hole (blue)`).join(' · ')}</div>` : ''}
    ${gearPicks ? `<section class="card"><div class="over">Playing today</div><div class="grid3">${gearPicks}</div></section>` : ''}`,
  });
}

// Photos: drawn onto a canvas with a caption band (time, GPS, distances), then saved as a JPEG.
async function stampPhoto(file, lines) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, W, H);
  const fs = Math.max(14, Math.round(W / 42)), lh = fs * 1.35, band = lh * lines.length + fs * 0.9;
  const grad = x.createLinearGradient(0, H - band - fs * 2, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.35, 'rgba(0,0,0,.55)'); grad.addColorStop(1, 'rgba(0,0,0,.78)');
  x.fillStyle = grad; x.fillRect(0, H - band - fs * 2, W, band + fs * 2);
  lines.forEach((t, k) => {
    x.font = `${k === 0 ? 600 : 400} ${k === 0 ? Math.round(fs * 1.15) : fs}px Inter, system-ui, sans-serif`;
    x.fillStyle = k === 0 ? '#e3c88f' : 'rgba(255,255,255,.92)';
    x.fillText(t, fs * 0.8, H - band + lh * (k + 0.9));
  });
  return c.toDataURL('image/jpeg', 0.84);
}

// ---------- the bag (gear closet) ----------
const KIND_LABEL = { driver: 'Driver', wood: 'Woods', hybrid: 'Hybrids', iron: 'Irons', wedge: 'Wedges', putter: 'Putter', ball: 'Balls', glove: 'Gloves', shoes: 'Shoes', bag: 'Bag', other: 'Other' };
function viewBag(seg) {
  if (seg[1] === 'new' || (seg[1] && seg[2] === 'edit')) return viewGearForm(seg[1] === 'new' ? null : Number(seg[1]));
  if (seg[1]) return viewGearItem(Number(seg[1]));
  const active = S.gear.filter((g) => !g.retired), retired = S.gear.filter((g) => g.retired);
  const groups = S.gearKinds.map((k) => [k, active.filter((g) => g.kind === k)]).filter(([, l]) => l.length);
  const row = (g) => `<a class="link-row" href="#/bag/${g.id}"><span class="grow"><b>${esc(`${g.brand} ${g.model}`.trim())}</b>${g.detail ? `<div class="small-text dim">${esc(g.detail)}</div>` : ''}</span><span class="faint">${icon('chev')}</span></a>`;
  return frame({
    title: 'Your bag', back: '#/me', tab: 'me', right: `<a class="btn quiet" href="#/bag/new" aria-label="Add">${icon('plus')}</a>`,
    body: `<section class="card"><div class="card-head"><h2>Clubs for shot tracking</h2></div>
      <p class="tiny faint" style="margin:0 0 8px">The short names shown when you mark a shot, longest to shortest.</p>
      <div class="row"><input id="clubs-list" class="grow" value="${esc(S.clubs.join(' '))}" autocapitalize="characters" spellcheck="false"><button class="outline" data-act="save-clubs">Save</button></div></section>
    ${groups.length ? groups.map(([k, l]) => `<section class="card flush"><div class="over" style="padding:14px 16px 0">${KIND_LABEL[k]}</div><div class="list">${l.map(row).join('')}</div></section>`).join('')
      : `<section class="card empty">Nothing here yet. Add clubs, balls, gloves and shoes, by barcode or by name.</section>`}
    <a class="btn primary block" href="#/bag/new">${icon('plus')} Add gear</a>
    ${retired.length ? `<details class="card"><summary>Retired (${retired.length})</summary><div class="list">${retired.map(row).join('')}</div></details>` : ''}`,
  });
}
const gearForm = { data: null, id: undefined, suggestions: [] };
function viewGearForm(id) {
  if (gearForm.id !== id || !gearForm.data) {
    const g = id ? S.gear.find((x) => x.id === id) : null;
    gearForm.id = id; gearForm.data = g ? { ...g } : { kind: 'ball', brand: '', model: '', detail: '', upc: '', notes: '' }; gearForm.suggestions = [];
  }
  const f = gearForm.data;
  const canScan = 'BarcodeDetector' in window;
  return frame({
    title: id ? 'Edit gear' : 'Add gear', back: id ? `#/bag/${id}` : '#/bag', tab: 'me',
    body: `<section class="card" id="gf">
      <label style="margin-top:0">What is it</label><div class="chips">${S.gearKinds.map((k) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-act="g-kind" data-v="${k}">${KIND_LABEL[k]}</button>`).join('')}</div>
      <label for="g-upc">Barcode (UPC)</label>
      <div class="row"><input id="g-upc" class="grow" inputmode="numeric" value="${esc(f.upc)}" placeholder="Scan or type the number">${canScan ? `<button class="outline" data-act="g-scan">${icon('camera')}Scan</button>` : ''}<button class="outline" data-act="g-lookup">Look up</button></div>
      <div id="scanbox"></div>
      <label for="g-brand">Brand</label><input id="g-brand" list="brandlist" value="${esc(f.brand)}" autocomplete="off"><datalist id="brandlist">${S.brands.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <label for="g-model">Model</label><input id="g-model" list="modellist" value="${esc(f.model)}" autocomplete="off" placeholder="Pro V1, T200, Tour Edge Exotics…">
      <datalist id="modellist">${gearForm.suggestions.map((s) => `<option value="${esc(s.model || s.title)}">${esc(s.title)}</option>`).join('')}</datalist>
      <label for="g-detail">Details</label><input id="g-detail" value="${esc(f.detail)}" placeholder="${{ driver: '10.5°, Ventus Blue 6S', iron: '5–PW, steel stiff', wedge: '56°/12 bounce', ball: 'Yellow, 2025', glove: 'Men’s ML, left hand', shoes: 'Size 10.5' }[f.kind] || ''}">
      <label for="g-notes">Notes</label><textarea id="g-notes" rows="2" placeholder="Bought at…, fitting specs, serial number">${esc(f.notes)}</textarea>
      <button class="primary block" style="margin-top:16px" data-act="g-save">${id ? 'Save' : 'Add to bag'}</button></section>`,
  });
}
function readGearInputs() {
  const f = gearForm.data; if (!f || !$('#gf')) return;
  f.upc = $('#g-upc').value; f.brand = $('#g-brand').value; f.model = $('#g-model').value; f.detail = $('#g-detail').value; f.notes = $('#g-notes').value;
}
function viewGearItem(id) {
  const g = S.gear.find((x) => x.id === id);
  if (!g) return frame({ title: 'Gear', back: '#/bag', tab: 'me', body: '<div class="card empty">Not in your bag.</div>' });
  const s = S.support[g.id];
  return frame({
    title: `${g.brand} ${g.model}`.trim(), back: '#/bag', tab: 'me', right: `<a class="btn quiet" href="#/bag/${g.id}/edit" aria-label="Edit">${icon('edit')}</a>`,
    body: `<section class="headline"><div class="over">${KIND_LABEL[g.kind]}${g.retired ? ' · retired' : ''}</div><div class="course">${esc(g.model || g.brand)}</div><div class="when">${esc(g.brand)}${g.detail ? ` · ${esc(g.detail)}` : ''}</div></section>
    <section class="card"><div class="kv">
      <span>Added</span><span>${fDay(g.added)}</span>${g.upc ? `<span>Barcode</span><span class="num">${esc(g.upc)}</span>` : ''}
    </div>${g.notes ? `<p class="small-text dim" style="white-space:pre-wrap;margin:12px 0 0">${esc(g.notes)}</p>` : ''}</section>
    ${s ? `<section class="card"><div class="card-head"><h2>${esc(s.brand)} support</h2></div>
      <div class="quick" style="grid-template-columns:repeat(${s.phone ? 2 : 1},1fr)">${s.phone ? `<a class="btn" href="${telUrl(s.phone)}">${icon('phone')}${esc(s.phone)}</a>` : ''}<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${icon('globe')}Support site</a></div>
      ${s.hours ? `<div class="tiny faint" style="margin-top:8px">${esc(s.hours)} · warranty and repairs</div>` : ''}</section>`
      : g.brand ? `<section class="card"><a class="link-row" style="padding:0" href="https://www.google.com/search?q=${encodeURIComponent(`${g.brand} golf customer service warranty`)}" target="_blank" rel="noopener"><span class="ic">${icon('globe')}</span><span class="grow">Find ${esc(g.brand)} support</span><span class="faint">${icon('chev')}</span></a></section>` : ''}
    <section class="row"><button class="grow outline" data-act="g-retire" data-id="${g.id}" data-v="${g.retired ? 0 : 1}">${g.retired ? 'Back in the bag' : 'Retire'}</button><button class="quiet danger" data-act="g-del" data-id="${g.id}">Delete</button></section>`,
  });
}
// Live camera barcode scanning (Chrome on Android has a built-in barcode reader).
async function scanBarcode() {
  const box = $('#scanbox');
  const det = new BarcodeDetector({ formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  box.innerHTML = '<div style="position:relative;margin-top:10px"><video playsinline muted style="width:100%;border-radius:14px;display:block"></video><button class="chip" style="position:absolute;right:8px;top:8px" data-act="g-scan-stop">Stop</button></div>';
  const v = box.querySelector('video'); v.srcObject = stream; await v.play();
  window.__scanning = true;
  T.scanStop = () => { stream.getTracks().forEach((t) => t.stop()); box.innerHTML = ''; T.scanStop = null; window.__scanning = false; };
  const t0 = Date.now();
  while (T.scanStop && Date.now() - t0 < 30000) {
    const codes = await det.detect(v).catch(() => []);
    if (codes.length) { const code = codes[0].rawValue; T.scanStop(); $('#g-upc').value = code; return code; }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  T.scanStop?.(); return null;
}
async function lookupUpc() {
  readGearInputs();
  const upc = gearForm.data.upc.replace(/\D/g, '');
  if (!upc) return toast('Scan or type the barcode first');
  const r = await api('GET', `/api/gear/lookup?upc=${upc}`);
  if (!r.item) return toast('Not found. Type the brand and model instead.');
  const f = gearForm.data;
  const brand = S.brands.find((b) => b.toLowerCase() === String(r.item.brand || '').toLowerCase()) || r.item.brand || '';
  f.brand = f.brand || brand; f.model = f.model || r.item.model || r.item.title; f.upc = upc;
  if (/ball/i.test(r.item.category + r.item.title)) f.kind = 'ball'; else if (/glove/i.test(r.item.title)) f.kind = 'glove'; else if (/shoe/i.test(r.item.category + r.item.title)) f.kind = 'shoes';
  render(); toast(`Found: ${r.item.title}`);
}

// ---------- trends ----------
let trendData = null;
function viewTrends() {
  if (!trendData) api('GET', '/api/shots/stats').then((d) => { trendData = d; render(); }).catch((e) => toast(e.message));
  const d = trendData;
  const mineRounds = S.rounds.map((r) => ({ r, s: r.scores.find((x) => x.userId === S.me.id) })).filter((x) => x.s).map((x) => ({ ...x, t: totals(x.r, x.s) }))
    .filter((x) => x.t.n === x.r.holes).sort((a, b) => a.r.playedOn - b.r.playedOn);
  const eighteen = mineRounds.filter((x) => x.r.holes === 18);
  const spark = (vals) => {
    if (vals.length < 2) return '';
    const W = 300, H = 70, mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
    const pts = vals.map((v, k) => `${(k / (vals.length - 1)) * W},${H - 8 - ((v - mn) / sp) * (H - 16)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;margin-top:8px"><polyline points="${pts}" fill="none" stroke="#cbab6b" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const maxAvg = d?.clubs?.length ? Math.max(...d.clubs.map((c) => c.longest)) : 1;
  return frame({
    title: 'Your game', back: '#/scores', tab: 'scores',
    body: `<section class="card"><div class="card-head"><h2>Scoring</h2></div>
      ${eighteen.length ? `<div class="row"><div class="grow"><div class="over">Average (18)</div><div class="big num">${Math.round(eighteen.reduce((a, x) => a + x.t.strokes, 0) / eighteen.length)}</div></div>
        <div class="grow"><div class="over">Best</div><div class="big num">${Math.min(...eighteen.map((x) => x.t.strokes))}</div></div><div class="grow"><div class="over">Rounds</div><div class="big num">${eighteen.length}</div></div></div>
        ${spark(eighteen.slice(-20).map((x) => x.t.toPar))}<div class="tiny faint">Strokes over par, last ${Math.min(20, eighteen.length)} full rounds</div>`
        : `<div class="empty">Finish an 18-hole scorecard to see scoring trends.</div>`}</section>
    <section class="card"><div class="card-head"><h2>Distance by club</h2></div>
      ${!d ? '<div class="empty">Loading…</div>' : d.clubs.length ? d.clubs.map((c) => `<div style="padding:8px 0">
        <div class="row"><b style="width:44px">${esc(c.club)}</b><span class="grow"><div class="bar"><i style="width:${(c.avg / maxAvg) * 100}%"></i></div></span><span class="mid num" style="width:56px;text-align:right">${c.avg}</span></div>
        <div class="tiny faint" style="margin-left:52px">${c.shots} shot${c.shots > 1 ? 's' : ''} · long ${c.longest}${c.left + c.right + c.straight ? ` · ${c.left} left · ${c.straight} on line · ${c.right} right` : ''}</div></div>`).join('')
        : `<div class="empty">Track shots during a round (from any scorecard, tap Shots) and your distances build up here.</div>`}
      ${d?.holesTracked ? `<div class="tiny faint" style="margin-top:8px">${d.rounds} round${d.rounds > 1 ? 's' : ''}, ${d.holesTracked} holes tracked${d.putts ? ` · ${(d.putts / d.holesTracked).toFixed(1)} putts a hole` : ''}. Yards are straight-line GPS distance, not carry.</div>` : ''}</section>`,
  });
}

// ---------- wiring ----------
extraViews.shots = (id) => viewShots(id);
extraViews.bag = (seg) => viewBag(seg);
extraViews.trends = () => viewTrends();

window.afterRender = () => {
  if (trackRound()) { startGps(); const r = S.rounds.find((x) => x.id === trackRound()); if (r && T.data) { updateLive(); } }
  else { stopGps(); if (T.scanStop && route().seg[0] !== 'bag') T.scanStop(); }
};

Object.assign(handlers, {
  't-auto': () => { T.auto = !T.auto; toast(T.auto ? 'Auto: follows your position between holes' : 'Auto off: pick holes yourself'); render(); },
  't-hole': (el, seg) => { ui.hole[Number(seg[1])] = Number(el.dataset.v); T.suggest = null; T.club = null; render(); },
  't-go-hole': (el, seg) => { const r = S.rounds.find((x) => x.id === Number(seg[1])); ui.hole[r.id] = Number(el.dataset.v) - r.startHole; T.suggest = null; T.club = null; render(); },
  't-club': (el) => { T.club = el.dataset.v; render(); },
  't-mark': async (el, seg) => markPoint(Number(seg[1]), 'shot', el.dataset.club),
  't-pin': () => { T.pinAsk = !T.pinAsk; render(); },
  't-putts': async (el, seg) => { T.pinAsk = false; await markPoint(Number(seg[1]), 'pin', '', Number(el.dataset.v)); },
  't-del': async (el) => { if (!confirm('Remove this mark?')) return; await api('DELETE', `/api/shots/${el.dataset.id}`); T.data.shots = T.data.shots.filter((s) => s.id !== Number(el.dataset.id)); render(); },
  'save-clubs': async () => { const list = $('#clubs-list').value.split(/[\s,]+/).filter(Boolean); const r = await api('PUT', '/api/gear/clubs', { clubs: list }); S.clubs = r.clubs; toast('Clubs saved'); render(); },
  'g-kind': (el) => { readGearInputs(); gearForm.data.kind = el.dataset.v; render(); },
  'g-scan': async () => { readGearInputs(); try { const code = await scanBarcode(); if (code) { gearForm.data.upc = code; await lookupUpc(); } else toast('No barcode seen'); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Camera is blocked for this site' : e.message); } },
  'g-scan-stop': () => T.scanStop?.(),
  'g-lookup': async () => { try { await lookupUpc(); } catch (e) { toast(e.message); } },
  'g-save': async () => {
    readGearInputs();
    const f = gearForm.data, id = gearForm.id;
    const r = id ? await api('PUT', `/api/gear/${id}`, f) : await api('POST', '/api/gear', f);
    gearForm.data = null; gearForm.id = undefined; await refresh(false); toast(id ? 'Saved' : 'Added to your bag'); go(`#/bag/${r.gear.id}`);
  },
  'g-retire': async (el) => { await api('PUT', `/api/gear/${el.dataset.id}`, { retired: el.dataset.v === '1' }); await refresh(); },
  'g-del': async (el) => { if (!confirm('Delete this from your bag?')) return; await api('DELETE', `/api/gear/${el.dataset.id}`); await refresh(false); go('#/bag'); },
});

async function markPoint(roundId, kind, club, putts) {
  if (T.busy) return;
  const r = S.rounds.find((x) => x.id === roundId);
  if (!T.pos) return toast('Waiting for GPS. Step outside of cover and give it a few seconds.');
  if (Date.now() - T.pos.ts > 30000) return toast('GPS position is stale. Hold on a moment.');
  if (T.pos.acc > 30 && !confirm(`GPS is only good to about ${T.pos.acc} yards right now. Mark anyway?`)) return;
  T.busy = true;
  try {
    const holeNo = r.startHole + holeIndex(r);
    const x = await api('POST', `/api/rounds/${roundId}/shots`, { hole: holeNo, kind, club, putts, lat: T.pos.lat, lon: T.pos.lon, acc: T.pos.acc, heading: T.heading, ts: Date.now() });
    if (x.round) { const i = S.rounds.findIndex((y) => y.id === roundId); if (i >= 0) S.rounds[i] = x.round; }
    if (kind === 'pin') T.data.shots = T.data.shots.filter((s) => !(s.userId === S.me.id && s.hole === holeNo && s.kind === 'pin'));
    T.data.shots.push(x.shot);
    const L = layout(holeNo);
    if (kind === 'pin' && !L?.green) T.data.holes.push({ hole: holeNo, tee: null, green: { lat: T.pos.lat, lon: T.pos.lon }, source: 'you' });
    if (navigator.vibrate) navigator.vibrate(30);
    T.club = null;
    toast(kind === 'pin' ? (x.round ? `Holed · ${x.round.scores.find((s) => s.userId === S.me.id).strokes[holeNo - r.startHole]} on the card` : 'Holed') : `Marked · ${club}`);
    // On to the next hole once this one's in.
    if (kind === 'pin' && holeIndex(r) < r.holes - 1) { ui.hole[r.id] = holeIndex(r) + 1; T.lastFit = null; }
    render();
  } finally { T.busy = false; }
}

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.shotClub) {
    try { const r = await api('PUT', `/api/shots/${t.dataset.shotClub}`, { club: t.value }); const s = T.data.shots.find((x) => x.id === r.shot.id); if (s) s.club = r.shot.club; } catch (err) { toast(err.message); }
  }
  if (t.dataset.pg) {
    const body = Object.fromEntries($$('[data-pg]').map((s) => [s.dataset.pg, s.value ? Number(s.value) : null]));
    try { await api('PUT', `/api/rounds/${trackRound()}/gear`, body); (T.data.gear[S.me.id] = body); } catch (err) { toast(err.message); }
  }
  if (t.id === 't-photo' && t.files?.[0]) {
    const r = S.rounds.find((x) => x.id === trackRound()), holeNo = r.startHole + holeIndex(r);
    const pts = myPoints(holeNo), last = [...pts].reverse().find((p) => p.kind === 'shot') || pts[pts.length - 1];
    if (!last) return toast('Mark the ball first, then add a photo');
    const L = layout(holeNo), at = T.pos || last, k = pts.filter((p) => p.kind === 'shot').indexOf(last) + 1;
    try {
      toast('Saving photo…');
      const lines = [`${r.course} · Hole ${holeNo} · Shot ${k}${last.club ? ` · ${last.club}` : ''}`, `${fLongDay(Date.now())} · ${fTime(Date.now())}`,
        `${at.lat.toFixed(6)}, ${at.lon.toFixed(6)}${T.pos ? ` ±${T.pos.acc} yd` : ''}`, [L?.green ? `${Math.round(ydsBetween(at, L.green))} yds to green` : '', pts.indexOf(last) > 0 ? `${Math.round(ydsBetween(pts[pts.indexOf(last) - 1], last))} yds last shot` : ''].filter(Boolean).join(' · ')].filter(Boolean);
      const data = await stampPhoto(t.files[0], lines);
      await api('POST', `/api/shots/${last.id}/photo`, { data });
      last.photo = true; render(); toast('Photo saved to shot ' + k);
    } catch (err) { toast(err.message || 'Photo failed'); }
    t.value = '';
  }
});
// Model suggestions while typing (brand + model words go to the product database).
let suggestT = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'g-model') return;
  clearTimeout(suggestT);
  suggestT = setTimeout(async () => {
    const text = `${$('#g-brand').value} ${e.target.value}`.trim();
    if (text.length < 4) return;
    const r = await api('GET', `/api/gear/search?q=${encodeURIComponent(text)}`).catch(() => ({ items: [] }));
    gearForm.suggestions = r.items;
    const dl = $('#modellist');
    if (dl) dl.innerHTML = r.items.map((s) => `<option value="${esc(s.model || s.title)}">${esc(s.title)}</option>`).join('');
  }, 450);
});
