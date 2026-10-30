// Renders public/icon-192.png and icon-512.png (dark tile + blue bolt) with no dependencies.
import fs from "node:fs";
import zlib from "node:zlib";

const bolt = [[290, 76], [150, 276], [242, 276], [220, 436], [362, 232], [268, 232]]; // in 512 space

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 3; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let boltCov = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
        if (inside(bolt, ((x + (sx + 0.5) / S) / size) * 512, ((y + (sy + 0.5) / S) / size) * 512)) boltCov++;
      const a = boltCov / (S * S), t = (x + y) / (2 * size);
      const bg = [26 - 15 * t, 42 - 27 * t, 61 - 40 * t];
      const fg = [56, 182, 255];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] * (1 - a) + fg[c] * a);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [192, 512]) fs.writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), render(s));
console.log("icons written");
