'use strict';
// Just enough email reading for forwarded booking confirmations: headers, multipart bodies,
// quoted-printable and base64, and HTML turned into plain text.

function decodeWords(s) {
  // =?UTF-8?B?...?= and =?UTF-8?Q?...?= in headers like Subject.
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const buf = /b/i.test(enc) ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return buf.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
    } catch { return txt; }
  }).replace(/\?=\s+=\?/g, '');
}

function splitHeaders(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i), body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function decodeBody(body, headers) {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  const cs = (headers['content-type'] || '').match(/charset="?([\w-]+)/i)?.[1] || 'utf-8';
  let buf;
  if (enc === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') buf = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  else buf = Buffer.from(body, 'latin1');
  return buf.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
}

const htmlToText = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n').replace(/<\/td>/gi, ' ')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Walk the message; prefer text/plain, fall back to HTML.
function parts(raw, depth = 0) {
  const { headers, body } = splitHeaders(raw);
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  const b = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/i)?.[1];
  if (type.startsWith('multipart/') && b && depth < 6) {
    return body.split(`--${b}`).slice(1).filter((p) => !p.startsWith('--')).flatMap((p) => parts(p.replace(/^\r?\n/, ''), depth + 1));
  }
  return [{ type: type.split(';')[0], text: decodeBody(body, headers) }];
}

function readEmail(raw) {
  const { headers } = splitHeaders(raw);
  const all = parts(raw);
  const plain = all.find((p) => p.type === 'text/plain' && p.text.trim());
  const html = all.find((p) => p.type === 'text/html');
  const text = plain ? plain.text : html ? htmlToText(html.text) : '';
  return { subject: decodeWords(headers.subject), from: decodeWords(headers.from), text: text.slice(0, 100000) };
}

module.exports = { readEmail, htmlToText };
