/**
 * Download the MediaPipe task models into public/models.
 *
 * These are kept out of git for the same reason as the wasm runtime: they are
 * large, freely downloadable, immutable binaries, and a new model version
 * would otherwise add another 9MB to the history forever.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = [
  {
    file: 'pose_landmarker_lite.task',
    url: `${BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/models');
await mkdir(outDir, { recursive: true });

for (const { file, url } of MODELS) {
  const dest = resolve(outDir, file);
  try {
    await access(dest);
    console.log(`${file} already present, skipping`);
    continue;
  } catch {
    /* not there yet, fetch it */
  }

  process.stdout.write(`fetching ${file}… `);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${file}: ${res.status} ${res.statusText}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, bytes);
  console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
}
