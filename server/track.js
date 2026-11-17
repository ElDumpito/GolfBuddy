'use strict';
// Shot tracking and the gear closet.
//
// A hole is a list of points, one per ball position: each "shot" point is where a ball was hit
// from (with the club used); an optional last "pin" point is where it went in. A shot's distance
// is the straight line to the next point. Positions come from the phone's live GPS when you tap
// "Mark ball here" (photos taken in the browser on Android lose their GPS tags, so they can't be
// the source). Hole layouts (tee and green) come from OpenStreetMap where volunteers have mapped
// the course, and otherwise are learned from your own first tee shot and pin on each hole.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const svc = require('./services');
const { yards, bearing } = require('./geo');
const BRANDS = require('./brands.json');

const raw = db.raw;
raw.exec(`
CREATE TABLE IF NOT EXISTS shots (id INTEGER PRIMARY KEY, round_id INTEGER, user_id INTEGER, hole INTEGER, seq INTEGER, kind TEXT DEFAULT 'shot',
  lat REAL, lon REAL, acc REAL, club TEXT, heading REAL, ts INTEGER, photo INTEGER DEFAULT 0, note TEXT, deleted INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS shots_round ON shots(round_id, user_id, hole);
CREATE TABLE IF NOT EXISTS holes (course_id INTEGER, hole INTEGER, tee_lat REAL, tee_lon REAL, green_lat REAL, green_lon REAL, source TEXT, PRIMARY KEY(course_id, hole));
CREATE TABLE IF NOT EXISTS gear (id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, brand TEXT, model TEXT, detail TEXT, upc TEXT, notes TEXT, added INTEGER, retired INTEGER DEFAULT 0);
`);
{ // which ball / glove / shoes each person played in a round
  const have = new Set(raw.prepare('PRAGMA table_info(scores)').all().map((c) => c.name));
  if (!have.has('gear')) raw.exec('ALTER TABLE scores ADD COLUMN gear TEXT');
}
const q = (sql) => raw.prepare(sql);
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const PHOTOS = path.join(db.dataDir, 'photos');
fs.mkdirSync(PHOTOS, { recursive: true });

