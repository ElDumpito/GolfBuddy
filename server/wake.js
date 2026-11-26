'use strict';
// Wake-up calls. For an early tee time (before 8 a.m. unless switched), each player who has
// turned wake-up calls on in their profile gets a phone call half an hour before they need to
// leave home, worked out from the drive in expected traffic. They also get a push notification,
// so the feature still works (quietly) before the phone service is set up.
//
// Phone calls go through Twilio. GolfHomie never needs Twilio to reach it (the site is behind a
// login wall): it starts the call with the spoken message attached, then asks Twilio how it went.
const db = require('./db');
const svc = require('./services');
const { wakeOn } = require('./brief');

const MIN = 60000, HOUR = 3600000;
const CALL_BEFORE = 30;          // minutes before leave-by
const RETRY_AFTER = 5;           // minutes before a second try
const MAX_TRIES = 2;
const FALLBACK_DRIVE = 60;       // minutes, when no drive time could be worked out

const fmt = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(new Date(t));
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function e164(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d;
  const n = d.replace(/\D/g, '');
  if (n.length === 10) return '+1' + n;
  if (n.length === 11 && n.startsWith('1')) return '+' + n;
  return null;
}

function script(name, b, leave) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const drive = leave.estimate ? 'I could not check traffic, so this assumes about an hour on the road.' : `The drive is about ${leave.minutes} minutes in expected traffic.`;
  const line = `Good morning ${first}. This is your GolfHomie wake-up call for your ${fmt(b.teeAt)} tee time at ${b.course}. Leave by ${fmt(leave.at)}. ${drive}`;
  return `<Response><Pause length="1"/><Say voice="Polly.Joanna">${xml(line)}</Say><Pause length="1"/><Say voice="Polly.Joanna">${xml(`Again: leave by ${fmt(leave.at)}. Have a great round.`)}</Say></Response>`;
}

// ---- Twilio --------------------------------------------------------------------
const twilioReady = () => !!(svc.key('twilio_sid') && svc.key('twilio_token') && svc.key('twilio_from'));
function twilioAuth() { return 'Basic ' + Buffer.from(`${svc.key('twilio_sid')}:${svc.key('twilio_token')}`).toString('base64'); }
async function placeCall(to, twiml) {
  const form = new URLSearchParams({ To: to, From: svc.key('twilio_from'), Twiml: twiml, Timeout: '30', MachineDetection: 'Enable' });
  const r = await svc.getJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(svc.key('twilio_sid'))}/Calls.json`, {
    method: 'POST', name: 'Twilio', body: form.toString(), headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return r.sid;
}
async function callStatus(sid) {
  const r = await svc.getJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(svc.key('twilio_sid'))}/Calls/${encodeURIComponent(sid)}.json`, {
    name: 'Twilio', headers: { Authorization: twilioAuth() },
  });
  return { status: r.status, answeredBy: r.answered_by || null };
}

// Plan a person's call: when to leave, so when to ring. Refreshed about 3 hours out for live traffic.
async function plan(b, u, deps) {
  const arriveMins = u.arrive_mins ?? 30;
  try {
    const course = db.courseById(b.courseId) || {};
    const place = course.lat != null ? { lat: course.lat, lon: course.lon } : { address: b.address || course.address };
    const l = await deps.leaveBy({ home: { lat: u.home_lat, lon: u.home_lon }, course: place, teeAt: b.teeAt, arriveMins, maxAge: 2 * HOUR });
    return { at: l.at, minutes: l.minutes };
  } catch (e) {
    return { at: b.teeAt - (arriveMins + FALLBACK_DRIVE) * MIN, minutes: FALLBACK_DRIVE, estimate: true, why: e.message };
  }
}

const DONE = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);

