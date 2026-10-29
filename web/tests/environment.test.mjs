// Tests for the sun, moon and wind models and the layout (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, moonPosition, polandUtcOffset, polandClockToUtc, POLAND } from '../src/solar.js';
import { WindField, REF_HEIGHT, ALPHA_OPEN, drydenRatios } from '../src/wind.js';
import { trackDistance, onHardSurface, RUNWAY, HOUSES, TRACKS } from '../src/layout.js';

// Highest sun of a UTC day, sampled every minute.
function maxElevation(y, m, d, lat, lon) {
  let best = -90;
  for (let min = 0; min < 1440; min++) {
    best = Math.max(best, sunPosition(new Date(Date.UTC(y, m, d, 0, min)), lat, lon).elevation);
  }
  return best;
}

test('noon sun height follows 90 - latitude +/- 23.44 degrees at the solstices', () => {
  // Geometry: at the June solstice the sun stands at 90 - lat + 23.44.
  assert.ok(Math.abs(maxElevation(2026, 5, 21, 52, 19) - (90 - 52 + 23.44)) < 0.3);
  assert.ok(Math.abs(maxElevation(2026, 11, 21, 52, 19) - (90 - 52 - 23.44)) < 0.3);
  // Equinox: 90 - lat.
  assert.ok(Math.abs(maxElevation(2026, 2, 20, 52, 19) - 38) < 0.6);
});

test('day length is about 12 hours at the equinox and long at midsummer', () => {
  const daylight = (y, m, d) => {
    let mins = 0;
    for (let min = 0; min < 1440; min++) {
      if (sunPosition(new Date(Date.UTC(y, m, d, 0, min)), 52, 19).elevation > 0) mins++;
    }
    return mins / 60;
  };
  assert.ok(Math.abs(daylight(2026, 2, 20) - 12) < 0.25);
  assert.ok(daylight(2026, 5, 21) > 16 && daylight(2026, 5, 21) < 17);
});

test('the sun rises in the east, stands south at noon and sets in the west', () => {
  const morning = sunPosition(polandClockToUtc(2026, 5, 21, 6), POLAND.lat, POLAND.lon);
  // Solar noon at 19.4 E in summer time: 14:00 - 19.4 * 4 min, about 12:44.
  const noon = sunPosition(polandClockToUtc(2026, 5, 21, 12.73), POLAND.lat, POLAND.lon);
  const evening = sunPosition(polandClockToUtc(2026, 5, 21, 20), POLAND.lat, POLAND.lon);
  assert.ok(morning.azimuth > 45 && morning.azimuth < 120, `morning ${morning.azimuth}`);
  assert.ok(Math.abs(noon.azimuth - 180) < 3, `noon ${noon.azimuth}`);
  assert.ok(evening.azimuth > 250 && evening.azimuth < 320, `evening ${evening.azimuth}`);
});

test('Polish clock time switches between CET and CEST on the last Sundays of March and October', () => {
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 0, 15, 12))), 1);
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 6, 15, 12))), 2);
  // 2026: summer time starts 29 March 01:00 UTC and ends 25 October 01:00 UTC.
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 2, 29, 0, 59))), 1);
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 2, 29, 1, 0))), 2);
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 9, 25, 0, 59))), 2);
  assert.equal(polandUtcOffset(new Date(Date.UTC(2026, 9, 25, 1, 0))), 1);
  assert.equal(polandClockToUtc(2026, 6, 1, 12).getUTCHours(), 10);
  assert.equal(polandClockToUtc(2026, 0, 1, 12).getUTCHours(), 11);
});

test('moon phase: full on 22 June 2024, new during the 8 April 2024 eclipse', () => {
  assert.ok(moonPosition(new Date(Date.UTC(2024, 5, 22, 1, 8))).illumination > 0.97);
  assert.ok(moonPosition(new Date(Date.UTC(2024, 3, 8, 18, 21))).illumination < 0.03);
});

const open = () => new WindField({}, 3);

test('mean wind equals the set speed at 10 m and follows the 1/7 power law', () => {
  const w = open();
  w.configure({ speed10: 8, fromDeg: 270, gustiness: 0 });
  assert.ok(Math.abs(w.meanSpeed(REF_HEIGHT) - 8) < 1e-12);
  assert.ok(Math.abs(w.meanSpeed(40) - 8 * Math.pow(4, ALPHA_OPEN)) < 1e-12);
  assert.ok(w.meanSpeed(2) < w.meanSpeed(10) && w.meanSpeed(10) < w.meanSpeed(80));
});

