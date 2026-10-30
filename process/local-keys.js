// Fetches the local key of every device on your Tuya account and writes agent/devices.json,
// which the home agent needs to talk to the plugs directly over your Wi-Fi. Run: npm run local-keys
// The file holds secrets (git-ignored). Copy it next to the agent on the phone.
import crypto from "node:crypto";
import fs from "node:fs";

const { TUYA_ACCESS_ID: id, TUYA_ACCESS_SECRET: secret, TUYA_BASE_URL: base } = process.env;
if (!id || !secret || !base) throw new Error("Missing TUYA_* values in .env (see .env.example)");
const clean = (s) => String(s).replace(/[^\x20-\x7E]/g, "").trim();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", clean(secret)).update(s).digest("hex").toUpperCase();
let token = "";

async function call(path) {
  const t = Date.now().toString(), isToken = path.startsWith("/v1.0/token");
  const sign = hmac(clean(id) + (isToken ? "" : token) + t + ["GET", sha256(""), "", path].join("\n"));
  const headers = { client_id: clean(id), sign, t, sign_method: "HMAC-SHA256", ...(isToken ? {} : { access_token: token }) };
  const j = await (await fetch(base + path, { headers })).json();
  if (!j.success) throw new Error(`${path}: ${j.code} ${j.msg}`);
  return j.result;
}

token = (await call("/v1.0/token?grant_type=1")).access_token;
const list = (await call("/v1.0/iot-01/associated-users/devices?size=100")).devices ?? [];
const out = [];
for (const d of list) {
  const info = await call(`/v1.0/devices/${d.id}`);
  out.push({ id: d.id, name: d.name, category: d.category ?? null, key: info.local_key ?? null });
  console.log(`${d.name.padEnd(24)} ${d.id}  local key: ${info.local_key ? "yes" : "MISSING"}`);
}
fs.writeFileSync(new URL("../agent/devices.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`\nWrote agent/devices.json with ${out.length} device(s).`);