async function wakeTick(now = Date.now(), deps = {}) {
  deps = { leaveBy: svc.leaveBy, placeCall, callStatus, ready: twilioReady, notify: async () => 0, ...deps };
  for (const b of db.upcoming(now, now + 14 * HOUR)) {
    if (!wakeOn(b)) continue;
    const log = db.wakeLog(b.id);
    let changed = false;
    for (const r of b.roster) {
      if (r.rsvp === 'out') continue;
      const u = db.userById(r.userId);
      if (!u || !u.wake_ok || u.home_lat == null) continue;
      const L = log[u.id] || (log[u.id] = { tries: [] });
      const others = b.roster.map((x) => x.userId).filter((id) => id !== u.id);
      const first = (u.name || u.username).split(/\s+/)[0];

      // 1. Plan, and re-plan once with fresh traffic about 3 hours before the call.
      if (!L.leave || (!L.refreshed && !L.called && now >= L.callAt - 3 * HOUR)) {
        L.leave = await plan(b, u, deps);
        L.callAt = L.leave.at - CALL_BEFORE * MIN;
        if (L.planned) L.refreshed = now;
        L.planned = now; changed = true;
      }
      // Booked too late for a useful call: don't ring someone who should already be driving.
      if (!L.called && now > L.leave.at) { if (!L.skipped) { L.skipped = now; changed = true; } continue; }

      // 2. Ring (and push) at call time, then once more if nobody picked up.
      const due = !L.called ? now >= L.callAt : L.retryAt && !L.done && now >= L.retryAt && L.tries.length < MAX_TRIES;
      if (due) {
        const phone = e164(u.phone);
        const attempt = { at: now };
        if (!L.called) {
          await deps.notify([u.id], { title: `⏰ Wake up: ${b.course} at ${fmt(b.teeAt)}`, body: `Leave by ${fmt(L.leave.at)}${L.leave.estimate ? ' (traffic not checked)' : ` · ${L.leave.minutes} min drive`}.`, url: `/#/b/${b.id}`, tag: `w${b.id}`, requireInteraction: true });
        }
        if (deps.ready() && phone) {
          try { attempt.sid = await deps.placeCall(phone, script(u.name || u.username, b, L.leave)); } catch (e) { attempt.error = e.message; }
        } else attempt.skipped = !deps.ready() ? 'Phone service not set up' : 'No valid phone number';
        L.tries.push(attempt);
        L.called = L.called || now;
        L.retryAt = null;
        if (attempt.skipped) L.done = 'push-only';
        else if (attempt.error && L.tries.length >= MAX_TRIES) L.done = 'failed';
        else if (attempt.error) L.retryAt = now + RETRY_AFTER * MIN;
        changed = true;
      }

      // 3. A minute or two after ringing, ask Twilio how it went.
      const last = L.tries[L.tries.length - 1];
      if (last?.sid && !last.status && now - last.at >= 90000) {
        try {
          const s = await deps.callStatus(last.sid);
          if (DONE.has(s.status) || now - last.at > 10 * MIN) {
            last.status = s.status; last.answeredBy = s.answeredBy;
            const human = s.status === 'completed' && !/^machine|fax/.test(s.answeredBy || '');
            if (human) {
              L.done = 'answered';
              await deps.notify(others, { title: `☀️ ${first} took the wake-up call`, body: `${b.course} · ${fmt(b.teeAt)}. Leaving by ${fmt(L.leave.at)}.`, url: `/#/b/${b.id}`, tag: `w${b.id}` });
            } else if (L.tries.length < MAX_TRIES) {
              L.retryAt = now + RETRY_AFTER * MIN;
            } else {
              L.done = 'missed';
              await deps.notify(others, { title: `📵 ${first} didn't pick up`, body: `Two wake-up calls for ${fmt(b.teeAt)} at ${b.course} went ${s.answeredBy?.startsWith('machine') ? 'to voicemail' : 'unanswered'}. Maybe give a ring.`, url: `/#/b/${b.id}`, tag: `w${b.id}`, requireInteraction: true });
            }
            changed = true;
          }
        } catch (e) { last.checkError = e.message; changed = true; }
      }
    }
    if (changed) db.setWakeLog(b.id, log);
  }
}

module.exports = { wakeTick, e164, script, twilioReady, placeCall, CALL_BEFORE };
