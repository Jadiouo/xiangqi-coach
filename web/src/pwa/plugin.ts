// Build-time PWA files: manifest, generated icons, and the service worker with its precache list.
// Runs in closeBundle, after Vite has copied public/ (wasm) into the output dir.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { renderIconPng, renderIconSvg } from "./icon";
import { buildManifest } from "./manifest";
import { buildPrecache, normalizeBase, type BuildFile } from "./precache";
import { renderServiceWorker } from "./sw-render";

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

async function put(outDir: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(outDir, path)), { recursive: true });
  await writeFile(join(outDir, path), content);
}

export async function emitPwaFiles(outDir: string, rawBase: string): Promise<{ version: string; urls: string[] }> {
  const base = normalizeBase(rawBase);
  await put(outDir, "manifest.webmanifest", JSON.stringify(buildManifest(base), null, 2) + "\n");
  await put(outDir, "icons/icon.svg", renderIconSvg());
  await put(outDir, "icons/icon-192.png", renderIconPng(192));
  await put(outDir, "icons/icon-512.png", renderIconPng(512));
  await put(outDir, "icons/icon-maskable-512.png", renderIconPng(512, { maskable: true }));

  const files: BuildFile[] = [];
  for (const full of await listFiles(outDir)) {
    files.push({ path: relative(outDir, full).split(sep).join("/"), content: await readFile(full) });
  }
  const { urls, version } = buildPrecache(files, base);
  const template = await readFile(join(dirname(fileURLToPath(import.meta.url)), "service-worker.js"), "utf8");
  await put(outDir, "sw.js", renderServiceWorker(template, { version, urls, base }));
  return { version, urls };
}

export function pwaPlugin(): Plugin {
  let base = "/";
  let outDir = "dist";
  return {
    name: "xiangqi-coach-pwa",
    apply: "build",
    configResolved(config) {
      base = config.base;
      outDir = join(config.root, config.build.outDir);
    },
    async closeBundle() {
      await emitPwaFiles(outDir, base);
    },
  };
}
