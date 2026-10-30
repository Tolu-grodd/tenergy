// Finds a plug on the local network without UDP broadcast (newer protocol 3.5 plugs don't answer the old broadcast search).
// It looks for machines listening on Tuya's local port, then tries the plug's key and each protocol version against them.
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import TuyAPI from "tuyapi";

const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms))]);

export function subnets() {
  if (process.env.LOCAL_SUBNET) return process.env.LOCAL_SUBNET.split(",").map((s) => s.trim()).filter(Boolean); // e.g. 192.168.18
  try {
    const out = new Set();
    for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(i.address)) out.add(i.address.split(".").slice(0, 3).join("."));
    return [...out];
  } catch { return []; } // some Android setups block this; set LOCAL_SUBNET in .env instead
}

const probePort = (host, port = 6668) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: 900 });
  s.on("connect", () => { s.destroy(); res(host); }); s.on("timeout", () => { s.destroy(); res(null); }); s.on("error", () => res(null));
});
let scanCache = { at: 0, hosts: [] };
export async function openHosts(maxAgeMs = 30_000) {
  if (Date.now() - scanCache.at < maxAgeMs) return scanCache.hosts;
  const found = [];
  for (const sn of subnets()) {
    const ips = Array.from({ length: 254 }, (_, i) => `${sn}.${i + 1}`);
    for (let i = 0; i < ips.length; i += 64) (await Promise.all(ips.slice(i, i + 64).map((ip) => probePort(ip)))).forEach((r) => r && found.push(r));
  }
  scanCache = { at: Date.now(), hosts: found };
  return found;
}

// Tries this device's key on one host across protocol versions. Returns { version } or null.
export async function matchAt(ip, device, versions = ["3.5", "3.4", "3.3", "3.1"]) {
  for (const version of versions) {
    const dev = new TuyAPI({ id: device.id, key: device.key, ip, version, issueGetOnConnect: false });
    dev.on("error", () => {});
    try { await within(dev.connect(), 5000, "connect"); await within(dev.get({ schema: true }), 5000, "read"); try { dev.disconnect(); } catch {} return { version }; }
    catch { try { dev.disconnect(); } catch {} }
  }
  return null;
}

// Where to look: a remembered address first, then every host with the Tuya port open that no other plug is using.
// Searches run one at a time: these plugs only accept a couple of connections, and a probe with the wrong key can knock off a live one.
let queue = Promise.resolve();
export function locate(device, taken = new Set()) {
  const job = () => locateNow(device, taken);
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}
async function locateNow(device, takenArg) {
  const taken = () => (typeof takenArg === "function" ? takenArg() : takenArg);
  if (device.ip && device.version) return { ip: device.ip, version: device.version };
  if (device.ip && !taken().has(device.ip)) { const m = await matchAt(device.ip, device); if (m) return { ip: device.ip, version: m.version }; }
  for (const ip of await openHosts()) {
    if (taken().has(ip)) continue;
    const m = await matchAt(ip, device);
    if (m) return { ip, version: m.version };
  }
  throw new Error(subnets().length ? "not found on the local network" : "can't tell which network to scan (set LOCAL_SUBNET=192.168.x in .env)");
}

// Remember where each plug was found, so a restart doesn't need a full scan.
const cacheFile = new URL("./data/local-cache.json", import.meta.url);
export const loadCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { return {}; } };
export const saveCache = (c) => { try { fs.mkdirSync(new URL("./data/", import.meta.url), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(c)); } catch {} };
