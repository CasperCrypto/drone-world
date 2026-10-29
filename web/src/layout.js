// layout.js — where things are in the free 1 x 1 km area.
//
// Does: one list of places (airfield, runway, take-off pad, hangar, farm
// houses, lake, dirt tracks, windsock) shared by the terrain (which paints
// tracks and yards and keeps grass off the runway), the world (which builds
// them), the forest (which keeps trees away) and the wind (building wakes).
// Does NOT: build anything itself.
//
// Coordinates: three.js metres, x east, y up, z south; origin at the
// runway centre.

export const WORLD_SIZE = 1024;
export const HALF = WORLD_SIZE / 2;
export const WATER_LEVEL = -4.0;
export const AIRFIELD_RADIUS = 70;
export const LAKE = { x: 260, z: 190, r: 95 };

export const RUNWAY = { x: 0, z: 0, length: 180, width: 18 }; // along x
export const PAD = { x: -60, z: 0, size: 6 };
export const HANGAR = { x: 20, z: -40, w: 34, d: 22, h: 11 }; // w along x, d along z
export const APRON = { x: 20, z: -22, w: 46, d: 16 }; // concrete in front of the hangar doors
export const WINDSOCK = { x: 30, z: 20 };

// Farm houses: position, footprint (w along x, d along z), wall height.
export const HOUSES = [
  { x: -150, z: 120, w: 11, d: 8, h: 5.5, roof: 'tiles' },
  { x: -172, z: 150, w: 9, d: 7, h: 4.8, roof: 'tiles' },
  { x: -128, z: 158, w: 16, d: 9, h: 6.0, roof: 'metal', barn: true },
  { x: 160, z: -150, w: 10, d: 8, h: 5.2, roof: 'tiles' },
  { x: 186, z: -128, w: 14, d: 9, h: 6.2, roof: 'metal', barn: true },
  { x: -210, z: -170, w: 10, d: 7, h: 5.0, roof: 'tiles' },
];

// Dirt tracks as polylines (x, z), 3 m wide.
export const TRACKS = [
  [[-150, 132], [-128, 100], [-100, 60], [-70, 30], [-40, -10], [-5, -22]],
  [[160, -138], [130, -110], [90, -80], [55, -50], [40, -30]],
  [[-210, -158], [-170, -110], [-120, -60], [-80, -30], [-40, -14]],
];
export const TRACK_WIDTH = 3;

// Yards: bare ground around buildings (x, z, radius).
export const YARDS = [
  ...HOUSES.map((h) => ({ x: h.x, z: h.z, r: Math.max(h.w, h.d) * 0.9 })),
];

// Distance from (x, z) to the nearest track centre line.
export function trackDistance(x, z) {
  let best = Infinity;
  for (const line of TRACKS) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
  }
  return best;
}

// Is (x, z) on a hard surface (runway, apron, pad, building), with a margin?
export function onHardSurface(x, z, margin = 0) {
  if (Math.abs(x - RUNWAY.x) < RUNWAY.length / 2 + margin && Math.abs(z - RUNWAY.z) < RUNWAY.width / 2 + margin) return true;
  if (Math.abs(x - APRON.x) < APRON.w / 2 + margin && Math.abs(z - APRON.z) < APRON.d / 2 + margin) return true;
  if (Math.abs(x - HANGAR.x) < HANGAR.w / 2 + margin && Math.abs(z - HANGAR.z) < HANGAR.d / 2 + margin) return true;
  for (const h of HOUSES) {
    if (Math.abs(x - h.x) < h.w / 2 + margin && Math.abs(z - h.z) < h.d / 2 + margin) return true;
  }
  return false;
}
