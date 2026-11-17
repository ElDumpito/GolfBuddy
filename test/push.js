'use strict';
// Web Push: decrypt what we send exactly as a browser would, and check the VAPID signature.
const assert = require('assert');
const crypto = require('crypto');
const { encrypt, vapidHeader } = require('../server/push');

function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2); // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString();
}
module.exports = { decrypt };

if (require.main === module) {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: '⛳ New tee time', body: 'Rancho Park' });
  const out = encrypt(msg, ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  assert.strictEqual(decrypt(out, ua, auth), msg);

  const srv = crypto.createECDH('prime256v1'); srv.generateKeys();
  const keys = { publicKey: srv.getPublicKey().toString('base64url'), privateKey: srv.getPrivateKey().toString('base64url') };
  const h = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:x@example.com');
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, h);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = Buffer.from(m[4], 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  console.log('push: ok');
}
