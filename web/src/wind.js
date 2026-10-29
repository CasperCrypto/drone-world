// wind.js — the wind that the drone, the trees, the grass and the windsock feel.
//
// Does: gives the wind vector (m/s) at any point and time, from
//   1. the mean wind at 10 m over open ground (speed and direction you set),
//   2. a height profile: the wind power law with exponent 1/7 over open land,
//   3. gusts: frozen turbulence carried downwind at the mean speed (Taylor's
//      hypothesis), built from waves whose sizes follow the von Karman
//      spectrum, with strengths from the Dryden low-altitude model,
//   4. shelter: slower, gentler air inside forest canopies and in the wake
//      behind buildings (simple engineering estimates, labelled below),
//   5. terrain: near the ground the air follows the slope, so it rises on
//      the windward side of a hill and sinks on the lee side.
// Does NOT: solve fluid dynamics. There are no vortices shed by buildings, no
// thermals, and gusts do not change the drone's attitude directly; they act
// through the drag in the flight model. It is plain maths with no three.js,
// so the same numbers can be tested in Node and ported to the C++ core.
//
// Frame: three.js world metres, x east, y up, z south. Directions in
// degrees are where the wind comes FROM, clockwise from north (as weather
// reports give it).
//
// Sources:
//   Power law, alpha ~ 1/7 over open land in neutral conditions:
//     https://en.wikipedia.org/wiki/Wind_profile_power_law
//   Zero-plane displacement ~ 2/3 of obstacle height:
//     https://en.wikipedia.org/wiki/Log_wind_profile
//   Dryden low-altitude model (sigma_w = 0.1 W20; sigma_u/sigma_w and
//   length scales from height), MIL-HDBK-1797 / MIL-F-8785C, summarised at
//     https://en.wikipedia.org/wiki/Dryden_Wind_Turbulence_Model
//   von Karman longitudinal spectrum, same handbook:
//     https://en.wikipedia.org/wiki/Von_K%C3%A1rm%C3%A1n_wind_turbulence_model
//   Canopy wind decays exponentially below the tree tops (Cionco 1965); the
//   attenuation coefficient here (2.5) is an estimate for a mixed forest.

export const REF_HEIGHT = 10; // m, standard anemometer height
export const ALPHA_OPEN = 1 / 7;
export const CANOPY_ATTENUATION = 2.5; // estimate
export const DISPLACEMENT = 2 / 3; // of canopy height
// Gustiness multiplies the Dryden intensities. 1 = the handbook's values.
export const GUSTINESS = { calm: 0.35, normal: 1, gusty: 1.6, storm: 2.2 }; // estimates
export const SHADER_MODES = 8; // gust waves exported to the vegetation shaders

const FT = 0.3048;

// Dryden low-altitude ratios at height h (metres, clamped to the model's range).
export function drydenRatios(h) {
  const hft = Math.min(Math.max(h, 3) / FT, 1000);
  const k = 0.177 + 0.000823 * hft;
  return {
    sigmaUOverSigmaW: 1 / Math.pow(k, 0.4),
    lengthU: (hft / Math.pow(k, 1.2)) * FT, // metres
    lengthW: hft * FT,
  };
}

// von Karman longitudinal spectrum (one-sided, per rad/m), unit variance.
export function vonKarman(k, L) {
  return (2 * L / Math.PI) / Math.pow(1 + Math.pow(1.339 * L * k, 2), 5 / 6);
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Build gust waves for one wind component: wavenumbers spread log-evenly from
// 8 m to 400 m wavelength, amplitudes from the spectrum, unit total variance.
function makeModes(rand, count, lengthScale, spreadRad) {
  const kMin = (2 * Math.PI) / 400;
  const kMax = (2 * Math.PI) / 8;
  const modes = [];
  let variance = 0;
  for (let i = 0; i < count; i++) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    const k0 = kMin * Math.pow(kMax / kMin, t0);
    const k1 = kMin * Math.pow(kMax / kMin, t1);
    const k = Math.sqrt(k0 * k1);
    const amp = Math.sqrt(2 * vonKarman(k, lengthScale) * (k1 - k0));
    variance += (amp * amp) / 2;
    modes.push({
      k,
      angle: (rand() * 2 - 1) * spreadRad, // wave direction relative to the wind
      amp,
      phase: rand() * Math.PI * 2,
      drift: (rand() * 2 - 1) * 0.08, // slow change of the pattern itself, rad/s
    });
  }
  const norm = 1 / Math.sqrt(variance);
  for (const m of modes) m.amp *= norm;
  // Largest first, so the shader's first SHADER_MODES carry most of the energy.
  return modes.sort((a, b) => b.amp - a.amp);
}

