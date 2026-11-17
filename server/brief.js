'use strict';
// The Round Brief: everything worth knowing about one tee time, gathered in one answer.
// Each part is looked up on its own, so a weather outage doesn't hide the drive time.
const db = require('./db');
const svc = require('./services');
const { sunTimes } = require('./geo');

const HOUR = 3600000, MIN = 60000;
const roundHours = (b) => (b.holes === 9 ? 2.25 : 4.5);

// Where a course is: stored coordinates, or looked up once from its address and remembered.
async function placeOf(course, booking) {
  if (course && course.lat != null) return { lat: course.lat, lon: course.lon, address: course.address || booking.address };
  const address = booking.address || course?.address;
  const g = address ? await svc.geocode(address).catch(() => null) : null;
  if (g && course) db.raw.prepare('UPDATE courses SET lat=?, lon=? WHERE id=? AND lat IS NULL').run(g.lat, g.lon, course.id);
  return g ? { lat: g.lat, lon: g.lon, address } : address ? { address } : null;
}

const settle = async (fn) => { try { return await fn(); } catch (e) { return { status: 'error', error: e.code === 'nokey' ? 'nokey' : e.message }; } };

async function brief(b, me) {
  const course = db.courseById(b.courseId) || db.courseByName(b.course);
  const place = await placeOf(course, b);
  const out = { bookingId: b.id, course: course ? { website: course.website, phone: course.phone, info: course.info, lat: course.lat, lon: course.lon } : null };

  // Daylight: when the sun comes up and goes down that day, and whether the round runs past it.
  if (place?.lat != null) {
    const s = sunTimes(b.teeAt, place.lat, place.lon);
    const finish = b.teeAt + roundHours(b) * HOUR;
    out.sun = { ...s, finish, beforeSunrise: b.teeAt < s.sunrise, pastSunset: finish > s.sunset, pastDark: finish > s.lastLight };
  }

  const tasks = [];
  if (place?.lat != null && b.teeAt > Date.now() - 6 * HOUR) {
    tasks.push(settle(() => svc.weatherFor(place.lat, place.lon, b.teeAt, roundHours(b))).then((w) => { out.weather = w; }));
  }
  // Drive time for the person asking, from their own home address.
  if (b.teeAt > Date.now()) {
    if (me.home_lat == null) out.leave = { status: 'nohome' };
    else if (!svc.key('google_server_key')) out.leave = { status: 'nokey' };
    else if (!place) out.leave = { status: 'noaddress' };
    else {
      tasks.push(settle(() => svc.leaveBy({ home: { lat: me.home_lat, lon: me.home_lon }, course: place, teeAt: b.teeAt, arriveMins: me.arrive_mins ?? 30 }))
        .then((l) => { out.leave = l.status ? l : { status: 'ok', ...l }; }));
    }
  }
  await Promise.all(tasks);

  // Wake-up calls: on or off for this tee time, who has them set up, and what the caller has done.
  const log = db.wakeLog(b.id);
  out.wake = {
    on: wakeOn(b), auto: b.wake == null,
    people: b.roster.map((r) => {
      const u = db.userById(r.userId) || {};
      const L = log[r.userId] || {};
      return { userId: r.userId, ready: !!(u.wake_ok && u.home_lat != null && u.phone), out: r.rsvp === 'out',
        callAt: L.callAt || null, leaveAt: L.leave?.at || null, estimate: !!L.leave?.estimate, tries: (L.tries || []).length, done: L.done || null, skipped: !!L.skipped };
    }),
  };
  return out;
}

// Wake-up calls default to on for tee times before 8 a.m. (Los Angeles time), unless switched.
function wakeOn(b) {
  if (b.wake != null) return !!b.wake;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date(b.teeAt)));
  return h < 8;
}

module.exports = { brief, placeOf, wakeOn, roundHours, MIN };
