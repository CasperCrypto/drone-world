# Drone World

An open-source drone flight sandbox: build, fly and test drones in 3D.
Runs in the browser today (three.js); an Unreal Engine client for the
photoreal version comes later and will use the same flight physics.

**Play it in your browser: https://caspercrypto.github.io/drone-world/**

**Status, 2026-10-30: realistic world (milestone M1.5).** The landscape is
generated, not a real place yet. The flight physics is a simplified
quadcopter model and every drone number in it is an estimate. This is a
training and experimentation sandbox, not a certified simulator.

## What works now

**The world**
- A 1 × 1 km practice area inside a 8 × 8 km landscape that runs to the
  horizon: hills, a lake, an airfield (runway with markings and edge lights,
  take-off pad, concrete apron, hangar), a farm (houses, barns, dirt tracks)
  and a 9-gate course with lap times.
- Ground from scanned (CC0) textures: grass, dry grass, forest floor, rock,
  sand, mud, snow, asphalt, concrete, plaster, brick, roof tiles, corrugated
  metal, wood. Real-world texture scale from the scans' own metadata.
- About 10,000 trees grown by our own generator (Scots pine, Norway spruce,
  oak, birch) with scanned bark and leaf textures, drawn at three levels of
  detail: full trees near you, simpler ones further away, and baked
  "impostor" pictures in the distance.
- Real grass blades around the camera (up to 260,000 tufts on Ultra).
- A lake that reflects the sky, with waves that follow the wind and rain rings.

**Time, light and weather**
- Sun and moon where they really are for the date, the Polish clock time and
  the place (NOAA solar equations; moon to about 1°, with its real phase).
  Stars at night, turning around the celestial pole.
- Day, dusk and night with matching light; runway, hangar, yard and window
  lights at night; a drone headlight (L).
- Weather: clear, partly cloudy, overcast, fog, rain, thunderstorm, snow.
  Clouds drift with the wind and dim the sun when they pass in front of it.
  The ground gets wet (darker, shinier, puddles) and dries again; below
  about 0.5 °C precipitation falls as snow and settles.

**Wind**
- Set at 10 m over open ground (speed, direction, gustiness). It grows with
  height (power law, exponent 1/7), gusts travel across the field at the
  wind speed (you see them in the grass and the trees before they hit the
  drone), forests and buildings make slower, rougher air behind them, and
  air rises on windward slopes and sinks behind hills. The drone, trees,
  grass, water and the windsock all feel the same wind. The windsock is
  fully stretched at 15 knots, like a real one.

**Flying**
- Two drones: a camera drone and an FPV 5-inch quad (estimated physics),
  with navigation lights (red left, green right, white strobe).
- Three flight modes: **Hold** (release the sticks and it brakes and hovers),
  **Angle** (self-levelling, manual throttle), **Acro** (rate mode, as FPV
  pilots fly).
- Collisions with the ground, trees, buildings and the lake, crash detection.
- Three views: chase camera, FPV camera, and the pilot standing on the ground.
- Controls: keyboard, gamepads, **your RC radio over USB** (EdgeTX / OpenTX in
  "USB Joystick (HID)" mode, which browsers see as a gamepad), and on-screen
  touch sticks on phones and tablets.
- Upload your own drone model (.glb / .gltf). It changes the look only.
- Graphics presets from Low (phones, old laptops) to Ultra (strong graphics
  cards).

