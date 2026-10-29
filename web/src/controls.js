// controls.js — sticks from a keyboard, a gamepad, a real RC radio or the
// on-screen pads.
//
// Does: reads the browser Gamepad API (standard gamepads, and RC radios such
// as EdgeTX/OpenTX ones plugged in by USB in joystick mode, which browsers
// list as generic gamepads), the keyboard and two touch sticks; maps a radio's
// axes with a saved, user-editable mapping; fires actions (mode, camera,
// reset, drone type, settings, headlight, sound).
// Does NOT: talk to a radio over anything but USB joystick mode.
//
// Output sticks are in [-1, 1]: throttle -1 = down, pitch +1 = forward,
// roll +1 = right, yaw +1 = right.

const STORE_KEY = 'droneworld.radio.v1';

const DEFAULT_RADIO = { throttle: 2, yaw: 3, pitch: 1, roll: 0, invThrottle: false, invYaw: false, invPitch: false, invRoll: false };

function loadRadio() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return saved ? { ...DEFAULT_RADIO, ...saved } : { ...DEFAULT_RADIO };
  } catch {
    return { ...DEFAULT_RADIO };
  }
}

export class Controls {
  constructor(touchRoot) {
    this.keys = new Set();
    this.handlers = {};
    this.radio = loadRadio();
    this.keyThrottle = 0;
    this.source = 'keyboard';
    this.padButtons = new Map();
    this.learning = null;
    this.touch = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 }, active: false };

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.keyAction(k);
      this.keys.add(k);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    if (touchRoot) this.setupTouch(touchRoot);
  }

  on(action, fn) {
    this.handlers[action] = fn;
  }

  fire(action) {
    if (this.handlers[action]) this.handlers[action]();
  }

  keyAction(k) {
    const map = { m: 'mode', c: 'camera', r: 'reset', p: 'preset', escape: 'settings', g: 'course', h: 'help', l: 'light', k: 'mute' };
    if (map[k]) this.fire(map[k]);
  }

  saveRadio() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.radio));
    } catch {
      // Storage blocked: the mapping lasts until the page closes.
    }
  }

  // Start "learn": the next axis that moves a lot becomes this stick.
  learn(stick) {
    this.learning = { stick, start: null };
  }

  gamepads() {
    const list = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return list.map((g) => ({ pad: g, radio: g.mapping !== 'standard' }));
  }

  // dt: seconds since the last call. hoverStick: throttle that hovers (for keyboard in Angle/Acro).
  poll(dt, holdMode, hoverStick) {
    const pads = this.gamepads();
    const radio = pads.find((p) => p.radio);
    const pad = pads.find((p) => !p.radio);
    let s = null;

    if (radio) {
      const ax = radio.pad.axes;
      if (this.learning) this.learnStep(ax);
      const get = (name) => {
        const v = ax[this.radio[name]] ?? 0;
        return this.radio['inv' + name[0].toUpperCase() + name.slice(1)] ? -v : v;
      };
      s = { throttle: get('throttle'), yaw: get('yaw'), pitch: get('pitch'), roll: get('roll') };
      this.source = `radio: ${radio.pad.id.slice(0, 40)}`;
      this.buttons(radio.pad, { 0: 'reset', 1: 'mode', 2: 'camera' });
    } else if (pad) {
      const ax = pad.pad.axes;
      s = { throttle: -(ax[1] ?? 0), yaw: ax[0] ?? 0, pitch: -(ax[3] ?? 0), roll: ax[2] ?? 0 };
      this.source = 'gamepad';
      this.buttons(pad.pad, { 3: 'mode', 2: 'reset', 1: 'camera', 8: 'preset', 9: 'settings' });
    }

    const moving = s && (Math.abs(s.yaw) + Math.abs(s.pitch) + Math.abs(s.roll) > 0.15 || Math.abs(s.throttle) > 0.15);
    if (this.touch.active) {
      s = { throttle: this.touch.left.y, yaw: this.touch.left.x, pitch: this.touch.right.y, roll: this.touch.right.x };
      this.source = 'touch';
    } else if (!s || (!moving && this.keys.size > 0)) {
      s = this.keyboard(dt, holdMode, hoverStick);
      this.source = 'keyboard';
    }
    return s;
  }

  keyboard(dt, holdMode, hoverStick) {
    const k = this.keys;
    const axis = (pos, neg) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    const up = axis('w', 's');
    let throttle;
    if (holdMode) {
      throttle = up; // spring stick: release = hold height
    } else {
      // Manual throttle: W/S move a throttle that stays where you leave it.
      this.keyThrottle = Math.min(1, Math.max(-1, this.keyThrottle + up * dt * 0.9));
      throttle = this.keyThrottle;
    }
    return {
      throttle,
      yaw: axis('d', 'a'),
      pitch: axis('arrowup', 'arrowdown'),
      roll: axis('arrowright', 'arrowleft'),
    };
  }

  resetKeyThrottle(hoverStick) {
    this.keyThrottle = hoverStick;
  }

  buttons(pad, map) {
    pad.buttons.forEach((b, i) => {
      const was = this.padButtons.get(`${pad.index}:${i}`) || false;
      if (b.pressed && !was && map[i]) this.fire(map[i]);
      this.padButtons.set(`${pad.index}:${i}`, b.pressed);
    });
  }

  learnStep(axes) {
    const l = this.learning;
    if (!l.start) {
      l.start = [...axes];
      return;
    }
    let best = -1;
    let bestDelta = 0;
    axes.forEach((v, i) => {
      const d = Math.abs(v - l.start[i]);
      if (d > bestDelta) {
        bestDelta = d;
        best = i;
      }
    });
    if (bestDelta > 0.6) {
      this.radio[l.stick] = best;
      this.saveRadio();
      this.learning = null;
      this.fire('learned');
    }
  }

  setupTouch(root) {
    const sticks = root.querySelectorAll('[data-stick]');
    sticks.forEach((el) => {
      const side = el.dataset.stick;
      const knob = el.querySelector('span');
      const spring = side === 'right';
      let id = null;
      const set = (e) => {
        const r = el.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
        const cx = Math.max(-1, Math.min(1, x));
        const cy = Math.max(-1, Math.min(1, y));
        this.touch[side] = { x: cx, y: cy };
        knob.style.transform = `translate(${cx * 40}px, ${-cy * 40}px)`;
      };
      el.addEventListener('pointerdown', (e) => {
        id = e.pointerId;
        el.setPointerCapture(id);
        this.touch.active = true;
        set(e);
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId === id) set(e);
      });
      const end = (e) => {
        if (e.pointerId !== id) return;
        id = null;
        // Right stick springs to centre; left keeps throttle height in
        // Angle/Acro but centres yaw. In Hold mode centre throttle = hold.
        const keepY = !spring && this.touchKeepsThrottle;
        this.touch[side] = { x: 0, y: keepY ? this.touch[side].y : 0 };
        knob.style.transform = `translate(0px, ${keepY ? -this.touch[side].y * 40 : 0}px)`;
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }
}
