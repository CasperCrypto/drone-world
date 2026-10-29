// audio.js — what you hear: motors, propellers, wind, rain, thunder, nature.
//
// Does: synthesises every sound live with the Web Audio API (no sound files
// to download): four motors whose pitch follows the propellers' blade-pass
// frequency (rpm x blades) and the thrust, propeller wash, wind noise from
// the air moving past the microphone (the drone's camera in FPV and chase
// view, the pilot on the ground view), rain on the ground, thunder a few
// seconds after each lightning flash (sound travels about 343 m/s), birds
// by day and crickets on warm nights. Sound fades with distance and loses
// its high tones far away, as it does in air.
// Does NOT: model Doppler, echoes from buildings, or each motor's real
// recorded sound; pitches are estimates (camera drone about 6,000 rpm at
// hover with 2 blades, FPV 5-inch about 15,000 rpm with 3 blades).
// Browsers only allow sound after a click, so start() is called from the
// "Start flying" button.

const HOVER_BLADE_PASS = { camera: 200, fpv: 750 }; // Hz at hover, estimates

function noiseBuffer(ctx, seconds = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.8;
    this.birdT = 3;
    this.lastFlash = 0;
  }

  /** Must be called from a click or key press. */
  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);
    this.noise = noiseBuffer(ctx);
    const loopNoise = () => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(0, Math.random() * 1.5);
      return src;
    };

    // Drone: four motors (slightly different speeds beat against each other),
    // through an air-absorption low-pass and a distance gain.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.airLP = ctx.createBiquadFilter();
    this.airLP.type = 'lowpass';
    this.airLP.frequency.value = 9000;
    this.droneGain.connect(this.airLP).connect(this.master);
    this.motors = [];
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const g = ctx.createGain();
      g.gain.value = 0.05;
      const band = ctx.createBiquadFilter();
      band.type = 'peaking';
      band.frequency.value = 1200;
      band.Q.value = 1.2;
      band.gain.value = 6;
      osc.connect(band).connect(g).connect(this.droneGain);
      osc.start();
      this.motors.push({ osc, g, detune: 1 + (i - 1.5) * 0.011 });
    }
    const wash = loopNoise();
    this.washBand = ctx.createBiquadFilter();
    this.washBand.type = 'bandpass';
    this.washBand.Q.value = 0.7;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    wash.connect(this.washBand).connect(this.washGain).connect(this.droneGain);

    // Wind past the microphone.
    const wind = loopNoise();
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = 'lowpass';
    this.windLP.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windLP).connect(this.windGain).connect(this.master);

    // Rain on the ground and leaves.
    const rain = loopNoise();
    const rainHP = ctx.createBiquadFilter();
    rainHP.type = 'highpass';
    rainHP.frequency.value = 1800;
    const rainLP = ctx.createBiquadFilter();
    rainLP.type = 'lowpass';
    rainLP.frequency.value = 9000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(rainHP).connect(rainLP).connect(this.rainGain).connect(this.master);

    // Crickets: a 4.6 kHz tone pulsed 30 times a second, in chirps about
    // twice a second (two square-wave oscillators drive the gains).
    const cricket = ctx.createOscillator();
    cricket.frequency.value = 4600;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    const chirp = ctx.createGain();
    chirp.gain.value = 0.5;
    for (const [gainNode, hz] of [[pulse, 30], [chirp, 2.2]]) {
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = hz;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(gainNode.gain);
      lfo.start();
    }
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    cricket.connect(pulse).connect(chirp).connect(this.cricketGain).connect(this.master);
    cricket.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  thunder(distance) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + distance / 343; // speed of sound in air, about 343 m/s at 20 C
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160 + 2000 / (1 + distance / 300);
    const g = ctx.createGain();
    const peak = Math.min(1.2, 900 / (distance + 300));
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(peak * 0.4, t0 + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 4.5 + Math.random() * 2);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 7);
  }

  bird() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 2400;
    g.gain.setValueAtTime(0, t0);
    for (let n = 0; n < notes; n++) {
      const t = t0 + n * (0.09 + Math.random() * 0.05);
      osc.frequency.setValueAtTime(base * (1 + Math.random() * 0.3), t);
      osc.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), t + 0.07);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025 + Math.random() * 0.02, t + 0.01);
      g.gain.linearRampToValueAtTime(0, t + 0.07);
    }
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + notes * 0.15 + 0.1);
  }

  /**
   * s: { thrust 0..1, style 'camera'|'fpv', distance (m, mic to drone), micWind (m/s of air
   *      past the mic), rain 0..1, lightning (0..1 this frame), day 0..1, night 0..1,
   *      temperature (C), crashed }
   */
  update(dt, s) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const k = 0.06; // smoothing time constant (s)

    // Motors: blade-pass frequency grows with the square root of thrust
    // (thrust goes with rpm squared).
    const spinning = s.crashed ? 0 : s.thrust > 0.01 ? 1 : 0;
    const hover = HOVER_BLADE_PASS[s.style] || 200;
    const f = hover * Math.sqrt(Math.max(s.thrust, 0.02) / 0.45);
    this.motors.forEach((m, i) => {
      const wobble = 1 + Math.sin(now * (1.3 + i * 0.7)) * 0.004;
      m.osc.frequency.setTargetAtTime(f * m.detune * wobble, now, k);
    });
    // Loudness: louder with thrust; inverse distance; high tones fade with distance.
    const d = Math.max(s.distance, 0.6);
    const near = s.style === 'fpv' ? 0.9 : 0.7;
    const level = spinning * near * (0.35 + 0.65 * Math.sqrt(s.thrust)) / Math.max(1, d / 1.5);
    this.droneGain.gain.setTargetAtTime(level, now, k);
    this.airLP.frequency.setTargetAtTime(11000 / (1 + d / 25), now, 0.2);
    this.washBand.frequency.setTargetAtTime(500 + 1800 * s.thrust, now, k);
    this.washGain.gain.setTargetAtTime(spinning * 0.5 * s.thrust, now, k);

    // Wind on the microphone: rumble that grows with the square of the speed.
    const w = Math.min(s.micWind / 20, 1.2);
    this.windGain.gain.setTargetAtTime(0.5 * w * w, now, 0.15);
    this.windLP.frequency.setTargetAtTime(250 + 900 * w, now, 0.15);

    this.rainGain.gain.setTargetAtTime(0.22 * s.rain, now, 0.4);

    if (s.lightning > 0.5 && now - this.lastFlash > 1) {
      this.lastFlash = now;
      this.thunder(300 + Math.random() * 2500);
    }

    // Birds by day in calm weather; crickets on warm nights.
    if (s.day > 0.6 && s.rain < 0.1 && s.micWind < 9) {
      this.birdT -= dt;
      if (this.birdT <= 0) {
        this.bird();
        this.birdT = 1.5 + Math.random() * 6;
      }
    }
    const crickets = s.night > 0.7 && s.temperature > 12 && s.rain < 0.1 ? 0.012 : 0;
    this.cricketGain.gain.setTargetAtTime(crickets, now, 0.5);
  }
}