const KINDS = ['driver', 'wood', 'hybrid', 'iron', 'wedge', 'putter', 'ball', 'glove', 'shoes', 'bag', 'other'];
const DEFAULT_CLUBS = ['Dr', '3W', '5W', '4H', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW', 'Pt'];

const shotRow = (s) => ({ id: s.id, roundId: s.round_id, userId: s.user_id, hole: s.hole, seq: s.seq, kind: s.kind, lat: s.lat, lon: s.lon, acc: s.acc, club: s.club || '',
  heading: s.heading, ts: s.ts, photo: !!s.photo, note: s.note || '' });
const gearRow = (g) => ({ id: g.id, kind: g.kind, brand: g.brand || '', model: g.model || '', detail: g.detail || '', upc: g.upc || '', notes: g.notes || '', added: g.added, retired: !!g.retired });

// ---- hole layouts --------------------------------------------------------------
function holesFor(courseId) {
  return q('SELECT hole, tee_lat, tee_lon, green_lat, green_lon, source FROM holes WHERE course_id=? ORDER BY hole').all(courseId)
    .map((h) => ({ hole: h.hole, tee: h.tee_lat != null ? { lat: h.tee_lat, lon: h.tee_lon } : null, green: h.green_lat != null ? { lat: h.green_lat, lon: h.green_lon } : null, source: h.source }));
}
function learn(courseId, hole, which, p) {
  if (!courseId) return;
  const cur = q('SELECT * FROM holes WHERE course_id=? AND hole=?').get(courseId, hole);
  if (cur?.source === 'osm' && cur[`${which}_lat`] != null) return; // mapped data wins over one person's tap
  if (cur && cur[`${which}_lat`] != null) return;                     // first one learned is kept
  q(`INSERT INTO holes(course_id, hole, ${which}_lat, ${which}_lon, source) VALUES(?,?,?,?,?)
     ON CONFLICT(course_id, hole) DO UPDATE SET ${which}_lat=excluded.${which}_lat, ${which}_lon=excluded.${which}_lon, source=COALESCE(holes.source, excluded.source)`)
    .run(courseId, hole, p.lat, p.lon, 'you');
}

// Is a point inside a closed ring of {lat, lon}? (ray casting)
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
const norm = (s) => String(s || '').toLowerCase().replace(/golf|course|club|park|the|at|-|municipal|\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();

// Pick out one course's holes from an OpenStreetMap answer (pure function, tested).
function holesFromOsm(elements, course) {
  const toPts = (g) => (g || []).map((n) => ({ lat: n.lat, lon: n.lon }));
  // Course outlines whose name matches ours, so two courses sharing a park (Wilson and Harding) don't mix.
  const want = norm(course.name).split(' ').filter((w) => w.length > 2);
  const outlines = [];
  for (const e of elements) {
    if (e.tags?.leisure !== 'golf_course') continue;
    const name = norm(e.tags.name);
    if (!want.length || !want.some((w) => name.includes(w))) continue;
    if (e.type === 'way' && e.geometry) outlines.push(toPts(e.geometry));
    if (e.type === 'relation') for (const m of e.members || []) if (m.role !== 'inner' && m.geometry) outlines.push(toPts(m.geometry));
  }
  const byRef = new Map();
  for (const e of elements) {
    if (e.type !== 'way' || e.tags?.golf !== 'hole' || !e.geometry?.length) continue;
    const ref = parseInt(e.tags.ref, 10);
    if (!(ref >= 1 && ref <= 18)) continue;
    const pts = toPts(e.geometry), mid = pts[Math.floor(pts.length / 2)];
    const inside = outlines.some((r) => r.length > 3 && inRing(mid, r));
    const d = course.lat != null ? yards(mid, { lat: course.lat, lon: course.lon }) : 0;
    const cand = { ref, tee: pts[0], green: pts[pts.length - 1], inside, d, par: parseInt(e.tags.par, 10) || null };
    const prev = byRef.get(ref);
    // Prefer holes inside the matching outline, then the one nearest the course's own coordinates.
    if (!prev || (cand.inside && !prev.inside) || (cand.inside === prev.inside && cand.d < prev.d)) byRef.set(ref, cand);
  }
  return [...byRef.values()].sort((a, b) => a.ref - b.ref);
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function fetchOsmHoles(course) {
  if (course.lat == null) return [];
  const query = `[out:json][timeout:25];(way["golf"="hole"](around:2500,${course.lat},${course.lon});way["leisure"="golf_course"](around:2500,${course.lat},${course.lon});relation["leisure"="golf_course"](around:2500,${course.lat},${course.lon}););out geom tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await svc.getJson(url, { method: 'POST', name: 'OpenStreetMap', timeout: 30000, body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      return holesFromOsm(r.elements || [], course);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
// Look the course up on OpenStreetMap once a week at most; anything found replaces learned taps.
async function ensureHoles(courseId) {
  const c = db.courseById(courseId);
  if (!c) return [];
  const tried = Number(db.getSetting(`osm:${courseId}`) || 0);
  if (Date.now() - tried > 7 * 86400000) {
    db.setSetting(`osm:${courseId}`, Date.now());
    try {
      const found = await fetchOsmHoles(c);
      const ins = q(`INSERT INTO holes(course_id, hole, tee_lat, tee_lon, green_lat, green_lon, source) VALUES(?,?,?,?,?,?,'osm')
        ON CONFLICT(course_id, hole) DO UPDATE SET tee_lat=excluded.tee_lat, tee_lon=excluded.tee_lon, green_lat=excluded.green_lat, green_lon=excluded.green_lon, source='osm'`);
      for (const h of found) ins.run(courseId, h.ref, h.tee.lat, h.tee.lon, h.green.lat, h.green.lon);
    } catch (e) { console.warn('hole layouts:', e.message); }
  }
  return holesFor(courseId);
}

// ---- distances and tendencies -------------------------------------------------------
// For one person's points on one hole (in order), the length and line of each shot.
function measureHole(points, green) {
  const out = [];
  const pin = points.find((p) => p.kind === 'pin') || null;
  const target = pin || green;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (a.kind !== 'shot') continue;
    const b = points[i + 1];
    const m = { id: a.id, club: a.club, yards: null, offline: null, toTarget: target ? Math.round(yards(a, target)) : null };
    if (b) {
      m.yards = Math.round(yards(a, b));
      // Left/right miss compared with the straight line to the pin (or green), for full shots only.
      if (target && m.toTarget > 40 && m.yards > 20) {
        let diff = bearing(a, b) - bearing(a, target);
        diff = ((diff + 540) % 360) - 180;
        m.offline = Math.round(m.yards * Math.sin((diff * Math.PI) / 180)); // + right, - left
      }
    }
    out.push(m);
  }
  return out;
}

function myShots(userId) {
  return q('SELECT s.*, r.course_id cid FROM shots s JOIN rounds r ON r.id=s.round_id WHERE s.user_id=? AND s.deleted=0 AND r.deleted=0 ORDER BY s.round_id, s.hole, s.seq')
    .all(userId);
}
// Per-club averages across every tracked round.
function clubStats(userId) {
  const rows = myShots(userId);
  const greens = new Map();
  const groups = new Map();
  for (const s of rows) {
    const k = `${s.round_id}:${s.hole}`;
    if (!groups.has(k)) groups.set(k, { cid: s.cid, hole: s.hole, pts: [] });
    groups.get(k).pts.push(shotRow(s));
  }
  const by = new Map();
  let putts = 0, holesTracked = 0;
  for (const g of groups.values()) {
    holesTracked++;
    if (!greens.has(g.cid)) greens.set(g.cid, new Map(holesFor(g.cid).map((h) => [h.hole, h.green])));
    for (const m of measureHole(g.pts, greens.get(g.cid).get(g.hole))) {
      if (/^p(t|utt)/i.test(m.club)) { putts++; continue; }
      if (m.yards == null || !m.club) continue;
      const c = by.get(m.club) || { club: m.club, n: 0, sum: 0, max: 0, all: [], left: 0, right: 0, straight: 0, off: [] };
      c.n++; c.sum += m.yards; c.max = Math.max(c.max, m.yards); c.all.push(m.yards);
      if (m.offline != null) { c.off.push(m.offline); if (m.offline < -10) c.left++; else if (m.offline > 10) c.right++; else c.straight++; }
      by.set(m.club, c);
    }
  }
  const order = (c) => { const i = DEFAULT_CLUBS.indexOf(c); return i < 0 ? 50 : i; };
  const clubs = [...by.values()].map((c) => {
    const sorted = c.all.sort((a, b) => a - b);
    return { club: c.club, shots: c.n, avg: Math.round(c.sum / c.n), median: sorted[Math.floor(sorted.length / 2)], longest: c.max,
      left: c.left, right: c.right, straight: c.straight, avgOffline: c.off.length ? Math.round(c.off.reduce((a, x) => a + x, 0) / c.off.length) : null };
  }).sort((a, b) => order(a.club) - order(b.club) || b.avg - a.avg);
  return { clubs, putts, holesTracked, rounds: new Set(rows.map((r) => r.round_id)).size };
}

// ---- gear lookups (UPCitemdb's free tier: about 100 lookups a day) ---------------------
async function upcLookup(upc) {
  return svc.cached(`upc:${upc}`, 30 * 86400000, async () => {
    const r = await svc.getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, { name: 'Product lookup' }).catch((e) => (e.status === 400 ? { items: [] } : Promise.reject(e)));
    const it = r?.items?.[0];
    return it ? { title: it.title, brand: it.brand, model: it.model, category: it.category } : null;
  });
}
async function productSearch(text) {
  return svc.cached(`ps:${text.toLowerCase()}`, 7 * 86400000, async () => {
    const r = await svc.getJson(`https://api.upcitemdb.com/prod/trial/search?s=${encodeURIComponent(text)}&match_mode=0&type=product`, { name: 'Product search' });
    const seen = new Set();
    return (r?.items || []).filter((it) => /golf/i.test(it.category || it.title)).map((it) => ({ title: it.title.replace(/\s*\([A-Z0-9]{10}\)\s*$/, ''), brand: it.brand, model: it.model, upc: it.upc }))
      .filter((it) => { const k = `${it.brand}|${it.model}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  });
}
function supportFor(brand) {
  const b = String(brand || '').toLowerCase();
  for (const [name, s] of Object.entries(BRANDS.support)) if (s.covers.some((c) => c.toLowerCase() === b)) return { brand: name, ...s };
  return null;
}

// ---- routes -------------------------------------------------------------------------
const num = (x) => (x === '' || x == null ? null : Number(x));
async function handle(req, res, url, me, body, { send, bad, readBody }) {
  const p = url.pathname, m = req.method;
  const seg = p.split('/').filter(Boolean);
  const id = Number(seg[2]);

  // Shots on a round: everyone's (it's a two-person app), plus hole layouts.
  if (seg[1] === 'rounds' && seg[3] === 'shots') {
    const r = db.roundById(id);
    if (!r) return bad('That scorecard no longer exists', 404);
    if (m === 'GET') {
      const holes = r.courseId ? await ensureHoles(r.courseId) : [];
      const shots = q('SELECT * FROM shots WHERE round_id=? AND deleted=0 ORDER BY user_id, hole, seq').all(id).map(shotRow);
      const gear = Object.fromEntries(q('SELECT user_id, gear FROM scores WHERE round_id=?').all(id).map((s) => [s.user_id, json(s.gear, {})]));
      return send(res, 200, { holes, shots, gear });
    }
    if (m === 'POST') {
      const hole = Math.round(Number(body.hole));
      if (!(hole >= 1 && hole <= 18)) return bad('Which hole?');
      const lat = Number(body.lat), lon = Number(body.lon);
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (!lat && !lon)) return bad('No GPS position yet');
      const kind = body.kind === 'pin' ? 'pin' : 'shot';
      const seq = (q('SELECT MAX(seq) m FROM shots WHERE round_id=? AND user_id=? AND hole=? AND deleted=0').get(id, me.id, hole).m || 0) + 1;
      if (kind === 'pin') q("UPDATE shots SET deleted=1 WHERE round_id=? AND user_id=? AND hole=? AND kind='pin'").run(id, me.id, hole);
      const sid = Number(q('INSERT INTO shots(round_id, user_id, hole, seq, kind, lat, lon, acc, club, heading, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, me.id, hole, seq, kind, lat, lon, num(body.acc), String(body.club || '').slice(0, 12), num(body.heading), Number(body.ts) || Date.now()).lastInsertRowid);
      if (seq === 1 && kind === 'shot' && (num(body.acc) ?? 99) <= 25) learn(r.courseId, hole, 'tee', { lat, lon });
      if (kind === 'pin' && (num(body.acc) ?? 99) <= 25) learn(r.courseId, hole, 'green', { lat, lon });
      return send(res, 200, { shot: shotRow(q('SELECT * FROM shots WHERE id=?').get(sid)) });
    }
  }
  if (seg[1] === 'rounds' && seg[3] === 'gear' && m === 'PUT') {
    const g = {};
    for (const k of ['ball', 'glove', 'shoes']) if (body[k]) g[k] = Number(body[k]);
    q('INSERT INTO scores(round_id, user_id, strokes, gear) VALUES(?,?,?,?) ON CONFLICT(round_id, user_id) DO UPDATE SET gear=excluded.gear').run(id, me.id, '[]', JSON.stringify(g));
    return send(res, 200, { ok: true });
  }

  if (seg[1] === 'shots') {
    if (p === '/api/shots/stats' && m === 'GET') return send(res, 200, clubStats(me.id));
    const s = q('SELECT * FROM shots WHERE id=? AND deleted=0').get(id);
    if (!s) return bad('That shot is gone', 404);
    if (s.user_id !== me.id) return bad('Only your own shots', 403);
    if (m === 'PUT') {
      q('UPDATE shots SET club=?, note=? WHERE id=?').run(String(body.club ?? s.club ?? '').slice(0, 12), String(body.note ?? s.note ?? '').slice(0, 200), id);
      return send(res, 200, { shot: shotRow(q('SELECT * FROM shots WHERE id=?').get(id)) });
    }
    if (m === 'DELETE') { q('UPDATE shots SET deleted=1 WHERE id=?').run(id); return send(res, 200, { ok: true }); }
    if (m === 'POST' && seg[3] === 'photo') {
      const data = String(body.data || '');
      const mt = data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!mt) return bad('Photo must be a JPEG');
      const buf = Buffer.from(mt[1], 'base64');
      if (buf.length > 4e6 || buf[0] !== 0xff || buf[1] !== 0xd8) return bad('Photo too large or not a JPEG');
      fs.writeFileSync(path.join(PHOTOS, `${id}.jpg`), buf);
      q('UPDATE shots SET photo=1 WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
  }
  if (seg[1] === 'photos' && m === 'GET') {
    const f = path.join(PHOTOS, `${id}.jpg`);
    if (!Number.isInteger(id) || !fs.existsSync(f)) return bad('No photo', 404);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(f).pipe(res);
    return true;
  }

  if (seg[1] === 'courses' && seg[3] === 'holes' && m === 'GET') return send(res, 200, { holes: await ensureHoles(id) });

  if (seg[1] === 'gear') {
    if (p === '/api/gear/lookup' && m === 'GET') {
      const upc = String(url.searchParams.get('upc') || '').replace(/\D/g, '');
      if (!/^\d{8,14}$/.test(upc)) return bad('That barcode number looks wrong');
      try { return send(res, 200, { item: await upcLookup(upc) }); } catch (e) { return bad(e.message, 502); }
    }
    if (p === '/api/gear/search' && m === 'GET') {
      const text = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      if (text.length < 3) return send(res, 200, { items: [] });
      try { return send(res, 200, { items: await productSearch(text) }); } catch (e) { return send(res, 200, { items: [], error: e.message }); }
    }
    if (p === '/api/gear/clubs' && m === 'PUT') {
      // The short club names shown when tracking a shot, in bag order (e.g. Dr, 3W, 4H, 5i … LW, Pt).
      const list = [...new Set((Array.isArray(body.clubs) ? body.clubs : []).map((c) => String(c).trim().slice(0, 6)).filter(Boolean))].slice(0, 20);
      db.setSetting(`clubs:${me.id}`, JSON.stringify(list));
      return send(res, 200, { clubs: list.length ? list : DEFAULT_CLUBS });
    }
    const readGear = () => {
      const kind = KINDS.includes(body.kind) ? body.kind : 'other';
      const brand = String(body.brand || '').trim().slice(0, 40), model = String(body.model || '').trim().slice(0, 80);
      if (!brand && !model) return { err: 'Brand or model, please' };
      return { g: { kind, brand, model, detail: String(body.detail || '').trim().slice(0, 80), upc: String(body.upc || '').replace(/\D/g, '').slice(0, 14), notes: String(body.notes || '').trim().slice(0, 500) } };
    };
    if (m === 'POST' && seg.length === 2) {
      const r = readGear(); if (r.err) return bad(r.err);
      const gid = Number(q('INSERT INTO gear(user_id, kind, brand, model, detail, upc, notes, added) VALUES(?,?,?,?,?,?,?,?)').run(me.id, r.g.kind, r.g.brand, r.g.model, r.g.detail, r.g.upc, r.g.notes, Date.now()).lastInsertRowid);
      return send(res, 200, { gear: gearRow(q('SELECT * FROM gear WHERE id=?').get(gid)) });
    }
    const g = q('SELECT * FROM gear WHERE id=? AND user_id=?').get(id, me.id);
    if (!g) return bad('Not in your bag', 404);
    if (m === 'PUT') {
      if (body.retired != null && Object.keys(body).length === 1) q('UPDATE gear SET retired=? WHERE id=?').run(body.retired ? 1 : 0, id);
      else { const r = readGear(); if (r.err) return bad(r.err); q('UPDATE gear SET kind=?, brand=?, model=?, detail=?, upc=?, notes=? WHERE id=?').run(r.g.kind, r.g.brand, r.g.model, r.g.detail, r.g.upc, r.g.notes, id); }
      return send(res, 200, { gear: gearRow(q('SELECT * FROM gear WHERE id=?').get(id)) });
    }
    if (m === 'DELETE') { q('DELETE FROM gear WHERE id=?').run(id); return send(res, 200, { ok: true }); }
  }
  return false;
}

// Added to /api/state for the person asking.
function stateFor(me) {
  const gear = q('SELECT * FROM gear WHERE user_id=? ORDER BY retired, kind, brand, model').all(me.id).map(gearRow);
  const clubs = json(db.getSetting(`clubs:${me.id}`), null);
  return { gear, clubs: clubs?.length ? clubs : DEFAULT_CLUBS, gearKinds: KINDS, brands: BRANDS.brands, support: Object.fromEntries(gear.map((g) => [g.id, supportFor(g.brand)])) };
}

module.exports = { handle, stateFor, measureHole, holesFromOsm, clubStats, supportFor, DEFAULT_CLUBS };
