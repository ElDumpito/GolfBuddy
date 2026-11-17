'use strict';
// The confirmation reader, on real (anonymised) emails of each format.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseConfirmation, fmtWhen, laTime } = require('../server/parse');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

let r = parseConfirmation(fx('lacity.txt'));
assert.strictEqual(r.source, 'L.A. City Golf');
assert.strictEqual(r.course, 'Rancho Park');
assert.strictEqual(fmtWhen(r.teeAt), 'Tue, Mar 3, 6:30 AM');
assert.strictEqual(new Date(r.teeAt).toISOString(), '2026-03-03T14:30:00.000Z'); // PST
assert.strictEqual(r.players, 2); assert.strictEqual(r.holes, 9); assert.strictEqual(r.deposit, 2000);
assert.strictEqual(r.cancelHours, 24); assert.strictEqual(r.confirmation, '640000001'); assert.strictEqual(r.booker, 'Mike Buddy');
assert.strictEqual(r.address, '10460 W Pico Blvd, Los Angeles, CA 90064');
assert.ok(/walking only/.test(r.notes));
assert.deepStrictEqual(r.missing, []);

r = parseConfirmation(fx('golfnow.txt'));
assert.strictEqual(r.source, 'GolfNow');
assert.strictEqual(r.course, 'Los Verdes Golf Course');
assert.strictEqual(new Date(r.teeAt).toISOString(), '2026-09-07T21:40:00.000Z'); // PDT
assert.strictEqual(r.total, 10100); assert.strictEqual(r.deposit, 2000); assert.strictEqual(r.players, 2); assert.strictEqual(r.holes, 18);
assert.strictEqual(r.confirmation, '429000002'); assert.ok(/\$81\.00/.test(r.notes));
assert.ok(r.address.startsWith('7000 W. Los Verdes Drive'));

r = parseConfirmation(fx('foreup.txt'));
assert.strictEqual(r.source, 'foreUP');
assert.strictEqual(r.course, 'Soule Park Golf Course');
assert.strictEqual(fmtWhen(r.teeAt), 'Fri, Sep 4, 11:30 AM'); // not the forwarding date (Aug 31)
assert.strictEqual(r.total, 9400); assert.strictEqual(r.deposit, 9400); assert.strictEqual(r.confirmation, 'TTID_000000000000xyz');

r = parseConfirmation('Booked Rancho Park Sat 4/18/26 at 7:10 AM for 3 players, $75 total', [{ name: 'Rancho Park' }]);
assert.strictEqual(r.course, 'Rancho Park'); assert.strictEqual(r.players, 3); assert.strictEqual(r.total, 7500);
assert.strictEqual(fmtWhen(r.teeAt), 'Sat, Apr 18, 7:10 AM');

r = parseConfirmation('nothing useful here');
assert.deepStrictEqual(r.missing.sort(), ['course', 'players', 'teeAt']);

// Daylight-saving edges: the Sunday clocks change.
assert.strictEqual(new Date(laTime(2026, 3, 8, 7, 0)).toISOString(), '2026-03-08T14:00:00.000Z');
assert.strictEqual(new Date(laTime(2026, 11, 1, 7, 0)).toISOString(), '2026-11-01T15:00:00.000Z');
console.log('parse: ok');
