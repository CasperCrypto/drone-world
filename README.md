# Drone World

An open-source drone flight sandbox: build, fly and test drones in 3D.
Runs in the browser today (three.js); an Unreal Engine client for the
photoreal version comes later and will use the same flight physics.

**Play it in your browser: https://caspercrypto.github.io/drone-world/**

**Status, 2026-10-29: first playable prototype (milestone M1).** The landscape
is generated, not a real place yet. The flight physics is a simplified
quadcopter model and every drone number in it is an estimate. This is a
training and experimentation sandbox, not a certified simulator.

## What works now

- A 1 × 1 km practice area: hills, mixed forest, a lake, an airfield with a
  runway and a take-off pad, buildings, and a 9-gate course with lap times.
- Two drones: a camera drone and an FPV 5-inch quad (estimated physics).
- Three flight modes: **Hold** (release the sticks and it brakes and hovers),
  **Angle** (self-levelling, manual throttle), **Acro** (rate mode, as FPV
  pilots fly).
- Wind (speed and direction), collisions with the ground, trees, buildings
  and the lake, crash detection.
- Three views: chase camera, FPV camera, and the pilot standing on the ground.
- Controls: keyboard, gamepads, **your RC radio over USB** (EdgeTX / OpenTX in
  "USB Joystick (HID)" mode, which browsers see as a gamepad), and on-screen
  touch sticks on phones and tablets.
- Upload your own drone model (.glb / .gltf). It changes the look only.

## What does not exist yet

Real-world terrain, the parts builder, flying on real autopilot firmware,
multiplayer, accounts, larger paid areas, the Unreal Engine client. See the
roadmap below.

## Run it

It is a static site with no build step. Serve the `web` folder and open it:

```bash
cd web
python3 -m http.server 8080
```

Then open http://localhost:8080. Any static host works (GitHub Pages,
Cloudflare Pages, Netlify). `web/vendor/three` holds the copy of three.js
(r160, MIT) the page loads, so it also works offline.

`.github/workflows/site.yml` runs both test suites on every push and pull
request and publishes `web/` to GitHub Pages on every push to `main` (one-time
repository setting: Settings → Pages → Source: **GitHub Actions**).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / yaw | W S / A D | left stick |
| Pitch / roll | arrow keys | right stick |
| Flight mode | M | Y |
| Camera | C | B |
| Reset to the pad | R | X |
| Drone type | P | View/Back |
| Settings | Esc | Menu/Start |

**RC radio:** plug it in by USB and pick "USB Joystick (HID)" on the radio
([EdgeTX manual](https://manual.edgetx.org/color-radios/model-settings/model-setup/usb-joystick)).
If the sticks are mixed up, open Settings → Radio and press **Learn** next to
each stick.

## How it is built

| Path | What it is |
|---|---|
| `core/cpp/DroneFlightModel.h` | The reference flight physics in plain C++17 (no engine types). The future Unreal client compiles this file. |
| `core/cpp/tests/` | Its tests (`run.sh`) and the recorder of reference flights (`make_fixture.sh`). |
| `core/fixtures/trajectory.json` | Three scripted flights recorded from the C++ model. |
| `web/src/flight.js` | The same physics in JavaScript, line by line. Its tests replay the recorded flights and must match the C++ model to 1e-6 m. |
| `web/src/terrain.js` | The generated landscape; ground height exactly as drawn. |
| `web/src/world.js` | Lake, runway, buildings, forest, gates, collisions. |
| `web/src/controls.js` | Keyboard, Gamepad API (gamepads and RC radios), touch sticks. |
| `web/src/drone-mesh.js` | The drone's look; loading your own model. |
| `web/src/main.js` | Scene, cameras, HUD, settings, the main loop. |

Tests:

```bash
core/cpp/tests/run.sh
```
```bash
cd web && npm test
```

## Why the browser first, and Unreal later

- Unreal Engine has had no browser export since version 4.24; "Unreal in the
  browser" today means Pixel Streaming, where a GPU server renders for each
  player and streams video, so cost grows with every player online at once
  ([overview](https://www.summerengine.com/make-great-games/unreal-engine-html5-export)).
- three.js runs on the player's own computer, costs nothing per player, and
  can draw real-world 3D Tiles through the open-source
  [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS)
  (originally from NASA JPL).

## Roadmap

| # | Milestone | State |
|---|---|---|
| M1 | Playable browser sandbox: landscape, two drones, three modes, controllers, gates | **Done (prototype)** |
| M2 | Real places: 3D Tiles (Cesium ion or Google Photorealistic, each with its own key and terms) or open elevation data | Next |
| M3 | Builder: frame, motors, propellers, battery → thrust, weight, hover throttle, flight time (from real test data, labelled estimates until then) | Planned |
| M4 | Real autopilot: fly on ArduPilot or PX4 in software-in-the-loop | Planned |
| M5 | Accounts, larger areas (the 10 × 10 km tier), multiplayer | Planned, after users ask for it |
| U1 | Unreal Engine 5 client with the same `core/cpp` physics | Later |

## Rules for contributions

- Keep `core/cpp/DroneFlightModel.h` and `web/src/flight.js` in step. If you
  change one, change the other, run `make_fixture.sh` and both test suites.
- No weapons, payload release, strike or counter-drone evasion content.
- Do not model real critical infrastructure (power plants, military sites)
  in detail in anything public.
- Every number a user reads is either measured (with its source) or labelled
  an estimate.

## Licence

MIT, see `LICENSE`. three.js is MIT (`web/vendor/three/LICENSE`).
