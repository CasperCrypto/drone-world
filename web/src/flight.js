// flight.js — the quadcopter flight model for the browser.
//
// A line-by-line port of core/cpp/DroneFlightModel.h. The two must stay in
// step: tests/flight.test.mjs compares this file against a trajectory the C++
// version produced (core/fixtures/trajectory.json).
//
// Does: Hold / Angle / Acro modes, thrust, gravity, quadratic drag, wind,
// ground contact and crash detection.
// Does NOT: model single motors, propellers, batteries, prop wash or ground
// effect. Preset numbers are ESTIMATES until the builder computes them from
// real parts.
//
// Frame: right-handed, x forward, y left, z up (FLU), metres, seconds,
// radians. Body rates: p rolls right, q noses down, r turns left (positive).

export const GRAVITY = 9.80665;
const PI = Math.PI;

export const degToRad = (d) => (d * PI) / 180;
export const radToDeg = (r) => (r * 180) / PI;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
  cross(o) {
    return new Vec3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x);
  }
  length() { return Math.sqrt(this.dot(this)); }
  normalized() {
    const len = this.length();
    return len > 1e-12 ? this.scale(1 / len) : new Vec3(0, 0, 1);
  }
}

export class Quat {
  constructor(w = 1, x = 0, y = 0, z = 0) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static fromAxisAngle(axis, angle) {
    const a = axis.normalized();
    const s = Math.sin(angle * 0.5);
    return new Quat(Math.cos(angle * 0.5), a.x * s, a.y * s, a.z * s);
  }
  // Rotation whose columns are the body axes in the world frame.
  static fromAxes(xb, yb, zb) {
    const m00 = xb.x, m01 = yb.x, m02 = zb.x;
    const m10 = xb.y, m11 = yb.y, m12 = zb.y;
    const m20 = xb.z, m21 = yb.z, m22 = zb.z;
    const trace = m00 + m11 + m22;
    let out;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      out = new Quat(0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s);
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      out = new Quat((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s);
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      out = new Quat((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s);
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      out = new Quat((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s);
    }
    return out.normalized();
  }
  mul(o) {
    return new Quat(
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w,
    );
  }
  conjugate() { return new Quat(this.w, -this.x, -this.y, -this.z); }
  normalized() {
    const len = Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
    return len > 1e-12 ? new Quat(this.w / len, this.x / len, this.y / len, this.z / len) : new Quat();
  }
  rotate(v) {
    const u = new Vec3(this.x, this.y, this.z);
    const t = u.cross(v).scale(2);
    return v.add(t.scale(this.w)).add(u.cross(t));
  }
}

export const Mode = Object.freeze({ HOLD: 'Hold', ANGLE: 'Angle', ACRO: 'Acro' });
export const MODES = [Mode.HOLD, Mode.ANGLE, Mode.ACRO];

// All values are ESTIMATES for a playable first version.
export function cameraDronePreset() {
  return {
    name: 'Camera drone',
    massKg: 0.9,
    thrustToWeight: 2.2,
    dragCoeff: 0.03,
    maxTiltDeg: 30,
    maxRateDegPerS: 200,
    maxYawRateDegPerS: 100,
    rateTimeConstantS: 0.12,
    attitudeGain: 6,
    holdMaxSpeedMs: 12,
    holdMaxClimbMs: 4,
    crashSpeedMs: 4,
    stickDeadband: 0.05,
    acroExpo: 0.3,
  };
}

export function fpv5InchPreset() {
  return {
    ...cameraDronePreset(),
    name: 'FPV 5-inch',
    massKg: 0.65,
    thrustToWeight: 6,
    dragCoeff: 0.04,
    maxTiltDeg: 55,
    maxRateDegPerS: 670,
    maxYawRateDegPerS: 400,
    rateTimeConstantS: 0.04,
    attitudeGain: 10,
    holdMaxSpeedMs: 20,
    holdMaxClimbMs: 8,
    crashSpeedMs: 6,
  };
}

function newState() {
  return {
    position: new Vec3(),
    velocity: new Vec3(),
    attitude: new Quat(),
    bodyRates: new Vec3(),
    crashed: false,
    onGround: false,
    thrustFraction: 0,
  };
}

function deadband(v, band) {
  if (Math.abs(v) <= band) return 0;
  const sign = v > 0 ? 1 : -1;
  return (sign * (Math.abs(v) - band)) / (1 - band);
}

// Sticks: { throttle, yaw, pitch, roll }, each in [-1, 1]. Throttle -1 = down.
export class FlightModel {
  constructor(params = cameraDronePreset()) {
    this.p = { ...params };
    this.mode = Mode.HOLD;
    this.s = newState();
    this.wind = new Vec3();
    this.groundZ = 0;
    this.hasGround = false;
    this.clearHold();
  }

  setParams(params) { this.p = { ...params }; }
  setMode(mode) {
    this.mode = mode;
    this.clearHold();
  }
  setWind(w) { this.wind = w; }
  setGroundHeight(h) {
    this.groundZ = h;
    this.hasGround = true;
  }

  reset(position = new Vec3(), headingRad = 0) {
    this.s = newState();
    this.s.position = position;
    this.s.attitude = Quat.fromAxisAngle(new Vec3(0, 0, 1), headingRad);
    this.clearHold();
  }

  get state() { return this.s; }
  maxThrustN() { return this.p.thrustToWeight * this.p.massKg * GRAVITY; }
  hoverStick() { return 2 / this.p.thrustToWeight - 1; }

  heading() {
    const fwd = this.s.attitude.rotate(new Vec3(1, 0, 0));
    if (Math.abs(fwd.x) + Math.abs(fwd.y) < 1e-6) {
      const up = this.s.attitude.rotate(new Vec3(0, 0, 1));
      return Math.atan2(-up.y, -up.x);
    }
    return Math.atan2(fwd.y, fwd.x);
  }

  tiltDeg() {
    const up = this.s.attitude.rotate(new Vec3(0, 0, 1));
    return radToDeg(Math.acos(clamp(up.z, -1, 1)));
  }

  step(sticks, dt) {
    if (!(dt > 0)) return;
    const maxStep = 1 / 240;
    let count = Math.ceil(dt / maxStep);
    if (count > 120) count = 120;
    const sub = Math.min(dt, 0.5) / count;
    for (let i = 0; i < count; i++) this.subStep(sticks, sub);
  }

  // Something stopped the drone at stoppedAt (model frame) with this normal.
  contact(stoppedAt, normal) {
    const s = this.s;
    const n = normal.normalized();
    const into = -s.velocity.dot(n);
    s.position = stoppedAt;
    if (into > this.p.crashSpeedMs) {
      s.crashed = true;
      s.velocity = new Vec3();
      s.bodyRates = new Vec3();
      s.thrustFraction = 0;
      return;
    }
    if (into > 0) s.velocity = s.velocity.add(n.scale(into));
    s.velocity = s.velocity.scale(0.8);
    s.onGround = n.z > 0.5;
    if (s.onGround) {
      s.bodyRates = new Vec3();
      s.attitude = Quat.fromAxisAngle(new Vec3(0, 0, 1), this.heading());
    }
  }

  clearHold() {
    this.holdPosition = false;
    this.holdAltitude = false;
    this.holdXY = new Vec3();
    this.holdZ = 0;
    this.velocityIntegral = new Vec3();
  }

  static attitudeFrom(thrustDir, heading) {
    const zb = thrustDir.normalized();
    const xc = new Vec3(Math.cos(heading), Math.sin(heading), 0);
    let yb = zb.cross(xc);
    if (yb.length() < 1e-6) yb = new Vec3(-Math.sin(heading), Math.cos(heading), 0);
    yb = yb.normalized();
    const xb = yb.cross(zb);
    return Quat.fromAxes(xb, yb, zb);
  }

  rateFromAttitudeError(desired, yawRate) {
    let err = this.s.attitude.conjugate().mul(desired);
    if (err.w < 0) err = new Quat(-err.w, -err.x, -err.y, -err.z);
    const limit = degToRad(Math.max(this.p.maxRateDegPerS, 300));
    const gain = 2 * this.p.attitudeGain;
    return new Vec3(clamp(gain * err.x, -limit, limit), clamp(gain * err.y, -limit, limit), yawRate);
  }

  subStep(raw, dt) {
    const p = this.p;
    const s = this.s;
    let thrustN = 0;

    if (!s.crashed) {
      const t = clamp(raw.throttle ?? 0, -1, 1);
      const inp = {
        throttle: deadband(t, p.stickDeadband),
        yaw: deadband(clamp(raw.yaw ?? 0, -1, 1), p.stickDeadband),
        pitch: deadband(clamp(raw.pitch ?? 0, -1, 1), p.stickDeadband),
        roll: deadband(clamp(raw.roll ?? 0, -1, 1), p.stickDeadband),
      };
      const psi = this.heading();
      const yawRate = -inp.yaw * degToRad(p.maxYawRateDegPerS);
      const throttle01 = (t + 1) * 0.5;
      let rateCmd;

      if (this.mode === Mode.ACRO) {
        const e = p.acroExpo;
        const rate = degToRad(p.maxRateDegPerS);
        const rollC = inp.roll * (1 - e) + inp.roll * inp.roll * inp.roll * e;
        const pitchC = inp.pitch * (1 - e) + inp.pitch * inp.pitch * inp.pitch * e;
        rateCmd = new Vec3(rollC * rate, pitchC * rate, yawRate);
        thrustN = throttle01 * this.maxThrustN();
      } else if (this.mode === Mode.ANGLE) {
        const tilt = degToRad(p.maxTiltDeg);
        const level = Quat.fromAxisAngle(new Vec3(0, 0, 1), psi);
        const tilted = level
          .mul(Quat.fromAxisAngle(new Vec3(0, 1, 0), inp.pitch * tilt))
          .mul(Quat.fromAxisAngle(new Vec3(1, 0, 0), inp.roll * tilt));
        const thrustDir = tilted.rotate(new Vec3(0, 0, 1));
        rateCmd = this.rateFromAttitudeError(FlightModel.attitudeFrom(thrustDir, psi), yawRate);
        thrustN = throttle01 * this.maxThrustN();
      } else {
        const out = this.holdControl(inp, psi, dt, yawRate);
        rateCmd = out.rateCmd;
        thrustN = out.thrustN;
      }

      const alpha = dt / (p.rateTimeConstantS + dt);
      s.bodyRates = s.bodyRates.add(rateCmd.sub(s.bodyRates).scale(alpha));
    }

    const w = s.bodyRates;
    const angle = w.length() * dt;
    if (angle > 1e-12) s.attitude = s.attitude.mul(Quat.fromAxisAngle(w, angle)).normalized();

    const thrust = s.attitude.rotate(new Vec3(0, 0, thrustN));
    const air = s.velocity.sub(this.wind);
    const drag = air.scale(-p.dragCoeff * air.length());
    const acc = thrust.add(drag).scale(1 / p.massKg).add(new Vec3(0, 0, -GRAVITY));
    s.velocity = s.velocity.add(acc.scale(dt));
    s.position = s.position.add(s.velocity.scale(dt));
    s.thrustFraction = s.crashed ? 0 : thrustN / this.maxThrustN();
    s.onGround = false;

    if (this.hasGround && s.position.z < this.groundZ) {
      this.contact(new Vec3(s.position.x, s.position.y, this.groundZ), new Vec3(0, 0, 1));
    }
  }

  holdControl(inp, psi, dt, yawRate) {
    const p = this.p;
    const s = this.s;
    const kPos = 1.0;
    const kVel = 2.5;
    const kInt = 0.6;
    const intLimit = 6.0;

    const fwd = new Vec3(Math.cos(psi), Math.sin(psi), 0);
    const left = new Vec3(-Math.sin(psi), Math.cos(psi), 0);
    let velCmd = fwd.scale(inp.pitch * p.holdMaxSpeedMs).add(left.scale(-inp.roll * p.holdMaxSpeedMs));

    // Released sticks: brake to a stop first, then hold where it stopped.
    if (inp.pitch === 0 && inp.roll === 0) {
      const groundSpeed = Math.sqrt(s.velocity.x * s.velocity.x + s.velocity.y * s.velocity.y);
      if (!this.holdPosition && groundSpeed < 0.5) {
        this.holdXY = new Vec3(s.position.x, s.position.y, 0);
        this.holdPosition = true;
      }
      velCmd = new Vec3();
      if (this.holdPosition) {
        velCmd = new Vec3(this.holdXY.x - s.position.x, this.holdXY.y - s.position.y, 0).scale(kPos);
        const len = velCmd.length();
        if (len > p.holdMaxSpeedMs) velCmd = velCmd.scale(p.holdMaxSpeedMs / len);
      }
    } else {
      this.holdPosition = false;
    }

    if (inp.throttle === 0) {
      if (!this.holdAltitude && Math.abs(s.velocity.z) < 0.3) {
        this.holdZ = s.position.z;
        this.holdAltitude = true;
      }
      velCmd.z = this.holdAltitude ? clamp((this.holdZ - s.position.z) * kPos, -p.holdMaxClimbMs, p.holdMaxClimbMs) : 0;
    } else {
      this.holdAltitude = false;
      velCmd.z = inp.throttle * p.holdMaxClimbMs;
    }

    const velErr = velCmd.sub(s.velocity);
    if (!s.onGround) this.velocityIntegral = this.velocityIntegral.add(velErr.scale(dt));
    const vi = this.velocityIntegral;
    this.velocityIntegral = new Vec3(
      clamp(vi.x, -intLimit, intLimit),
      clamp(vi.y, -intLimit, intLimit),
      clamp(vi.z, -intLimit, intLimit),
    );

    const accCmd = velErr.scale(kVel).add(this.velocityIntegral.scale(kInt));
    const force = accCmd.add(new Vec3(0, 0, GRAVITY)).scale(p.massKg);
    force.z = Math.max(force.z, 0.2 * p.massKg * GRAVITY);
    const maxH = force.z * Math.tan(degToRad(p.maxTiltDeg));
    const h = Math.sqrt(force.x * force.x + force.y * force.y);
    if (h > maxH) {
      force.x *= maxH / h;
      force.y *= maxH / h;
    }

    const rateCmd = this.rateFromAttitudeError(FlightModel.attitudeFrom(force, psi), yawRate);
    const tilt = Math.acos(clamp(s.attitude.rotate(new Vec3(0, 0, 1)).z, -1, 1));
    const needed = force.z / Math.max(Math.cos(tilt), 0.3);
    return { rateCmd, thrustN: clamp(needed, 0, this.maxThrustN()) };
  }
}

// three.js is right-handed with y up. Model (x fwd, y left, z up) maps to
// three (x, z, -y). The vector part of a quaternion maps the same way.
export function toThreePosition(v) { return [v.x, v.z, -v.y]; }
export function toThreeQuaternion(q) { return [q.x, q.z, -q.y, q.w]; }
export function fromThreePosition(x, y, z) { return new Vec3(x, -z, y); }
