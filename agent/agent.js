// Tenergy home agent. Runs on any always-on machine on the home Wi-Fi (an old Android phone in Termux, a Raspberry Pi, a PC).
// It only makes outbound requests; nothing is exposed. It does three optional jobs, and Tenergy keeps working without it:
//   1. live readings from the plugs over the local network (fast, and uses none of the Tuya cloud quota)
//   2. the battery camera: a photo of the tank's display every few minutes
//   3. router health for the Router tab
import { fileURLToPath } from "node:url";
import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import { startRouterMonitor, findGateway } from "./router.js";
import { createZte } from "./zte.js";
import { createOdu } from "./odu.js";
import { startLocal } from "./local.js";
import { takePhotoSet, takeSnap, cameraCommand, viewCommand, meanDiff } from "./camera.js";
import { GRID_LIGHT_THRESHOLD } from "./segments.js";

const env = process.env;
const BASE = (env.WORKER_URL || (env.INGEST_URL ?? "").replace(/\/api\/router\/?$/, "")).replace(/\/$/, "");
const KEY = env.INGEST_KEY;
if (!BASE || !KEY) throw new Error("Set WORKER_URL and INGEST_KEY in agent/.env");
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF_THRESHOLD = Number(env.CAMERA_DIFF ?? 6); // mean brightness change (0-255) that counts as "the picture changed"
const HEARTBEAT_MIN = 60; // upload at least this often even if nothing changed

