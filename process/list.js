// Lists your Tuya devices with live readings and online state. Run: npm run devices
import crypto from "node:crypto";

const { TUYA_ACCESS_ID: id, TUYA_ACCESS_SECRET: secret, TUYA_BASE_URL: base } = process.env;
if (!id || !secret || !base) throw new Error("Missing TUYA_* values in .env (see .env.example)");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", secret).update(s).digest("hex").toUpperCase();
let token = "";

async function call(path) {
  const t = Date.now().toString(), isToken = path.startsWith("/v1.0/token");
  const sign = hmac(id + (isToken ? "" : token) + t + ["GET", sha256(""), "", path].join("\n"));
  const headers = { client_id: id, sign, t, sign_method: "HMAC-SHA256", ...(isToken ? {} : { access_token: token }) };
  const j = await (await fetch(base + path, { headers })).json();
  if (!j.success) throw new Error(`${path}: ${j.code} ${j.msg}`);
  return j.result;
}

token = (await call("/v1.0/token?grant_type=1")).access_token;
const devices = (await call("/v1.0/iot-01/associated-users/devices?size=50")).devices ?? [];
console.log(`Found ${devices.length} device(s)\n`);
for (const d of devices) {
  const v = Object.fromEntries((await call(`/v1.0/devices/${d.id}/status`)).map((s) => [s.code, s.value]));
  const w = v.cur_power != null ? `${v.cur_power / 10} W  ${v.cur_voltage / 10} V  ${v.cur_current / 1000} A` : "(no power data)";
  console.log(`${d.name}  [${d.id}]  online=${d.online}  last update ${d.update_time ? new Date(d.update_time * 1000).toLocaleString() : "?"}`);
  console.log(`  on=${v.switch_1 ?? v.switch_led}  ${w}\n`);
}
