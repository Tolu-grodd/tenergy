// Takes photos of the power tank's display, shrinks them, and says whether the scene changed since the last upload.
// On Android (Termux with the Termux:API app) the default command is termux-camera-photo. Elsewhere set CAMERA_CMD in .env,
// using {file} for where the picture should be written, e.g.  CAMERA_CMD=node test-image.js {file}
//
// One session = light on, wait, a throwaway "warm-up" shot, then several real photos a moment apart, light off.
// The Worker reads every real photo and uses the percentage most of them agree on.
//   CAMERA_CMD       the camera command. On this phone camera 0 is the back camera (the one with the flash); 1 is the selfie camera
//   CAMERA_BEFORE    run first, e.g. turn the light on:          termux-torch on
//   CAMERA_WAIT_SEC  seconds to wait after that, and after the warm-up shot, so focus and exposure settle (default 0)
//   CAMERA_WARMUP    throwaway shots taken first (default 1): the first picture is often soft or dark
//   CAMERA_VOTES     real photos to keep and read (default 3, max 5)
//   CAMERA_VOTE_GAP_SEC  seconds between the real photos (default 1)
//   CAMERA_AFTER     always run at the end, e.g. light off:        termux-torch off
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { readDisplayAuto, readGridLight } from "./segments.js";

const run = promisify(exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTermux = Boolean(process.env.PREFIX?.includes("com.termux"));
const sh = (cmd) => run(cmd, { timeout: 40_000 });
const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export function cameraCommand() {
  const c = process.env.CAMERA_CMD;
  if (c === "off") return ""; // the phone's own automation app does the photos instead (see AGENT_SETUP.md)
  return c || (isTermux ? "termux-camera-photo -c 0 {file}" : "");
}

// CAMERA_ROTATE=270 (or 90, 180) turns every picture upright, e.g. when the phone is mounted upright but its sensor is landscape.
// VIEW_ROTATE does the same for the home-view camera and defaults to CAMERA_ROTATE.
const turn = (img, deg = num(process.env.CAMERA_ROTATE, 0)) => { if (deg % 360) img.rotate(deg % 360); };

const signature = (img) => { // a tiny 32x24 greyscale copy, enough to tell "same scene" from "something changed"
  const d = img.clone().resize({ w: 32, h: 24 }).greyscale().bitmap.data, out = new Uint8Array(32 * 24);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
};
export const meanDiff = (a, b) => (a && b ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length : 255);

// Home view: one picture from the selfie camera, on request. Same light handling as the battery camera unless overridden.
//   CAMERA_VIEW_CMD  default: termux-camera-photo -c 1 {file}    VIEW_BEFORE / VIEW_AFTER  default to CAMERA_BEFORE / CAMERA_AFTER
// A dark corridor comes out almost black, so lift it: pick a gamma that brings the average brightness up to about 100 (0-255). Only for home-view pictures.
export function brighten(img, target = 100) {
  const d = img.bitmap.data; let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 64) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  const mean = Math.max(1, sum / Math.max(1, n)); if (mean >= target) return mean;
  const gamma = Math.min(1, Math.max(0.35, Math.log(target / 255) / Math.log(mean / 255)));
  const lut = new Uint8Array(256); for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(255 * Math.pow(v / 255, gamma)));
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  return mean;
}
export const viewCommand = () => process.env.CAMERA_VIEW_CMD === "off" ? "" : process.env.CAMERA_VIEW_CMD || (isTermux ? "termux-camera-photo -c 1 {file}" : "");
export async function takeSnap() {
  const cmd = viewCommand(); if (!cmd) throw new Error("no view camera command");
  const before = process.env.VIEW_BEFORE ?? process.env.CAMERA_BEFORE, after = process.env.VIEW_AFTER ?? process.env.CAMERA_AFTER, wait = num(process.env.CAMERA_WAIT_SEC, 0);
  const file = path.join(os.tmpdir(), `tenergy-view-${Date.now()}.jpg`), T = { t0: Date.now() };
  try {
    if (before) await sh(before);
    T.before = Date.now();
    if (wait > 0) await sleep(wait * 1000);
    T.warm = Date.now();
    await sh(cmd.replaceAll("{file}", `"${file}"`)); // one shot: the torch has had the settle time above
    T.shot = Date.now();
  } finally { if (after) await sh(after).catch(() => {}); T.after = Date.now(); }
  const img = await Jimp.read(file); if (img.bitmap.width > 1280) img.resize({ w: 1280 }); turn(img, num(process.env.VIEW_ROTATE, num(process.env.CAMERA_ROTATE, 0))); if (process.env.VIEW_BRIGHTEN !== "off") brighten(img); if (img.bitmap.width > 1280) img.resize({ w: 1280 });
  const buf = await img.getBuffer("image/jpeg", { quality: 72 }); fs.rmSync(file, { force: true });
  T.done = Date.now(); const s = (a, b) => ((b - a) / 1000).toFixed(1) + "s";
  return { b64: buf.toString("base64"), bytes: buf.length, timing: `torch+camera ${s(T.t0, T.before)}, settle ${s(T.before, T.warm)}, shot ${s(T.warm, T.shot)}, switch back ${s(T.shot, T.after)}, process ${s(T.after, T.done)}` };
}

