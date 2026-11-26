// Which mode this build runs in, fixed at build time (VITE_* values are public; nothing secret belongs here).
//   VITE_TOURBILLON_MODE=live          live: the manifest, the API and the chain; never sample data
//   VITE_TOURBILLON_MANIFEST=/deployment.json   where the live site reads its deployment manifest (default shown)
//   VITE_TOURBILLON_SITE_URL=https://…  the public address, for the mobile wallet links (none: those links are off)
// Without VITE_TOURBILLON_MODE the build is the demo: sample markets and simulated positions, labelled as such.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const MODE = env.VITE_TOURBILLON_MODE === 'live' ? 'live' : 'demo';
export const MANIFEST_URL = env.VITE_TOURBILLON_MANIFEST || '/deployment.json';
export const SITE_URL = env.VITE_TOURBILLON_SITE_URL || null;
export const REFRESH_MS = 15000;