async function send(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "x-ingest-key": KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

/* ---------- camera test: take one photo and show what it looks like (no upload) ---------- */
if (process.argv.includes("--test-camera")) {
  const p = await takePhotoSet();
  fs.writeFileSync("last-photo-1.jpg", Buffer.from(await p.encode(), "base64"));
  console.log(`Took ${p.photos.length} photos with: ${cameraCommand()}
Readings: ${p.photos.map((x) => x.value ?? x.note).join(" / ")}
Saved the middle one as last-photo-1.jpg. ${p.timing}`);
  process.exit(0);
}

const dataDir = fileURLToPath(new URL("./data", import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });

/* ---------- 1. live plug readings ---------- */
let devices = [];
try { devices = JSON.parse(fs.readFileSync(new URL("./devices.json", import.meta.url), "utf8")).filter((d) => d.key); } catch {}
const local = devices.length ? startLocal(devices, { pollSec: Number(env.LOCAL_POLL_SEC ?? 5), log }) : null;
if (!local) log("No agent/devices.json, so no live plug readings (run: npm run local-keys). Tenergy will keep using the Tuya cloud.");

/* ---------- 3. router health ---------- */
const snapshot = startRouterMonitor(dataDir);
const zte = createZte({ ip: env.ROUTER_IP || (await findGateway().catch(() => null)) || "192.168.1.1", password: env.ROUTER_PASSWORD || "" });
zte.poll(); setInterval(zte.poll, 20_000);
// the outdoor unit (ODU) behind the router carries the mobile signal: set ODU_IP and ODU_PASSWORD in .env to include it
const odu = env.ODU_IP ? createOdu({ ip: env.ODU_IP, password: env.ODU_PASSWORD || "" }) : null;
if (odu) { odu.poll(); setInterval(odu.poll, 30_000); }
// The router's client table keeps a device after it has left, so each device is pinged from here and marked alive or not (with when it last answered).
const seenAt = new Map();
const ping = (ip) => new Promise((res) => execFile("ping", ["-c", "1", "-W", "1", ip], { timeout: 4000 }, (err) => res(!err)));
async function probeDevices(devs) {
  const out = await Promise.all(devs.map(async (d) => {
    const key = d.mac || d.ip; let alive = d.ip ? await ping(d.ip) : null;
    if (alive === false) alive = await ping(d.ip); // one more try: a sleeping phone can miss the first
    if (alive) seenAt.set(key, Date.now());
    return { ...d, alive, lastSeenAt: seenAt.get(key) ?? null };
  }));
  return out;
}
setInterval(async () => {
  const { raw, ...z0 } = zte.snapshot(), o = odu?.snapshot();
  const z = o?.ok ? { ...z0, ...o.fields, modem: "ok", connected: true, ok: true, configured: true, odu: true } : o?.configured ? { ...z0, oduError: o.error } : z0; // signal and usage come from the outdoor unit when it can be read
  try { if (z.devices?.length) z.devices = await probeDevices(z.devices); } catch (e) { log("device check failed:", e.message); }
  try { await send("/api/router", { ...snapshot(), zte: z }); } catch (e) { log("router report failed:", e.message); }
}, 30_000);

/* ---------- the shared loop: report readings, pick up settings from the Worker ---------- */
const cfg = { liveSec: 10, photoEveryMin: 10, photoNowAt: 0, snapNowAt: 0 };
let readFails = 0, lastUploadedVal = null, lastBatt = null, pendingBatt = null, handledSnapNow = 0, snapBusy = false, handledPhotoNow = 0, lastPhotoAt = 0, lastUploadAt = 0, lastSig = null, photoBusy = false;

// the camera server (the IP Webcam app on this phone): is it answering, and which camera is it on? Checked once a minute and reported with the readings.
const CAMERA_URL = (env.CAMERA_SERVER_URL || "http://localhost:8080").replace(/\/$/, "");
let cameraNow = null, cameraSentAt = 0, lastShotAt = 0;
async function checkCamera() {
  if (!cameraCommand() && !viewCommand()) return;
  try { const j = await (await fetch(CAMERA_URL + "/status.json", { signal: AbortSignal.timeout(6_000) })).json(); cameraNow = { ok: true, front: j.curvals?.ffc === "on", torch: j.curvals?.torch === "on", at: Date.now() }; }
  catch { cameraNow = { ok: false, front: false, torch: false, at: Date.now() }; }
}
checkCamera(); setInterval(checkCamera, 60_000);

// the phone's own battery (Termux:API), read once a minute, so the app can warn before the phone runs flat
let phoneNow = null, phoneSentAt = 0, phoneWarned = false;
function readPhone() {
  exec("termux-battery-status", { timeout: 20_000 }, (err, out) => {
    if (err) { if (!phoneWarned) { phoneWarned = true; log("phone battery not available (is the Termux:API app installed?)"); } return; }
    try { const j = JSON.parse(out); phoneNow = { percent: j.percentage, status: j.status, plugged: j.plugged, temp: j.temperature, health: j.health, at: Date.now() }; } catch {}
  });
}
readPhone(); setInterval(readPhone, 60_000);

async function report() {
  try {
    const readings = local ? local.snapshot() : [];
    const body = { devices: readings }; if (phoneNow && phoneNow.at > phoneSentAt) { body.phone = phoneNow; phoneSentAt = phoneNow.at; }
    if (cameraNow && cameraNow.at > cameraSentAt) { body.camera = { ...cameraNow, lastShotAt }; cameraSentAt = cameraNow.at; }
    const r = await send("/api/readings", body);
    if (r.batteryPct != null) lastBatt = r.batteryPct; // the jump guard always compares with the number the app shows, so a bad value can never become the baseline
    Object.assign(cfg, { liveSec: r.liveSec ?? cfg.liveSec, photoEveryMin: r.photoEveryMin ?? cfg.photoEveryMin, photoNowAt: r.photoNowAt ?? 0, snapNowAt: r.snapNowAt ?? 0 });
    if (report.last !== readings.length) { report.last = readings.length; log(`Reporting to ${BASE}: ${readings.length} live device(s)${readings.length ? ", " + readings.map((x) => `${Math.round(x.watts ?? 0)} W`).join(", ") : ""}`); }
  } catch (e) { log("report failed:", e.message); }
  setTimeout(report, cfg.liveSec * 1000);
}
report();

/* ---------- 2. battery camera ---------- */
async function photo(force) {
  if (photoBusy || snapBusy) return; photoBusy = true; // one camera: never overlap with a home-view picture
  try {
    const p = await takePhotoSet(), diff = meanDiff(p.sig, lastSig), stale = Date.now() - lastUploadAt > HEARTBEAT_MIN * 60e3;
    lastPhotoAt = Date.now(); lastShotAt = lastPhotoAt;
    // the free reader: the number most of the photos agree on (more than half), sent on every check, whether or not the picture itself is uploaded
    // the grid light on the socket: lit or not, by the middle score of the photos
    const scores = p.photos.map((x) => x.grid?.score).filter((v) => v != null).sort((a, b) => a - b);
    if (scores.length >= 2) {
      const score = scores[Math.floor(scores.length / 2)], on = score >= GRID_LIGHT_THRESHOLD;
      try { await send("/api/grid/light", { on, score, count: scores.length }); log(`grid light: ${on ? "ON" : "OFF"} (score ${score})`); } catch (e) { log("grid light not sent:", e.message); }
    }
    const readable = p.photos.filter((x) => !x.blank), vals = readable.map((x) => x.value).filter((v) => v != null), tally = new Map(); for (const v of vals) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [topVal, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0], agreed = topVal != null && topN >= 2 && topN > readable.length / 2; // at least two readable frames must agree (blank frames don't vote)
    if (agreed) {
      // a big jump from the last reading is held back until the next check says the same, so a one-off misread never reaches the app
      if (lastBatt != null && Math.abs(topVal - lastBatt) > 10 && !(pendingBatt != null && Math.abs(topVal - pendingBatt) <= 2)) { pendingBatt = topVal; log(`battery ${topVal}% looks like a jump from ${lastBatt}%, waiting for the next check to confirm`); }
      else try { await send("/api/battery/reading", { percent: topVal, count: topN, total: readable.length, charging: p.charging }); lastBatt = topVal; pendingBatt = null; log(`battery ${topVal}% (${topN} of ${readable.length} readable frames agree${p.charging ? ", charging" : ""}) | ${p.timing}`); } catch (e) { log("reading not sent:", e.message); }
      readFails = 0;
    } else {
      log(`battery: could not read it (${p.photos.map((x) => x.value ?? (x.blank ? "blank" : x.note)).join(" / ")}) | ${p.timing}`);
      if (++readFails <= 3) lastPhotoAt = Date.now() - cfg.photoEveryMin * 60e3 + 30_000; // try again in 30 seconds, up to 3 times, instead of waiting a whole cycle
    }
    const newValue = agreed && topVal !== lastUploadedVal; // the number changed: send the picture too, so the photo in the app always matches the reading
    if (!(force || newValue || diff > DIFF_THRESHOLD || stale)) { log(`photo: unchanged (difference ${diff.toFixed(1)}), not uploaded`); return; }
    const b64 = await p.encode(); // only now: encoding the picture is the slow part
    const r = await send("/api/battery/photo", { photos: [b64], force, reading: { percent: agreed ? topVal : null, count: topN, total: readable.length, note: p.photos.map((x) => x.value ?? (x.blank ? "blank" : x.note)).join(" / ") } });
    lastSig = p.sig; lastUploadAt = Date.now(); if (agreed) lastUploadedVal = topVal;
    log(`photo uploaded (${Math.round(b64.length * 0.75 / 1024)} KB)${r.error ? " - " + r.error : ""}`);
  } catch (e) { log("photo failed:", e.message); lastPhotoAt = Date.now() - cfg.photoEveryMin * 60e3 + 60_000; } // the camera server is not answering: try again in a minute, not every second
  finally { photoBusy = false; }
}
if (cameraCommand()) {
  log(`Camera on: a photo every ${cfg.photoEveryMin} min (${cameraCommand()})`);
  setInterval(() => {
    const now = Date.now(), requested = cfg.photoNowAt > handledPhotoNow;
    if (requested) { if (!photoBusy && !snapBusy) { handledPhotoNow = cfg.photoNowAt; photo(true); } } // a press that arrives during another check waits for it, instead of being lost
    else if (now - lastPhotoAt >= cfg.photoEveryMin * 60e3) photo(false);
  }, 1_000);
} else log("No camera command, so the battery camera is off (set CAMERA_CMD, or run in Termux with the Termux:API app).");

/* ---------- 4. home view: a picture from the selfie camera, only when asked for in the app ---------- */
if (viewCommand()) {
  handledSnapNow = Date.now(); // ignore requests made before this start
  setInterval(async () => {
    if (snapBusy || photoBusy || cfg.snapNowAt <= handledSnapNow) return;
    handledSnapNow = cfg.snapNowAt; snapBusy = true;
    try { const s = await takeSnap(); lastShotAt = Date.now(); await send("/api/view/snap", { b64: s.b64 }); log(`home view picture uploaded (${Math.round(s.bytes / 1024)} KB) | ${s.timing}`); }
    catch (e) { log("home view failed:", e.message); }
    finally { snapBusy = false; }
  }, 1_000);
}

/* ---------- listening for "Read now" / "Look now": one request is kept open, and the Worker answers the moment a button is pressed ---------- */
(async function listen() {
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/agent/wait?snap=${cfg.snapNowAt}&photo=${cfg.photoNowAt}`, { headers: { "x-ingest-key": KEY }, signal: AbortSignal.timeout(35_000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json(); if (j.changed) { cfg.snapNowAt = j.snapNowAt ?? cfg.snapNowAt; cfg.photoNowAt = j.photoNowAt ?? cfg.photoNowAt; }
    } catch { await sleep(5_000); }
  }
})();

process.on("unhandledRejection", (e) => log("unexpected:", e?.message ?? e));
process.on("uncaughtException", (e) => log("unexpected error, carrying on:", e?.message ?? e)); // one bad plug connection must never stop the agent
log("Agent running.");
