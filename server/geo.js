'use strict';
// Sun times and distances, worked out locally (no service needed).

const RAD = Math.PI / 180;
const DAY = 86400000;

// Sunrise, sunset and the end of civil twilight ("last light", when it gets too dark to see a ball)
// for the calendar day that contains `t`, at a place. Uses the standard NOAA sunrise equation,
// which is good to about a minute. Returns times in ms, or null in polar day/night.
function sunTimes(t, lat, lon) {
  const jd = t / DAY + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008 + lon / 360); // the local solar day
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const dec = Math.asin(Math.sin(L * RAD) * Math.sin(23.4397 * RAD));
  const at = (h0) => {
    const cosW = (Math.sin(h0 * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec));
    if (cosW < -1 || cosW > 1) return null;
    const w = Math.acos(cosW) / RAD;
    return { rise: (transit - w / 360 - 2440587.5) * DAY, set: (transit + w / 360 - 2440587.5) * DAY };
  };
  const sun = at(-0.833), civil = at(-6);
  return {
    sunrise: sun && Math.round(sun.rise), sunset: sun && Math.round(sun.set),
    firstLight: civil && Math.round(civil.rise), lastLight: civil && Math.round(civil.set),
    noon: Math.round((transit - 2440587.5) * DAY),
  };
}

// Straight-line distance in metres between two points.
function meters(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const yards = (a, b) => meters(a, b) / 0.9144;
const miles = (a, b) => meters(a, b) / 1609.344;

// Compass bearing from a to b, 0 = north, 90 = east.
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

module.exports = { sunTimes, meters, yards, miles, bearing };
