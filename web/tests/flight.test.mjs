// Tests for src/flight.js. Run: node --test tests/
// The first test replays the flights recorded by the C++ model
// (core/fixtures/trajectory.json); the rest mirror core/cpp/tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FlightModel, Mode, Vec3, Quat, cameraDronePreset, fpv5InchPreset, radToDeg,
  toThreePosition, toThreeQuaternion, fromThreePosition,
} from '../src/flight.js';

const fixtureUrl = new URL('../../core/fixtures/trajectory.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8'));

function run(m, sticks, seconds, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) m.step(sticks, dt);
}

test('JavaScript port matches the C++ model on recorded flights', () => {
  for (const sc of fixture.scenarios) {
    const m = new FlightModel(sc.fpv ? fpv5InchPreset() : cameraDronePreset());
    m.setMode(sc.mode);
    m.setWind(new Vec3(...sc.wind));
    m.reset(new Vec3(...sc.start));
    const samples = new Map(sc.samples.map((s) => [s.frame, s]));
    let frame = 0;
    let worst = 0;
    for (const seg of sc.script) {
      const n = Math.round(seg.seconds / fixture.dt);
      for (let i = 0; i < n; i++) {
        m.step(seg, fixture.dt);
        frame++;
        const ref = samples.get(frame);
        if (!ref) continue;
        const s = m.state;
        const err = Math.max(
          Math.abs(s.position.x - ref.p[0]), Math.abs(s.position.y - ref.p[1]), Math.abs(s.position.z - ref.p[2]),
          Math.abs(s.velocity.x - ref.v[0]), Math.abs(s.velocity.y - ref.v[1]), Math.abs(s.velocity.z - ref.v[2]),
        );
        worst = Math.max(worst, err);
      }
    }
    assert.ok(worst < 1e-6, `${sc.name}: JS and C++ differ by ${worst}`);
  }
});

test('hold mode hovers in place', () => {
  const m = new FlightModel();
  m.reset(new Vec3(0, 0, 10));
  run(m, {}, 10);
  assert.ok(Math.abs(m.state.position.z - 10) < 0.1);
  assert.ok(m.state.velocity.length() < 0.05);
});

test('angle mode: full pitch reaches the tilt limit and flies forward', () => {
  const m = new FlightModel();
  m.setMode(Mode.ANGLE);
  m.reset(new Vec3(0, 0, 100));
  run(m, { throttle: m.hoverStick(), pitch: 1 }, 2);
  assert.ok(Math.abs(m.tiltDeg() - m.p.maxTiltDeg) < 2);
  assert.ok(m.state.velocity.x > 3);
});

test('acro: full roll reaches the rate limit', () => {
  const m = new FlightModel(fpv5InchPreset());
  m.setMode(Mode.ACRO);
  m.reset(new Vec3(0, 0, 100));
  run(m, { throttle: m.hoverStick(), roll: 1 }, 0.3);
  assert.ok(Math.abs(radToDeg(m.state.bodyRates.x) - 670) < 30);
});

test('yaw stick right turns right (heading decreases)', () => {
  const m = new FlightModel();
  m.reset(new Vec3(0, 0, 10));
  run(m, { yaw: 1 }, 0.5);
  assert.ok(m.heading() < -0.3);
});

test('hold mode brakes and holds where it stops (no spring back)', () => {
  const m = new FlightModel();
  m.reset(new Vec3(0, 0, 10));
  run(m, { throttle: 1 }, 1);
  const releasedZ = m.state.position.z;
  run(m, {}, 4);
  assert.ok(m.state.position.z >= releasedZ);
  run(m, { pitch: 1 }, 3);
  const releasedX = m.state.position.x;
  run(m, {}, 6);
  assert.ok(m.state.position.x >= releasedX);
  assert.ok(m.state.velocity.length() < 0.2);
});

test('hold mode holds position in a 6 m/s crosswind', () => {
  const m = new FlightModel();
  m.reset(new Vec3(0, 0, 20));
  m.setWind(new Vec3(0, 6, 0));
  run(m, {}, 30);
  const s = m.state.position;
  assert.ok(Math.hypot(s.x, s.y) < 1);
});

test('gentle landing lands, motors-off fall crashes', () => {
  const land = new FlightModel();
  land.setGroundHeight(0);
  land.reset(new Vec3(0, 0, 3));
  run(land, { throttle: -0.6 }, 5);
  assert.equal(land.state.crashed, false);
  const fall = new FlightModel();
  fall.setMode(Mode.ANGLE);
  fall.setGroundHeight(0);
  fall.reset(new Vec3(0, 0, 20));
  run(fall, { throttle: -1 }, 4);
  assert.equal(fall.state.crashed, true);
});

test('survives out-of-range sticks and long frames', () => {
  const m = new FlightModel(fpv5InchPreset());
  m.setMode(Mode.ACRO);
  m.reset(new Vec3(0, 0, 100));
  for (let i = 0; i < 2000; i++) {
    m.step({ throttle: Math.sin(i * 0.37) * 2, roll: Math.cos(i * 0.11) * 3, pitch: Math.sin(i * 0.07), yaw: Math.cos(i * 0.05) },
      i % 7 === 0 ? 0.25 : 1 / 144);
  }
  const s = m.state;
  assert.ok([s.position.x, s.position.y, s.position.z, s.velocity.x, s.attitude.w].every(Number.isFinite));
});

test('three.js conversion keeps up up and left left', () => {
  assert.deepEqual(toThreePosition(new Vec3(1, 2, 3)), [1, 3, -2]);
  const back = fromThreePosition(1, 3, -2);
  assert.deepEqual([back.x, back.y, back.z], [1, 2, 3]);
  // A 90 degree left turn in the model is a +90 degree turn about three's y axis.
  const q = toThreeQuaternion(Quat.fromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2));
  assert.ok(Math.abs(q[1] - Math.SQRT1_2) < 1e-12 && Math.abs(q[3] - Math.SQRT1_2) < 1e-12);
});