**Art styles** (Settings → Graphics)
- **Stylized** (default): bright designed colours instead of photo
  textures, toon lighting (the sun's light in three soft bands), a colourful
  sky and ground light, ink outlines on silhouettes and edges, contact
  shadows (screen-space ambient occlusion) so things sit on the ground,
  glowing motor rings and lights, and a saturated, contrasty colour grade.
- **Dark studio**: the same world in calm greys with height lines every 5 m
  and a 50 m grid, like an architectural model.
- **Realistic**: the scanned textures and leaf cards.

## What does not exist yet

Batteries and flight time, air density from temperature and height, motor
and propeller physics (the builder), real-world terrain, flying on real
autopilot firmware, multiplayer, accounts, larger paid areas, the Unreal
Engine client. See the roadmap below.

## Run it

It is a static site with no build step. Serve the `web` folder and open it:

```bash
cd web
python3 -m http.server 8080
```

Then open http://localhost:8080. Any static host works (GitHub Pages,
Cloudflare Pages, Netlify). `web/vendor/three` holds the copy of three.js
(r160, MIT) the page loads and `web/assets` the textures, so it also works
offline. The first visit downloads about 15 MB.

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
| Headlight | L | |
| Settings (time, weather, wind, quality) | Esc | Menu/Start |

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
| `web/src/terrain.js` | The generated landscape (2 m grid) and the land to the horizon; ground height exactly as drawn; the ground shader blending eight scanned materials, wetness, puddles and snow. |
| `web/src/trees.js` | Our tree generator: branches as bark tubes, leaves and needles as cards, two levels of detail with the same shape, wind data per vertex. |
| `web/src/forest.js` | Where trees grow, drawing them near / mid / far (baked impostors), swaying in the wind, tree collisions. |
| `web/src/grass.js` | Grass blades around the camera, coloured from the ground scan, bending with the wind. |
| `web/src/world.js` | Airfield, hangar, farm, lights, windsock, gates, collisions. `web/src/layout.js` says where things are. |
| `web/src/water.js` | The lake. |
| `web/src/wind.js` | The wind field (see "Physics notes"). Plain maths, tested in Node. |
| `web/src/solar.js` | Sun and moon positions, Polish clock time. Plain maths, tested in Node. |
| `web/src/sky.js` | Sky, clouds, stars, moon, sunlight and sky light, exposure, reflection map. |
| `web/src/weather.js` | Weather presets, rain and snow, lightning, wet ground and snow cover. |
| `web/src/environment.js` | Keeps time, weather, wind and light in step each frame. |
| `web/src/shaders.js` | GLSL and uniforms shared by the custom shaders (wind, noise). |
| `web/src/textures.js` | Loads the scanned textures; packs the ground layers into texture arrays. |
| `web/src/post.js`, `quality.js` | Outlines and contact shadows from the depth buffer, bloom, tone mapping, colour grade, anti-aliasing; graphics presets and art style. |
| `web/src/palette.js` | Colours and look switches of the Stylized and Dark studio styles. |
| `web/src/controls.js` | Keyboard, Gamepad API (gamepads and RC radios), touch sticks. |
| `web/src/drone-mesh.js` | The drones' look, lights and headlight; loading your own model. |
| `web/src/main.js` | Loading, cameras, HUD, settings, the main loop. |
| `tools/fetch-assets.mjs`, `tools/optimize-textures.py` | Download the CC0 textures from Poly Haven and convert them to WebP (run by the "Fetch assets" workflow). Credits in `web/assets/CREDITS.md`. |

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

## Physics notes

**Wind** (`web/src/wind.js`, tests in `web/tests/environment.test.mjs`):
- Mean wind over open ground follows the power law with exponent 1/7
  ([wind profile power law](https://en.wikipedia.org/wiki/Wind_profile_power_law)),
  set by the speed at the standard 10 m height.
- Gust strengths follow the Dryden low-altitude model of MIL-HDBK-1797
  (σw = 0.1 × wind at 20 ft; σu/σw and length scales from height;
  [summary](https://en.wikipedia.org/wiki/Dryden_Wind_Turbulence_Model)).
  Their sizes follow the von Kármán spectrum, and they are carried downwind
  at the mean speed (Taylor's frozen turbulence). Tests check the average
  gust strength against the model and that gusts arrive downwind on time.
- Over forests the wind is displaced upward by about 2/3 of the canopy
  height ([log wind profile](https://en.wikipedia.org/wiki/Log_wind_profile))
  and decays exponentially inside it (attenuation 2.5, an estimate). Behind
  buildings the wind is up to 70 % slower for about six building heights
  (an estimate). Near the ground the air follows the slope.
- Not modelled: vortices shed by buildings, thermals, gusts that turn the
  drone directly (they act through drag).

**Sun and moon** (`web/src/solar.js`): NOAA General Solar Position
Calculations; moon from the first terms of Meeus, *Astronomical
Algorithms*, ch. 47; Polish CET/CEST from Directive 2000/84/EC.

**Rain and snow** fall at about 7 m/s and 1 m/s (terminal velocities after
Gunn & Kinzer, 1949). How fast the ground wets, dries and gets snow-covered
is a game estimate.

## Roadmap

| # | Milestone | State |
|---|---|---|
| M1 | Playable browser sandbox: landscape, two drones, three modes, controllers, gates | **Done** |
| M1.5 | Realistic world: scanned materials, generated forest, grass, sky, day and night, weather, temperature, wind field | **Done (2026-10-30)** |
| M2 | Energy and air: battery model (capacity, voltage sag, cold), flight time and low-battery behaviour, air density from temperature and height, in `core/cpp` and `flight.js` together | Next |
| M3 | Builder: frame, motors, propellers, battery → thrust, weight, hover throttle, flight time (from real test data, labelled estimates until then) | Planned |
| M4 | Real places: 3D Tiles (Cesium ion or Google Photorealistic, each with its own key and terms) or open elevation data | Planned |
| M5 | Real autopilot: fly on ArduPilot or PX4 in software-in-the-loop | Planned |
| M6 | Accounts, larger areas (the 10 × 10 km tier), multiplayer | Planned, after users ask for it |
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

MIT, see `LICENSE`. three.js is MIT (`web/vendor/three/LICENSE`). Textures
are CC0 from Poly Haven; tree bark and leaf images come with EZ-Tree (MIT).
See `web/assets/CREDITS.md`.
