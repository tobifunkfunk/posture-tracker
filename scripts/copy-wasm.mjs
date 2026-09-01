/**
 * MediaPipe's wasm runtime is served from the app's own origin rather than a
 * CDN, so the PWA works with no network at all. Copied from node_modules at
 * install and build time to keep it in step with the package version.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../node_modules/@mediapipe/tasks-vision/wasm');
const to = resolve(here, '../public/wasm');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied MediaPipe wasm -> public/wasm`);
