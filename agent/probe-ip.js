// Read-only: tries each known device key and protocol version against one IP address and prints what happens.
// Use when local-test.js can't find a plug by broadcast:   node probe-ip.js 192.168.18.2
import fs from "node:fs";
import net from "node:net";
import TuyAPI from "tuyapi";

const ip = process.argv[2]; if (!ip) { console.log("Usage: node probe-ip.js <ip address>"); process.exit(1); }
const devices = JSON.parse(fs.readFileSync(new URL("./devices.json", import.meta.url), "utf8")).filter((d) => d.key);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms))]);

// 1. is anything listening?
const open = await new Promise((res) => { const s = net.connect({ host: ip, port: 6668, timeout: 2500 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("timeout", () => { s.destroy(); res(false); }); s.on("error", () => res(false)); });
console.log(`${ip}: port 6668 (Tuya local control) is ${open ? "OPEN" : "CLOSED or filtered"}`);
if (!open) process.exit(0);

// 2. does one of our devices answer with its key, on some protocol version?
for (const d of devices) for (const version of ["3.3", "3.4", "3.5", "3.1"]) {
  const dev = new TuyAPI({ id: d.id, key: d.key, ip, version, issueGetOnConnect: false });
  let sockErr = ""; dev.on("error", (e) => { sockErr = e.message ?? String(e); });
  try {
    await within(dev.connect(), 6000, "connect");
    const r = await within(dev.get({ schema: true }), 6000, "read");
    console.log(`MATCH  ${d.name.trim()}  protocol ${version}\n   dps: ${JSON.stringify(r.dps ?? r)}`);
    try { dev.disconnect(); } catch {}
    process.exit(0);
  } catch (e) { console.log(`  ${d.name.trim().padEnd(18)} v${version}: ${e.message}${sockErr && sockErr !== e.message ? "  (" + sockErr + ")" : ""}`); try { dev.disconnect(); } catch {} }
}
console.log("\nNo key + protocol combination worked.");
process.exit(0);
