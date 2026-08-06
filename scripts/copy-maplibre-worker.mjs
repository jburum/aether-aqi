#!/usr/bin/env node
/**
 * MapLibre's ESM worker imports ./maplibre-gl-shared.mjs by relative path.
 * Vite's hashed ?url worker breaks that (404 on shared). Serve both from
 * /public/maplibre/ with stable paths instead.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules/maplibre-gl/dist");
const out = join(root, "public/maplibre");

mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(dist, f), join(out, f));
}
console.log("[copy-maplibre-worker] public/maplibre ready");
