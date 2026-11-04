import { pwaZhTW } from "../locale/pwa-zh-TW";
import { PWA_BACKGROUND_COLOR, PWA_THEME_COLOR } from "./config";
import { normalizeBase } from "./precache";

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

export function buildManifest(rawBase: string): WebManifest {
  const base = normalizeBase(rawBase);
  const icon = (file: string, size: number, purpose: string): ManifestIcon => ({
    src: `${base}icons/${file}`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  return {
    id: base,
    name: pwaZhTW.name,
    short_name: pwaZhTW.shortName,
    description: pwaZhTW.description,
    lang: "zh-Hant",
    start_url: base,
    scope: base,
    display: "standalone",
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: [
      icon("icon-192.png", 192, "any"),
      icon("icon-512.png", 512, "any"),
      icon("icon-maskable-512.png", 512, "maskable"),
    ],
  };
}