export class WindField {
  /**
   * @param {object} site  { groundHeight(x, z), canopyHeight(x, z), buildings: [{x, z, hw, hd, h}] }
   *   hw / hd are half sizes along x / z; all optional (open flat ground).
   */
  constructor(site = {}, seed = 1) {
    this.site = site;
    this.time = 0;
    this.speed10 = 0;
    this.fromDeg = 270;
    this.gustiness = GUSTINESS.normal;
    const rand = rng(seed);
    const ref = drydenRatios(REF_HEIGHT);
    this.modes = {
      u: makeModes(rand, 16, ref.lengthU, 0.6),
      v: makeModes(rand, 12, ref.lengthU, 1.2),
      w: makeModes(rand, 12, Math.max(ref.lengthW, 6), 1.5),
    };
    this.configure({});
  }

  /** speed10: m/s at 10 m over open ground; fromDeg: where it comes from; gustiness: see GUSTINESS. */
  configure({ speed10 = this.speed10, fromDeg = this.fromDeg, gustiness = this.gustiness }) {
    this.speed10 = Math.max(0, speed10);
    this.fromDeg = fromDeg;
    this.gustiness = Math.max(0, gustiness);
    const toward = ((fromDeg + 180) * Math.PI) / 180;
    // Unit vector the air moves toward, in three.js x (east) / z (south).
    this.dirX = Math.sin(toward);
    this.dirZ = -Math.cos(toward);
    // Dryden: sigma_w = 0.1 * W20 (wind at 20 ft, from the power law).
    const w20 = this.speed10 * Math.pow((20 * FT) / REF_HEIGHT, ALPHA_OPEN);
    this.sigmaW = 0.1 * w20 * this.gustiness;
  }

  advance(dt) {
    this.time += dt;
  }

  /** Mean wind speed at height h (m) above ground, with a forest canopy of height canopy (m). */
  meanSpeed(h, canopy = 0) {
    if (this.speed10 === 0) return 0;
    if (canopy > 1) {
      const d = DISPLACEMENT * canopy;
      const top = this.speed10 * Math.pow(Math.max(canopy - d, 0.5) / REF_HEIGHT, ALPHA_OPEN);
      if (h < canopy) return top * Math.exp(CANOPY_ATTENUATION * (Math.max(h, 0) / canopy - 1));
      return this.speed10 * Math.pow(Math.max(h - d, 0.5) / REF_HEIGHT, ALPHA_OPEN);
    }
    return this.speed10 * Math.pow(Math.max(h, 0.5) / REF_HEIGHT, ALPHA_OPEN);
  }

