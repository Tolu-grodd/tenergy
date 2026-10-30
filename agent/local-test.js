// Read-only check: finds each plug on the local network and prints its protocol version and data points.
// Run from the agent folder:  node local-test.js        (nothing here switches anything)
import fs from "node:fs";
import TuyAPI from "tuyapi";
import { locate, subnets, openHosts } from "./discover.js";

const devices = JSON.parse(fs.readFileSync(new URL("./devices.json", import.meta.url), "utf8")).filter((d) => d.key);
const only = process.argv[2]; // optional: part of a name or id
console.log(`Looking on: ${subnets().map((s) => s + ".x").join(", ") || "(no network found, set LOCAL_SUBNET=192.168.x in .env)"}`);
console.log(`Devices answering on the Tuya local port: ${(await openHosts()).join(", ") || "none"}`);

const taken = new Set();
for (const d of devices) {
  if (only && !(d.name + d.id).toLowerCase().includes(only.toLowerCase())) continue;
  console.log(`\n== ${d.name.trim()}`);
  try {
    const where = await locate({ ...d, ip: undefined, version: undefined }, taken); taken.add(where.ip);
    const dev = new TuyAPI({ id: d.id, key: d.key, ip: where.ip, version: where.version, issueGetOnConnect: false });
    dev.on("error", () => {}); await dev.connect();
    const dps = (await dev.get({ schema: true })).dps; try { dev.disconnect(); } catch {}
    const n = (k, s) => (dps[k] == null ? "?" : (dps[k] / s).toFixed(s === 1000 ? 3 : 1));
    console.log(`   ip ${where.ip}  protocol ${where.version}`);
    console.log(`   reading: ${n("19", 10)} W   ${n("20", 10)} V   ${n("18", 1000)} A   energy counter ${n("17", 1000)} kWh   switch ${dps["1"] ? "on" : "off"}`);
    console.log("   dps:", JSON.stringify(dps));
  } catch (e) { console.log(`   could not read locally: ${e.message}${/offline|not found/i.test(e.message) ? "  (is it switched on and on this Wi-Fi?)" : ""}`); }
}
process.exit(0);
