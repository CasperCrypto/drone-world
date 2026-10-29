// solar.js — where the sun and the moon are for a date, a time and a place.
//
// Does: the sun's elevation and azimuth from the NOAA "General Solar Position
// Calculations" equations (accurate to a fraction of a degree), the moon's
// position and phase from the truncated lunar theory used by many planetarium
// apps (about 1 degree), and Polish clock time (CET / CEST) to UTC.
// Does NOT: refraction, eclipses, or anything three.js; it is plain maths so
// it can be tested in Node.
//
// Angles in degrees. Azimuth is measured from north, clockwise (east = 90).
// Sources:
//   NOAA GML, General Solar Position Calculations:
//     https://gml.noaa.gov/grad/solcalc/solareqns.PDF
//   Moon: J. Meeus, Astronomical Algorithms (2nd ed.), ch. 47, first terms.
//   EU summer time: Directive 2000/84/EC (last Sunday of March to last Sunday
//     of October, change at 01:00 UTC).

const RAD = Math.PI / 180;

// Centre of Poland, used when no other place is given.
export const POLAND = { lat: 52.1, lon: 19.4 };

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86400000) + 1;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Sun position for a UTC instant. */
export function sunPosition(date, lat = POLAND.lat, lon = POLAND.lon) {
  const year = date.getUTCFullYear();
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / (isLeap(year) ? 366 : 365)) * (dayOfYear(date) - 1 + (hour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)); // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g); // radians
  const trueSolarMinutes = hour * 60 + eqTime + 4 * lon;
  const hourAngle = (trueSolarMinutes / 4 - 180) * RAD;
  return horizontal(hourAngle, decl, lat);
}

// Hour angle and declination (radians) to elevation / azimuth (degrees).
function horizontal(hourAngle, decl, latDeg) {
  const lat = latDeg * RAD;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
  const az = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD + 180;
  return { elevation, azimuth: ((az % 360) + 360) % 360 };
}

function julianDays2000(date) {
  return date.getTime() / 86400000 + 2440587.5 - 2451545.0;
}

/** Moon position and phase for a UTC instant. illumination: 0 new, 1 full. */
export function moonPosition(date, lat = POLAND.lat, lon = POLAND.lon) {
  const d = julianDays2000(date);
  const L = (218.316 + 13.176396 * d) * RAD; // mean longitude
  const M = (134.963 + 13.064993 * d) * RAD; // mean anomaly
  const F = (93.272 + 13.229350 * d) * RAD; // argument of latitude
  const lambda = L + 6.289 * RAD * Math.sin(M); // ecliptic longitude
  const beta = 5.128 * RAD * Math.sin(F); // ecliptic latitude
  const eps = 23.4397 * RAD; // obliquity of the ecliptic
  const ra = Math.atan2(Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lambda));
  const dec = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda));
  const siderealTime = (280.16 + 360.9856235 * d) * RAD + lon * RAD;
  const pos = horizontal(siderealTime - ra, dec, lat);

  // Sun's ecliptic longitude (low precision) for the phase.
  const Ms = (357.5291 + 0.98560028 * d) * RAD;
  const C = (1.9148 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms) + 0.0003 * Math.sin(3 * Ms)) * RAD;
  const sunLambda = Ms + C + 102.9372 * RAD + Math.PI;
  const elongation = Math.acos(Math.cos(beta) * Math.cos(lambda - sunLambda));
  const illumination = (1 - Math.cos(elongation)) / 2;
  const waxing = Math.sin(lambda - sunLambda) > 0;
  return { ...pos, illumination, elongation: elongation / RAD, waxing };
}

// Last Sunday of a month, as a UTC day number.
function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** UTC offset of Polish clock time on a UTC instant: 1 (CET) or 2 (CEST). */
export function polandUtcOffset(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1);
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1);
  const t = date.getTime();
  return t >= start && t < end ? 2 : 1;
}

/** UTC instant for a Polish clock time on a calendar day (hours may be fractional). */
export function polandClockToUtc(year, month, day, hours) {
  const guess = new Date(Date.UTC(year, month, day) + (hours - 1) * 3600000);
  const offset = polandUtcOffset(guess);
  return new Date(Date.UTC(year, month, day) + (hours - offset) * 3600000);
}
