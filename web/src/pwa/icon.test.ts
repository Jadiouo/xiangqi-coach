import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderIconPng, renderIconSvg } from "./icon";

function decode(png: Uint8Array) {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  expect(b[24]).toBe(8); // bit depth
  expect(b[25]).toBe(6); // RGBA
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    const type = b.subarray(o + 4, o + 8).toString("latin1");
    if (type === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, raw };
}

describe("generated icons", () => {
  it.each([192, 512])("draws a valid %i px RGBA PNG that is not blank", (size) => {
    const { width, height, raw } = decode(renderIconPng(size));
    expect(width).toBe(size);
    expect(height).toBe(size);
    expect(raw.length).toBe(size * (1 + size * 4));
    const colours = new Set<number>();
    for (let y = 0; y < size; y += 3) {
      for (let x = 0; x < size; x += 3) {
        const o = y * (1 + size * 4) + 1 + x * 4;
        colours.add(raw.readUInt32BE(o));
      }
    }
    expect(colours.size).toBeGreaterThanOrEqual(3);
  });

  it("is reproducible byte for byte", () => {
    expect(Buffer.from(renderIconPng(192)).equals(Buffer.from(renderIconPng(192)))).toBe(true);
  });

  it("maskable variant fills the corners (no transparent edge); normal variant does not", () => {
    const corner = (png: Uint8Array) => decode(png).raw.readUInt32BE(1);
    expect(corner(renderIconPng(192, { maskable: true }) ) & 0xff).toBe(255);
    expect(corner(renderIconPng(192)) & 0xff).toBe(0);
  });

  it("SVG is self-contained: no external references or raster images", () => {
    const svg = renderIconSvg();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).not.toMatch(/<image|href=|url\(http|<script/);
  });
});
