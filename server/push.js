'use strict';
// Web Push with no extra packages: the browser's push service (Google's, for Chrome on Android)
// only accepts a message that is encrypted for that one browser (RFC 8291) and signed by this
// server (VAPID, RFC 8292). Node's crypto module has every piece needed.
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// The server's signing key pair, made once and kept in the settings table.
function vapidKeys(db) {
  let pub = db.getSetting('vapid_public'), priv = db.getSetting('vapid_private');
  if (!pub || !priv) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    pub = b64u(ecdh.getPublicKey()); priv = b64u(ecdh.getPrivateKey());
    db.setSetting('vapid_public', pub); db.setSetting('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

function signingKey(keys) {
  const p = unb64u(keys.publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) } });
}

function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Encrypt one message for one browser subscription (aes128gcm content coding, single record).
function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Send to one subscription. Resolves to 'ok', 'gone' (the browser unsubscribed; forget it) or
// throws on any other failure.
async function sendPush(sub, message, keys, subject = 'mailto:golfbuddy@localhost') {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    },
    body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) throw new Error(`push service answered ${res.status}`);
  return 'ok';
}

module.exports = { vapidKeys, vapidHeader, encrypt, sendPush };
