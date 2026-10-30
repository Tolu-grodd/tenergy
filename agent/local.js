// Reads the Tuya plugs directly over the home Wi-Fi (no cloud, no API quota) and keeps the latest values in memory.
// Read-only: this never switches anything. Switching still goes through the cloud.
import TuyAPI from "tuyapi";
import { locate, loadCache, saveCache } from "./discover.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Data-point numbers used by standard Tuya energy plugs (confirmed on your fridge plug). Override per device in devices.json with a "dps" object.
const DEFAULT_DPS = { on: "1", kwh: "17", amps: "18", watts: "19", volts: "20" };

export function startLocal(devices, { pollSec = 5, log = console.log } = {}) {
  const live = new Map(); // id -> { dps, at }
  const lastSeen = new Map(), startedAt = Date.now(); // id -> { at, w }: the last reading we ever got, kept after the connection is lost
  const names = Object.fromEntries(devices.map((d) => [d.id, d.name.trim()]));
  const cache = loadCache();
  for (const d of devices) if (cache[d.id] && !d.ip) { d.ip = cache[d.id].ip; d.version = cache[d.id].version; }

  async function run(d) {
    let delay = 2000;
    for (;;) {
      let dev, timer;
      try {
        if (!d.ip || !d.version) {
          Object.assign(d, await locate(d, () => new Set(devices.filter((x) => x !== d && x.ip).map((x) => x.ip))));
          log(`${names[d.id]}: found at ${d.ip} (protocol ${d.version})`);
          cache[d.id] = { ip: d.ip, version: d.version }; saveCache(cache);
        }
        dev = new TuyAPI({ id: d.id, key: d.key, ip: d.ip, version: d.version, issueGetOnConnect: false });
        const apply = (dps) => { if (dps) { live.set(d.id, { dps: { ...(live.get(d.id)?.dps ?? {}), ...dps }, at: Date.now() }); const all = live.get(d.id).dps, wk = { ...DEFAULT_DPS, ...(d.dps ?? {}) }.watts; lastSeen.set(d.id, { at: Date.now(), w: all[wk] == null ? null : Number(all[wk]) / 10 }); } };
        dev.on("data", (data) => apply(data?.dps));
        dev.on("error", () => {}); // from the start: a timeout while connecting must not crash the agent (connect() rejects separately)
        // a plug that was given a different address after a router restart ignores a connection made with the wrong key, so connect() would hang forever: treat that as a failure and search again
        await Promise.race([dev.connect(), sleep(15_000).then(() => { throw new Error("connection timed out"); })]);
        log(`${names[d.id]}: connected locally`);
        delay = 2000;
        await new Promise((resolve) => {
          dev.on("disconnected", resolve); dev.on("error", () => {});
          const poll = async () => { try { apply((await dev.get({ schema: true }))?.dps); } catch (e) { log(`${names[d.id]}: read failed (${e.message})`); resolve(); } };
          poll(); timer = setInterval(poll, pollSec * 1000);
        });
      } catch (e) {
        log(`${names[d.id]}: ${e.message}`);
        if (/not found|timed out|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/i.test(e.message)) { d.ip = undefined; d.version = undefined; delete cache[d.id]; } // it may have a new address: search again
      } finally { clearInterval(timer); try { dev?.disconnect(); } catch {} }
      live.delete(d.id);
      await sleep(delay); delay = Math.min(delay * 2, 60_000);
    }
  }
  for (const d of devices.filter((x) => x.key)) run(d);

  return {
    // Latest reading per device, only if it is fresh.
    snapshot(maxAgeMs = 30_000) {
      const out = [];
      for (const d of devices) {
        const l = live.get(d.id);
        if (!l || Date.now() - l.at > maxAgeMs) {
          // No fresh reading. After a short grace period say so, so the app shows the plug as offline at once instead of waiting for Tuya's cloud (which keeps calling a dead plug "online" for minutes).
          const seen = lastSeen.get(d.id);
          if (Date.now() - startedAt > 45_000 && Date.now() - (seen?.at ?? startedAt) > 25_000) out.push({ id: d.id, unreachable: true, lastSeenAt: seen?.at ?? null, lastWatts: seen?.w ?? null });
          continue;
        }
        const m = { ...DEFAULT_DPS, ...(d.dps ?? {}) }, v = (k) => (l.dps[m[k]] == null ? null : Number(l.dps[m[k]]));
        out.push({ id: d.id, on: typeof l.dps[m.on] === "boolean" ? l.dps[m.on] : null, watts: v("watts") == null ? null : v("watts") / 10, volts: v("volts") == null ? null : v("volts") / 10, amps: v("amps") == null ? null : v("amps") / 1000, kwh: v("kwh") == null ? null : v("kwh") / 1000 });
      }
      return out;
    },
  };
}
