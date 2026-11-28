'use strict';
// Everything GolfHomie looks up on the internet, each answer cached in the database so a page view
// never waits on (or pays for) the same question twice.
//   - Weather: National Weather Service (free, no key).
//   - Addresses to coordinates: US Census geocoder (free, no key); Google Places when a key is set.
//   - Drive time in expected traffic: Google Routes API (server key).
//   - Driving ranges and simulators nearby: Google Places API (New) (server key).
const db = require('./db');
const { miles } = require('./geo');

const UA = `GolfHomie (${process.env.PUBLIC_URL || 'golfhomie.app'})`;
const MIN = 60000, HOUR = 3600000;

// Every outside call goes through here: a timeout, and errors as exceptions with the service name.
async function getJson(url, { method = 'GET', headers = {}, body, timeout = 12000, name = 'lookup' } = {}) {
  const res = await fetch(url, { method, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.detail || data?.message || text.slice(0, 160);
    const e = new Error(`${name}: ${res.status} ${msg}`); e.status = res.status; throw e;
  }
  return data;
}

// Cached(key, ttl, fn): the stored answer if it is fresh, otherwise fn()'s answer (stored).
// A failed refresh falls back to the stale answer rather than showing nothing.
async function cached(key, ttl, fn) {
  const hit = db.cacheGet(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  try {
    const v = await fn();
    if (v !== undefined) db.cacheSet(key, v, Date.now() + ttl);
    return v;
  } catch (e) {
    if (hit) return hit.v;
    throw e;
  }
}

// ---- keys (pasted into the Me > Admin page, stored in settings) -----------
const KEY_NAMES = ['google_server_key', 'google_browser_key', 'twilio_sid', 'twilio_token', 'twilio_from', 'anthropic_key'];
const key = (k) => db.getSetting(k) || process.env[k.toUpperCase()] || '';

// ---- weather -----------------------------------------------------------------
const r4 = (x) => Number(x).toFixed(4);
async function nwsPoint(lat, lon) {
  return cached(`nws:pt:${r4(lat)},${r4(lon)}`, 30 * 24 * HOUR, async () => {
    const p = (await getJson(`https://api.weather.gov/points/${r4(lat)},${r4(lon)}`, { name: 'Weather' })).properties;
    return { hourly: p.forecastHourly, daily: p.forecast };
  });
}
const mph = (s) => { const n = String(s || '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };
const pop = (p) => (p?.probabilityOfPrecipitation?.value ?? null);

// The forecast for a round: the hour you tee off plus the range over the next few hours.
// Hourly forecasts reach about 6 days out, daily ones 7; past that there is nothing yet.
async function weatherFor(lat, lon, teeAt, hours = 4.5) {
  const now = Date.now();
  if (teeAt > now + 7.2 * 24 * HOUR) return { status: 'later', opensAt: teeAt - 7 * 24 * HOUR };
  const pt = await nwsPoint(lat, lon);
  const hourly = await cached(`nws:h:${pt.hourly}`, 45 * MIN, async () => (await getJson(pt.hourly, { name: 'Weather' })).properties.periods
    .map((p) => ({ s: Date.parse(p.startTime), e: Date.parse(p.endTime), t: p.temperature, w: mph(p.windSpeed), d: p.windDirection, p: pop(p), sky: p.shortForecast })));
  const end = teeAt + hours * HOUR;
  const inRound = hourly.filter((p) => p.e > teeAt && p.s < end);
  if (inRound.length) {
    const at = inRound[0];
    return {
      status: 'hourly', source: 'National Weather Service',
      at: { temp: at.t, wind: at.w, dir: at.d, pop: at.p, sky: at.sky },
      lo: Math.min(...inRound.map((p) => p.t)), hi: Math.max(...inRound.map((p) => p.t)),
      windMax: Math.max(...inRound.map((p) => p.w || 0)), popMax: Math.max(...inRound.map((p) => p.p || 0)),
      hours: inRound.map((p) => ({ s: p.s, t: p.t, w: p.w, d: p.d, p: p.p, sky: p.sky })),
    };
  }
  const daily = await cached(`nws:d:${pt.daily}`, 2 * HOUR, async () => (await getJson(pt.daily, { name: 'Weather' })).properties.periods
    .map((p) => ({ s: Date.parse(p.startTime), e: Date.parse(p.endTime), day: p.isDaytime, t: p.temperature, w: mph(p.windSpeed), d: p.windDirection, p: pop(p), sky: p.shortForecast, txt: p.detailedForecast })));
  const d = daily.find((p) => p.s <= teeAt && p.e > teeAt) || daily.find((p) => p.day && p.e > teeAt);
  if (!d) return { status: 'later', opensAt: teeAt - 7 * 24 * HOUR };
  return { status: 'daily', source: 'National Weather Service', at: { temp: d.t, wind: d.w, dir: d.d, pop: d.p, sky: d.sky }, text: d.txt };
}

// ---- addresses to coordinates ------------------------------------------------
async function geocode(address) {
  const a = String(address || '').trim();
  if (!a) return null;
  return cached(`geo:${a.toLowerCase()}`, 365 * 24 * HOUR, async () => {
    if (key('google_server_key')) {
      try {
        const r = await placesText(a, null, 1, 'places.location,places.formattedAddress');
        if (r[0]?.location) return { lat: r[0].location.latitude, lon: r[0].location.longitude, label: r[0].formattedAddress, by: 'google' };
      } catch (e) { console.warn(e.message); }
    }
    const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(a)}`;
    const m = (await getJson(u, { name: 'Address lookup' })).result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x, label: m.matchedAddress, by: 'census' } : null;
  });
}

// ---- Google Routes: how long the drive takes in expected traffic ---------------
// Routes can't plan "arrive by" for driving, so we guess a departure, ask, and correct once.
// Two requests per question, cached for a few hours.
async function driveMinutes(from, to, departAt) {
  const k = key('google_server_key');
  if (!k) throw Object.assign(new Error('No Google key yet'), { code: 'nokey' });
  const where = (x) => (x.lat != null ? { location: { latLng: { latitude: x.lat, longitude: x.lon } } } : { address: x.address });
  const body = { origin: where(from), destination: where(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', departureTime: new Date(Math.max(departAt, Date.now() + MIN)).toISOString(), units: 'IMPERIAL' };
  const r = await getJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST', name: 'Google Routes', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters' },
  });
  const route = r?.routes?.[0];
  if (!route) throw new Error('Google Routes found no driving route');
  return { minutes: Math.round(parseInt(route.duration, 10) / 60), usual: Math.round(parseInt(route.staticDuration || route.duration, 10) / 60), miles: Math.round(route.distanceMeters / 160.9344) / 10 };
}

// When to leave home to be at the course `arriveMins` before the tee time.
async function leaveBy({ home, course, teeAt, arriveMins = 30, maxAge = 6 * HOUR }) {
  const arrive = teeAt - arriveMins * MIN;
  const ck = `leave:${home.lat ?? home.address}|${course.lat ?? course.address}|${arrive}`;
  return cached(ck, maxAge, async () => {
    let r = await driveMinutes(home, course, arrive - 45 * MIN);
    r = await driveMinutes(home, course, arrive - r.minutes * MIN);
    return { at: arrive - r.minutes * MIN, minutes: r.minutes, usual: r.usual, miles: r.miles, arrive, checked: Date.now() };
  });
}

// ---- Google Places (New): text search near a point ------------------------------
// Only "Pro" fields are asked for (name, address, location, Maps link), the cheaper tier.
async function placesText(query, near, max = 20, fields = 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.businessStatus') {
  const k = key('google_server_key');
  if (!k) throw Object.assign(new Error('No Google key yet'), { code: 'nokey' });
  const body = { textQuery: query, pageSize: Math.min(20, max) };
  if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 48000 } };
  const r = await getJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', name: 'Google Places', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k, 'X-Goog-FieldMask': fields },
  });
  return r?.places || [];
}

// Driving ranges and golf simulators within `radiusMi` of a point, nearest first.
async function practiceNear(near, radiusMi = 30) {
  const grid = `${near.lat.toFixed(2)},${near.lon.toFixed(2)}`; // ~1 km grid, so nearby phones share answers
  return cached(`practice:${grid}`, 24 * HOUR, async () => {
    const [ranges, sims] = await Promise.all([placesText('golf driving range', near), placesText('indoor golf simulator', near)]);
    const seen = new Set(), out = [];
    for (const [kind, list] of [['range', ranges], ['sim', sims]]) {
      for (const p of list) {
        if (!p.location || seen.has(p.id) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        seen.add(p.id);
        const d = miles(near, { lat: p.location.latitude, lon: p.location.longitude });
        if (d <= radiusMi) out.push({ id: p.id, kind, name: p.displayName?.text || '', address: p.formattedAddress || '', lat: p.location.latitude, lon: p.location.longitude, url: p.googleMapsUri || '', miles: Math.round(d * 10) / 10 });
      }
    }
    return out.sort((a, b) => a.miles - b.miles);
  });
}

module.exports = { getJson, cached, key, KEY_NAMES, weatherFor, geocode, driveMinutes, leaveBy, placesText, practiceNear };
