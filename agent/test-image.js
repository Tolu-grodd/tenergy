// Writes a synthetic test photo, for trying the camera upload path without a camera: node test-image.js out.jpg
import { Jimp } from "jimp";
import fs from "node:fs";

const img = new Jimp({ width: 1600, height: 1200, color: 0x203040ff });
for (let y = 0; y < 1200; y += 6) for (let x = 0; x < 1600; x += 6) img.setPixelColor(((Math.floor((x * 255) / 1600) << 24) | (Math.floor((y * 255) / 1200) << 16) | 0x8000 | 0xff) >>> 0, x, y);
const buf = await img.clone().resize({ w: 1280 }).getBuffer("image/jpeg", { quality: 70 });
fs.writeFileSync(process.argv[2] || "test.jpg", buf);
console.log("wrote", process.argv[2] || "test.jpg", buf.length, "bytes");
