'use strict';
// Reading photos: a paper scorecard, a receipt, a club or ball, a Player Card.
// The photo goes to Anthropic's Claude (the key is pasted in Me › Admin; nothing is sent without it),
// which answers in JSON. Everything it says is checked and trimmed here before the app uses it, and the
// app always shows it to you to confirm before saving anything.
const svc = require('./services');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ready = () => !!svc.key('anthropic_key');

const ASK = {
  scorecard: (h) => `This is a photo of a golf scorecard filled in by hand. The round is ${h.holes} holes starting at hole ${h.start}.
The players we expect are: ${h.players.join(', ') || 'unknown'}. Read each player's row of scores.
Answer with JSON only, no other text:
{"pars":[par for each of the ${h.holes} holes in order, or null if not printed],
 "players":[{"name":"the name as written","strokes":[strokes for each of the ${h.holes} holes in order, null where blank or unreadable]}]}
Leave out total columns (OUT, IN, TOT, HCP, NET). Use null rather than guessing a number you can't read.`,
  receipt: (h) => `This is a photo of a receipt from a golf outing. Answer with JSON only, no other text:
{"merchant":"store or course name","total":total paid in dollars as a number (including tax and tip),"date":"YYYY-MM-DD or null",
 "category":"one of: ${h.categories.join(', ')}","note":"a few words on what was bought"}`,
  gear: (h) => `This is a photo of a piece of golf equipment. Answer with JSON only, no other text:
{"kind":"one of: ${h.kinds.join(', ')}","brand":"maker, e.g. Titleist","model":"model name, e.g. T200 or Pro V1","detail":"loft, shaft, flex, colour or set makeup if visible, else empty"}
Use an empty string for anything you can't see.`,
  card: () => `This is a photo of a Los Angeles City golf Player Card (a membership card). Answer with JSON only, no other text:
{"cardNo":"the card or member number exactly as printed, digits and letters only","cardExp":"expiry date as YYYY-MM-DD, or null if not shown"}`,
};

// The first {...} in the reply, so stray words or a code fence around it don't matter.
function jsonIn(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Could not read that photo');
  return JSON.parse(text.slice(a, b + 1));
}
const s = (x, n = 80) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
const num = (x, lo, hi) => { const v = Number(x); return x !== null && x !== '' && Number.isInteger(v) && v >= lo && v <= hi ? v : null; };
const listOf = (a, n, f) => Array.from({ length: n }, (_, i) => f(Array.isArray(a) ? a[i] : null));

// Keep only what makes sense for each kind of photo.
function clean(kind, raw, h) {
  if (kind === 'scorecard') {
    const pars = Array.isArray(raw.pars) ? listOf(raw.pars, h.holes, (x) => num(x, 3, 6)) : null;
    const players = (Array.isArray(raw.players) ? raw.players : []).slice(0, 8)
      .map((p) => ({ name: s(p?.name, 40), strokes: listOf(p?.strokes, h.holes, (x) => num(x, 1, 15)) }))
      .filter((p) => p.strokes.some((x) => x));
    return { pars: pars && pars.some((x) => x) ? pars : null, players };
  }
  if (kind === 'receipt') {
    const total = Math.round(Number(raw.total) * 100);
    return {
      merchant: s(raw.merchant, 60), note: s(raw.note, 80),
      total: Number.isFinite(total) && total > 0 && total < 1e6 ? total : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : null,
      category: h.categories.includes(raw.category) ? raw.category : 'Other',
    };
  }
  if (kind === 'gear') return { kind: h.kinds.includes(raw.kind) ? raw.kind : 'other', brand: s(raw.brand, 40), model: s(raw.model, 60), detail: s(raw.detail, 80) };
  if (kind === 'card') return { cardNo: s(raw.cardNo, 24).replace(/[^\w-]/g, ''), cardExp: /^\d{4}-\d{2}-\d{2}$/.test(raw.cardExp || '') ? raw.cardExp : null };
  throw new Error('Unknown photo kind');
}

// image: a data: URL from the browser (JPEG, already shrunk to about 1600 px on the long side).
async function read(kind, image, hint = {}) {
  if (!ASK[kind]) throw new Error('Unknown photo kind');
  if (!ready()) throw new Error('Add the Anthropic key in Me › Admin first');
  const m = String(image || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('That photo did not come through');
  const r = await svc.getJson('https://api.anthropic.com/v1/messages', {
    method: 'POST', name: 'Photo reading', timeout: 60000,
    headers: { 'Content-Type': 'application/json', 'x-api-key': svc.key('anthropic_key'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: ASK[kind](hint) },
      ] }],
    }),
  });
  const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return clean(kind, jsonIn(text), hint);
}

module.exports = { read, ready, clean, MODEL };