// One check of the tank. Frames are taken one at a time and read straight away, until there are enough READABLE ones (CAMERA_VOTES, default 3) or CAMERA_SHOTS (default 8) have been taken.
// While the tank charges it blinks the number, so some frames show only the % sign: those are "blank", are skipped, and (mixed with readable ones) tell us it is charging.
// The socket light is read from every frame, blank or not, because it does not blink.
// Returns { photos: [{ value, note, blank, grid }], sig, encode(), charging, timing }.
export async function takePhotoSet() {
  const cmd = cameraCommand(); if (!cmd) throw new Error("no camera command (set CAMERA_CMD in .env)");
  const { CAMERA_BEFORE: before, CAMERA_AFTER: after } = process.env;
  const wait = num(process.env.CAMERA_WAIT_SEC, 0), votes = Math.max(1, Math.min(5, num(process.env.CAMERA_VOTES, 3)));
  const maxShots = Math.max(votes, Math.min(12, num(process.env.CAMERA_SHOTS, 8))), gap = num(process.env.CAMERA_VOTE_GAP_SEC, 0.4);
  const stamp = Date.now(), file = (i) => path.join(os.tmpdir(), `tenergy-${stamp}-${i}.jpg`), T = { t0: stamp }, photos = [];
  let readable = 0, blanks = 0, sig = null, mid = null, lastImg = null;
  try {
    if (before) await sh(before);
    T.before = Date.now(); if (before && wait > 0) await sleep(wait * 1000);
    for (let i = 0; i < maxShots && readable < votes; i++) {
      if (i > 0 && gap > 0) await sleep(gap * 1000);
      await sh(cmd.replaceAll("{file}", `"${file(i)}"`));
      const img = await Jimp.read(file(i)); fs.rmSync(file(i), { force: true }); turn(img);
      let read = { value: null, note: "reader failed" }; try { read = readDisplayAuto(img); } catch (e) { read.note = e.message; }
      let grid = null; if (read.panel?.ring) { try { grid = readGridLight(read.image ?? img, read.panel); } catch {} } // needs only the panel, not the digits
      photos.push({ value: read.value, note: read.note, blank: Boolean(read.blank), grid });
      if (read.blank) blanks++; else if (read.value != null) { readable++; if (readable === Math.ceil(votes / 2)) { if (img.bitmap.width > 1280) img.resize({ w: 1280 }); mid = img; sig = signature(img); } }
      lastImg = img;
    }
    T.shots = Date.now();
  } finally { if (after) await sh(after).catch(() => {}); T.after = Date.now(); } // never leave the light on if a shot fails
  if (!mid) { mid = lastImg; if (mid && mid.bitmap.width > 1280) mid.resize({ w: 1280 }); if (mid) sig = signature(mid); } // nothing readable: keep the last frame, so there is a picture to look at
  const charging = blanks > 0 && readable > 0 ? true : null; // a number that blinks = charging. A steady number proves nothing (the tank doesn't always blink), so that is 'unknown', never 'not charging'
  T.done = Date.now(); const s = (a, b) => ((b - a) / 1000).toFixed(1) + "s";
  // encoding the picture is slow on a phone, so it only happens when the picture is really going to be uploaded
  const encode = async () => (await mid.getBuffer("image/jpeg", { quality: 68 })).toString("base64");
  return { photos, sig, encode, charging, timing: `${photos.length} frames (${readable} readable, ${blanks} blank) in ${s(T.before, T.done)}, total ${s(T.t0, T.done)}` };
}