  // Sum of gust waves for one component at a point, unit variance.
  gust(modes, x, z, count = modes.length) {
    const s = this.speedForAdvection();
    const t = this.time;
    // Positions in the frame moving with the mean wind.
    const ax = x - this.dirX * s * t;
    const az = z - this.dirZ * s * t;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const m = modes[i];
      const c = Math.cos(m.angle);
      const sn = Math.sin(m.angle);
      const kx = m.k * (this.dirX * c - this.dirZ * sn);
      const kz = m.k * (this.dirZ * c + this.dirX * sn);
      sum += m.amp * Math.cos(kx * ax + kz * az + m.phase + m.drift * t);
    }
    return sum;
  }

  speedForAdvection() {
    return this.speed10; // gusts travel at about the mean wind speed
  }

  // Building wake: 0 = full wind, up to 0.7 = 70 % slower (estimate).
  wake(x, z, h) {
    const buildings = this.site.buildings || [];
    let deficit = 0;
    for (const b of buildings) {
      const rx = x - b.x;
      const rz = z - b.z;
      const along = rx * this.dirX + rz * this.dirZ; // downwind distance from the centre
      const across = Math.abs(-rx * this.dirZ + rz * this.dirX);
      const halfAlong = Math.abs(b.hw * this.dirX) + Math.abs(b.hd * this.dirZ);
      const halfAcross = Math.abs(b.hw * this.dirZ) + Math.abs(b.hd * this.dirX);
      const behind = along - halfAlong;
      const length = 6 * b.h; // wakes reach several building heights downwind (estimate)
      if (behind < -halfAlong || behind > length) continue;
      if (across > halfAcross + 0.5 * b.h || h > 1.3 * b.h) continue;
      const d = (1 - Math.max(behind, 0) / length) * (1 - h / (1.3 * b.h)) *
        (1 - Math.max(0, across - halfAcross) / (0.5 * b.h + 1e-6));
      deficit = Math.max(deficit, 0.7 * d);
    }
    return deficit;
  }

  /**
   * Wind at a point. y is the absolute height (three.js y). Returns
   * { x, y, z } in m/s plus speed (horizontal) and the parts for display.
   */
  sample(x, y, z) {
    const ground = this.site.groundHeight ? this.site.groundHeight(x, z) : 0;
    const h = Math.max(y - ground, 0);
    const canopy = this.site.canopyHeight ? this.site.canopyHeight(x, z) : 0;
    if (this.speed10 === 0) return { x: 0, y: 0, z: 0, speed: 0, mean: 0, gust: 0 };

    let mean = this.meanSpeed(h, canopy);
    const wake = this.wake(x, z, h);
    mean *= 1 - wake;

    // Turbulence strengths at this height (Dryden), reduced in the canopy.
    const r = drydenRatios(Math.max(h, 1));
    let shelter = 1;
    if (canopy > 1 && h < canopy) shelter = Math.exp(CANOPY_ATTENUATION * (h / canopy - 1));
    const sigmaW = this.sigmaW * shelter * Math.min(1, h / 3); // vertical gusts die out at the ground
    const sigmaU = this.sigmaW * r.sigmaUOverSigmaW * shelter * (1 + wake);
    const gu = sigmaU * this.gust(this.modes.u, x, z);
    const gv = sigmaU * this.gust(this.modes.v, x, z);
    const gw = sigmaW * this.gust(this.modes.w, x, z);

    const along = Math.max(mean + gu, 0);
    let wx = this.dirX * along - this.dirZ * gv;
    let wz = this.dirZ * along + this.dirX * gv;
    let wy = gw;

    // Air follows the terrain near the ground: rising on windward slopes.
    if (this.site.groundHeight) {
      const e = 2;
      const sx = (this.site.groundHeight(x + e, z) - this.site.groundHeight(x - e, z)) / (2 * e);
      const sz = (this.site.groundHeight(x, z + e) - this.site.groundHeight(x, z - e)) / (2 * e);
      wy += (wx * sx + wz * sz) * Math.exp(-h / 30);
    }
    return { x: wx, y: wy, z: wz, speed: Math.hypot(wx, wz), mean, gust: gu };
  }

  /** Values for the vegetation shaders (longitudinal gust waves only). */
  shaderModes() {
    const n = SHADER_MODES;
    const k = new Float32Array(n * 2);
    const amp = new Float32Array(n);
    const phase = new Float32Array(n);
    const drift = new Float32Array(n);
    const sigmaU = this.sigmaW * drydenRatios(REF_HEIGHT).sigmaUOverSigmaW;
    let kept = 0;
    for (let i = 0; i < n; i++) kept += this.modes.u[i].amp ** 2;
    const norm = 1 / Math.sqrt(kept / 2); // keep unit variance with fewer waves
    for (let i = 0; i < n; i++) {
      const m = this.modes.u[i];
      const c = Math.cos(m.angle);
      const sn = Math.sin(m.angle);
      k[i * 2] = m.k * (this.dirX * c - this.dirZ * sn);
      k[i * 2 + 1] = m.k * (this.dirZ * c + this.dirX * sn);
      amp[i] = m.amp * norm * sigmaU;
      phase[i] = m.phase;
      drift[i] = m.drift;
    }
    return { k, amp, phase, drift, dirX: this.dirX, dirZ: this.dirZ, speed10: this.speed10 };
  }
}