test('wind from the west blows toward the east (+x in three.js)', () => {
  const w = open();
  w.configure({ speed10: 6, fromDeg: 270, gustiness: 0 });
  const s = w.sample(0, 10, 0);
  assert.ok(s.x > 5.9 && Math.abs(s.z) < 1e-9);
  w.configure({ fromDeg: 0 }); // from the north -> toward the south (+z)
  const n = w.sample(0, 10, 0);
  assert.ok(n.z > 5.9 && Math.abs(n.x) < 1e-9);
});

test('gusts have the Dryden strength on average', () => {
  const w = open();
  w.configure({ speed10: 10, fromDeg: 200, gustiness: 1 });
  const expected = w.sigmaW * drydenRatios(10).sigmaUOverSigmaW;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    w.time = i * 0.37;
    const x = (i % 50) * 37.3;
    const s = w.sample(x, 10, -x * 0.6);
    const along = s.x * w.dirX + s.z * w.dirZ - w.meanSpeed(10);
    sum += along;
    sum2 += along * along;
    n++;
  }
  const rms = Math.sqrt(sum2 / n - (sum / n) ** 2);
  assert.ok(Math.abs(rms / expected - 1) < 0.2, `rms ${rms} vs ${expected}`);
});

test('gusts travel downwind at the mean speed', () => {
  const w = open();
  w.configure({ speed10: 8, fromDeg: 270, gustiness: 1 });
  // The gust at x = 0 now arrives at x = 8 * 5 = 40 m five seconds later.
  let moved = 0;
  let stayed = 0;
  for (let i = 0; i < 200; i++) {
    w.time = i * 3.1;
    const a = w.gust(w.modes.u, 0, i * 11);
    w.time += 5;
    const b = w.gust(w.modes.u, 40, i * 11);
    const c = w.gust(w.modes.u, 0, i * 11);
    moved += Math.abs(a - b);
    stayed += Math.abs(a - c);
  }
  assert.ok(moved < 0.6 * stayed, `moved ${moved} stayed ${stayed}`);
});

test('the forest canopy and a building wake slow the wind', () => {
  const site = {
    canopyHeight: (x) => (x > 100 ? 20 : 0),
    buildings: [{ x: 0, z: 0, hw: 5, hd: 5, h: 8 }],
  };
  const w = new WindField(site, 5);
  w.configure({ speed10: 10, fromDeg: 270, gustiness: 0 });
  const openAir = w.sample(-60, 5, 40).x;
  assert.ok(w.sample(150, 10, 0).x < 0.4 * openAir, 'inside the canopy');
  assert.ok(w.sample(15, 4, 0).x < 0.7 * w.sample(-15, 4, 0).x, 'behind the building');
});

test('air rises on the windward slope of a hill', () => {
  const site = { groundHeight: (x) => Math.max(0, 30 - Math.abs(x) * 0.3) };
  const w = new WindField(site, 9);
  w.configure({ speed10: 10, fromDeg: 270, gustiness: 0 });
  assert.ok(w.sample(-50, site.groundHeight(-50) + 5, 0).y > 1);
  assert.ok(w.sample(50, site.groundHeight(50) + 5, 0).y < -1);
});

test('the same seed gives the same wind', () => {
  const a = new WindField({}, 42);
  const b = new WindField({}, 42);
  a.configure({ speed10: 7, fromDeg: 120, gustiness: 1.6 });
  b.configure({ speed10: 7, fromDeg: 120, gustiness: 1.6 });
  a.time = b.time = 12.5;
  assert.deepEqual(a.sample(10, 20, 30), b.sample(10, 20, 30));
});


test('layout: tracks and hard surfaces are where the world builds them', () => {
  const [ax, az] = TRACKS[0][0];
  assert.ok(trackDistance(ax, az) < 1e-9);
  assert.ok(trackDistance(400, 400) > 100);
  assert.ok(onHardSurface(RUNWAY.x, RUNWAY.z));
  assert.ok(onHardSurface(HOUSES[0].x, HOUSES[0].z));
  assert.ok(!onHardSurface(-300, -300));
});
