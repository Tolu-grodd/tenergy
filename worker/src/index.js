// Cloudflare Worker: the always-on piece. Calls Tuya (the secret never leaves here), records readings,
// runs schedules, and serves the dashboard. Firebase only hosts the page and signs you in.
// Devices are discovered from the Tuya account, so a switch added in Smart Life shows up here as "new".
// An optional home agent (an old phone or any always-on machine on the home Wi-Fi) adds live local readings,
// the battery camera and router health. Without it everything still works from Tuya's cloud.

import { voteReadings } from "./vote.js";
import { autoPlan, mergeAuto, cleanAuto, windowAt, nextAfter, phaseAnchor, forecastTank } from "./auto.js";
import { mergeAlerts, cleanAlerts, conditions, dailySummary, hm, weakNudgeText } from "./alerts.js";

const TZ = "Africa/Lagos";
const TZ_OFFSET = "+01:00"; // Lagos has no daylight saving
const GRACE_MIN = 60; // a failed scheduled action is retried every 2 min for this long, then abandoned for the day
const FRESH_MS = 10_000; // never hit Tuya more often than this, however many tabs are open
const LIVE_FRESH_MS = 120_000; // agent readings newer than this replace Tuya cloud polling
const ROLES = ["tank", "fridge", "grid", "appliance"];
const UNIQUE_ROLES = ["tank", "fridge", "grid"]; // only one device may hold each of these
const ICONS = ["plug", "bolt", "fridge", "bulb", "tv", "fan", "snow", "washer", "wifi", "drop", "flame", "laptop"];
const DEFAULT_SETTINGS = { limit: 500, warn: 350 };
const DEFAULT_AGENT = { photoEveryMin: 5, liveSec: 10, photoNowAt: 0, snapNowAt: 0 };
const SNAP_KEEP = 6; // home-view pictures kept (the selfie camera, on request only)
const SEED = [ // first-run devices; after that everything lives in the devices table
  { id: "bf0e619a1c9dfc9a9dlv5t", name: "Power Tank Output", role: "tank", icon: "bolt" },
  { id: "bfe07125814ad378b8ysi7", name: "Fridge", role: "fridge", icon: "fridge" },
];
const RUN_THRESHOLD_W = 5; // a fridge counts as running above this
const PHOTO_KEEP = 10; // tank photos kept; older ones are deleted as new ones arrive (the one behind the current reading is always kept)
const VISION_MODEL = "claude-haiku-4-5-20251001";
const VISION_MIN_GAP_MS = 4 * 60e3; // at most one automatic reading every 4 minutes
const VISION_DAILY_CAP = 300;
const enc = new TextEncoder();
const clean = (s) => String(s ?? "").replace(/[^\x20-\x7E]/g, "").trim(); // secrets set from Windows can carry a hidden BOM
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- storage ----------
const kvGet = async (env, k) => { const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first(); return r ? JSON.parse(r.v) : null; };
const kvSet = (env, k, v) => env.DB.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run();

const lagos = (d = new Date()) => { // Lagos is a fixed UTC+1, so this is plain arithmetic (Intl formatting costs real CPU time)
  const l = new Date(d.getTime() + 3600e3), date = l.toISOString().slice(0, 10);
  return { date, mins: l.getUTCHours() * 60 + l.getUTCMinutes(), dow: l.getUTCDay(), midnight: Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - 3600e3 };
};
const shiftDate = (date, n) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let seeded = false;
async function ensureSeed(env) {
  if (seeded) return;
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first();
  if (!c.n) await env.DB.batch(SEED.map((d, i) => env.DB.prepare("INSERT OR IGNORE INTO devices(id,name,role,icon,status,sort,added) VALUES(?,?,?,?,'active',?,?)").bind(d.id, d.name, d.role, d.icon, i, Date.now())));
  seeded = true;
}
const getDevices = async (env, status = "active") => (await env.DB.prepare("SELECT * FROM devices WHERE status=? ORDER BY sort, added").bind(status).all()).results;
const allDeviceIds = async (env) => new Set((await env.DB.prepare("SELECT id FROM devices").all()).results.map((r) => r.id));
async function getSettings(env) { return { ...DEFAULT_SETTINGS, ...((await kvGet(env, "settings")) ?? {}) }; }
async function getAgentCfg(env) { return { ...DEFAULT_AGENT, ...((await kvGet(env, "agent")) ?? {}) }; }
async function getSchedules(env) {
  let s = await kvGet(env, "schedules");
  if (!s) { // first run: carry over the old single fridge cutoff
    const old = (await kvGet(env, "schedule"))?.fridgeOff, fridge = (await getDevices(env)).find((d) => d.role === "fridge");
    s = fridge ? [{ id: "s-fridge-off", deviceId: fridge.id, action: "off", at: old?.at ?? "16:00", days: [0, 1, 2, 3, 4, 5, 6], enabled: old?.enabled ?? true }] : [];
    await kvSet(env, "schedules", s);
  }
  // The original fridge cutoff gets the grid check by default: skip it when the Grid supplied 60+ of the previous 120 minutes.
  if (s.some((x) => x.id === "s-fridge-off" && x.gridCheck === undefined)) {
    s = s.map((x) => (x.id === "s-fridge-off" && x.gridCheck === undefined ? { ...x, gridCheck: { enabled: true, windowMin: 120, minSupplyMin: 60 } } : x));
    await kvSet(env, "schedules", s);
  }
  return s;
}

// ---------- Tuya ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(secret, s) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(s))).toUpperCase();
}
let token = null, tokenExp = 0;
async function tuyaRaw(env, method, path, body = "", withToken = true) {
  const t = Date.now().toString(), stringToSign = [method, await sha256(body), "", path].join("\n"), clientId = clean(env.TUYA_ACCESS_ID);
  const sign = await hmac(clean(env.TUYA_ACCESS_SECRET), clientId + (withToken ? token : "") + t + stringToSign);
  const headers = { client_id: clientId, sign, t, sign_method: "HMAC-SHA256" };
  if (withToken) headers.access_token = token;
  if (body) headers["Content-Type"] = "application/json";
  return (await fetch(env.TUYA_BASE_URL + path, { method, headers, body: body || undefined })).json();
}
async function ensureToken(env) {
  if (token && Date.now() < tokenExp) return;
  const cached = await kvGet(env, "tuya_token");
  if (cached && Date.now() < cached.exp) { token = cached.token; tokenExp = cached.exp; return; }
  const j = await tuyaRaw(env, "GET", "/v1.0/token?grant_type=1", "", false);
  if (!j.success) throw new Error(`Tuya token failed: ${j.code} ${j.msg}`);
  token = j.result.access_token; tokenExp = Date.now() + (j.result.expire_time - 300) * 1000;
  await kvSet(env, "tuya_token", { token, exp: tokenExp });
}
// Tuya's free "IoT Core" trial refuses everything once its call quota is used up (error 28841004). Then the cloud is left alone for 45 minutes at a time, instead of failing on every call, and the
// phone carries on with state, switching and timers by itself (it talks to the plugs directly).
let cloudBlockUntil = 0, cloudBlockLoaded = false;
async function cloudBlocked(env) {
  if (!cloudBlockLoaded) { cloudBlockLoaded = true; cloudBlockUntil = ((await kvGet(env, "tuyaBlock")) ?? {}).until ?? 0; }
  return Date.now() < cloudBlockUntil;
}
async function tuya(env, method, path, body = "") {
  if (await cloudBlocked(env)) throw new Error("Tuya cloud paused: its quota is used up (error 28841004)");
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureToken(env);
    const j = await tuyaRaw(env, method, path, body);
    if (j.success) return j.result;
    if (attempt === 0 && (j.code === 1010 || j.code === 1011)) { token = null; tokenExp = 0; await kvSet(env, "tuya_token", { token: "", exp: 0 }); continue; }
    if (j.code === 28841004 || /quota/i.test(String(j.msg))) { cloudBlockUntil = Date.now() + 45 * 60e3; await kvSet(env, "tuyaBlock", { until: cloudBlockUntil, at: Date.now(), why: String(j.msg).slice(0, 120) }); }
    throw new Error(`Tuya ${path} failed: ${j.code} ${j.msg}`);
  }
}
function readings(status) {
  const v = Object.fromEntries(status.map((s) => [s.code, s.value]));
  const sw = ["switch_1", "switch", "switch_led"].find((c) => c in v) ?? null;
  return { on: sw ? v[sw] : null, sw, hasPower: v.cur_power != null, watts: v.cur_power != null ? v.cur_power / 10 : null, volts: v.cur_voltage != null ? v.cur_voltage / 10 : null, amps: v.cur_current != null ? v.cur_current / 1000 : null, kwh: v.add_ele != null ? v.add_ele / 1000 : null };
}
// The plug's own timer (it keeps running with no internet): when a rest starts, the plug is told to switch itself back on a little after the rest should end, so a lost connection can never leave the fridge off.
async function sendCountdown(env, id, sec) {
  const secs = Math.max(0, Math.round(sec)), cam = await kvGet(env, "camera"), hubBuild = Number(/build (\d+)/.exec(cam?.version ?? "")?.[1] ?? 0);
  // the phone sets the plug's own timer directly (data point 9); only a Hub that understands timer commands is sent one (an older build would misread it)
  if (hubBuild >= 3) await queueHubCmd(env, id, null, { countdown: secs }).catch(() => {});
  const phone = hubBuild >= 3 && (await localReady(env, id));
  try { await tuya(env, "POST", `/v1.0/devices/${id}/commands`, JSON.stringify({ commands: [{ code: "countdown_1", value: secs }] })); return { via: phone ? "phone and cloud" : "cloud" }; }
  catch (e) { if (phone) return { via: "phone" }; throw e; }
}
// The phone picks these up with its next report and switches the plug over the home Wi-Fi: quick, and it does not depend on Tuya's cloud, which can accept a command and never deliver it.
async function queueHubCmd(env, id, on, extra = {}) {
  const now = Date.now(), isTimer = "countdown" in extra, list = ((await kvGet(env, "hubCmds")) ?? []).filter((c) => now - c.at < 5 * 60e3 && !(c.id === id && ("countdown" in c) === isTimer));
  list.push(isTimer ? { id, at: now, ...extra } : { id, on: Boolean(on), at: now }); await kvSet(env, "hubCmds", list.slice(-10));
}
// Is the phone reading this plug over Wi-Fi right now? Then a command can go through the phone first.
async function localReady(env, id) {
  const live = await kvGet(env, "live"), d = live?.devices?.[id];
  return Boolean(live) && Date.now() - live.at < 40e3 && Boolean(d) && !d.unreachable;
}
// opts.local: try only the phone (quick, no cloud); the caller escalates to the cloud route if that did not work. Without it both routes are used.
async function sendSwitch(env, id, on, opts = {}) {
  await queueHubCmd(env, id, on).catch(() => {});
  const ready = await localReady(env, id), paused = await cloudBlocked(env);
  if (ready && (opts.local || paused)) return { via: "phone" };
  if (paused) throw new Error("the phone is not connected to that plug and Tuya's cloud is unavailable (quota used up)");
  const code = readings(await tuya(env, "GET", `/v1.0/devices/${id}/status`)).sw ?? "switch_1"; // bulbs use switch_led, plugs switch_1
  const r = await tuya(env, "POST", `/v1.0/devices/${id}/commands`, JSON.stringify({ commands: [{ code, value: on }] }));
  return { via: "cloud", r };
}
// Every device on the linked Smart Life account. This is how newly added switches are found.
async function refreshTuyaList(env) {
  const list = ((await tuya(env, "GET", "/v1.0/iot-01/associated-users/devices?size=100")).devices ?? [])
    .map((d) => ({ id: d.id, name: d.name, category: d.category ?? null, online: d.online, update_time: d.update_time ?? null }));
  await kvSet(env, "tuyaList", { at: Date.now(), list });
  return list;
}

// ---------- derived numbers ----------
// Energy, the day's peak and the fridge's duty cycle are running totals kept inside the saved state and updated on every poll (no database reads at all).
// Reading the day's samples on every poll used up the free database's daily read limit, so nothing here may scan the samples table per request.
const DUTY_BUCKET = 15 * 60e3, DUTY_KEEP = 24; // the last 6 hours, in 15-minute buckets
// For every interval, `last` is the reading that held during it: { w: watts or null, on: the switch's relay state or null }.
//   sw / swTot  = time the relay was ON / time its state was known  (the fridge counts as "on" whenever the relay is on, whatever the compressor does)
//   on / tot    = time the compressor drew power / time the relay was on and the power was known  (the compressor's duty cycle while the fridge is on)
function addDuty(agg, id, t, dt, last) {
  const k = Math.floor(t / DUTY_BUCKET), arr = (agg.duty[id] ??= []);
  let b = arr[arr.length - 1]; if (!b || b.k !== k) { b = { k, on: 0, tot: 0, sw: 0, swTot: 0 }; arr.push(b); while (arr.length > DUTY_KEEP) arr.shift(); }
  if (last.on != null) { b.swTot = (b.swTot ?? 0) + dt; if (last.on) b.sw = (b.sw ?? 0) + dt; }
  if (last.w != null && last.on !== false) { b.tot += dt; if (last.w > RUN_THRESHOLD_W) b.on += dt; }
}
async function updateAgg(env, old, plugs, now) {
  const L = lagos(), agg0 = old?.date === L.date ? old : null;
  if (agg0) { // normal case: add this interval to the totals
    agg0.swChange ??= {};
    for (const p of plugs) {
      const last = agg0.last[p.id];
      if (last && (last.w != null || last.on != null)) { const dt = Math.min(now - last.t, 6 * 60e3); if (dt > 0) { if (last.w != null) agg0.wh[p.id] = (agg0.wh[p.id] ?? 0) + (last.w * dt) / 3600e3; addDuty(agg0, p.id, now, dt, last); } }
      if (p.watts != null) agg0.peak[p.id] = Math.max(agg0.peak[p.id] ?? 0, p.watts);
      if (p.on != null) { const c = agg0.swChange[p.id]; if (!c) agg0.swChange[p.id] = { on: p.on, at: now, initial: true }; else if (c.on !== p.on) agg0.swChange[p.id] = { on: p.on, at: now }; } // when the relay last changed (the first sighting only says "since we started watching")
      agg0.last[p.id] = { t: now, w: p.watts ?? null, on: p.on ?? null };
    }
    return agg0;
  }
  // first poll of a new day (or first ever with this scheme): rebuild once from the recorded samples (they carry no relay state, so only the compressor part is rebuilt)
  const agg = { date: L.date, wh: {}, peak: {}, last: {}, duty: {}, swChange: old?.swChange ?? {} }, since = Math.min(L.midnight, now - 6 * 3600e3);
  const rows = (await env.DB.prepare("SELECT id,t,w FROM samples WHERE t>=? ORDER BY t").bind(since).all()).results, prev = {};
  for (const r of rows) {
    const p = prev[r.id];
    if (p && p.w != null) { const dt = Math.min(r.t - p.t, 6 * 60e3); if (dt > 0) { if (r.t >= L.midnight) agg.wh[r.id] = (agg.wh[r.id] ?? 0) + (p.w * dt) / 3600e3; addDuty(agg, r.id, r.t, dt, { w: p.w, on: null }); } }
    if (r.w != null && r.t >= L.midnight) agg.peak[r.id] = Math.max(agg.peak[r.id] ?? 0, r.w);
    prev[r.id] = r;
  }
  for (const p of plugs) {
    agg.last[p.id] = { t: now, w: p.watts ?? null, on: p.on ?? null }; if (p.watts != null) agg.peak[p.id] = Math.max(agg.peak[p.id] ?? 0, p.watts);
    if (p.on != null && !agg.swChange[p.id]) agg.swChange[p.id] = { on: p.on, at: now, initial: true };
  }
  return agg;
}
function totalsNow(devices, load, agg) {
  const tank = devices.find((d) => d.role === "tank"), fridge = devices.find((d) => d.role === "fridge"), kwh = (d) => (d ? Math.round(agg.wh[d.id] ?? 0) / 1000 : 0);
  const from = Math.floor((Date.now() - 6 * 3600e3) / DUTY_BUCKET), bs = fridge ? (agg.duty[fridge.id] ?? []).filter((b) => b.k >= from) : [];
  const sum = (key) => bs.reduce((a, b) => a + (b[key] ?? 0), 0), sw = sum("sw"), swTot = sum("swTot"), on = sum("on"), tot = sum("tot");
  const swPct = swTot < 5 * 60e3 ? null : Math.round((100 * sw) / swTot); // the fridge is "on" whenever its relay is on; known only since the relay state started being recorded
  return { load, peakToday: tank ? Math.round(agg.peak[tank.id] ?? 0) : 0, houseKwhToday: kwh(tank), fridgeKwhToday: kwh(fridge),
    fridgeSwOnPct6h: swPct, fridgeSwCoverMin: Math.round(Math.min(swTot, 6 * 3600e3) / 60000), fridgeCompressorPct6h: tot < 20 * 60e3 ? null : Math.round((100 * on) / tot), fridgeOnPct6h: swPct };
}

// ---------- poll (live agent data first, Tuya cloud for the rest), record, publish ----------
async function poll(env, { forceList = false } = {}) {
  const prev = (await kvGet(env, "state")) ?? {};
  try {
    await ensureSeed(env);
    const devs = await getDevices(env, "active"), now = Date.now();
    const live = await kvGet(env, "live"), liveFresh = Boolean(live) && now - live.at < LIVE_FRESH_MS;
    const lv = (d) => (liveFresh ? live.devices?.[d.id] : null);
    let tl = (await kvGet(env, "tuyaList")) ?? { at: 0, list: [] };
    const allLocal = devs.length > 0 && devs.every((d) => lv(d) || tl.list.some((x) => x.id === d.id && x.online === false)), anyOff = tl.list.some((d) => d.online === false && devs.some((x) => x.id === d.id) && !lv(devs.find((x) => x.id === d.id)));
    const listEvery = allLocal ? 15 * 60e3 : anyOff ? 60e3 : 5 * 60e3; // the device list costs a Tuya call, so it's rare when the agent covers everything
    if (forceList || now - tl.at > listEvery) { try { tl = { at: now, list: await refreshTuyaList(env) }; } catch (e) { if (forceList) throw e; } }
    const meta = Object.fromEntries(tl.list.map((d) => [d.id, d]));
    const needCloud = devs.filter((d) => !lv(d) && meta[d.id]?.online !== false); // a device the cloud already lists as offline has nothing to ask for
    let status = {}, cloudErr = null;
    if (needCloud.length) { try { status = await tuya(env, "GET", `/v1.0/devices/status?device_ids=${needCloud.map((d) => d.id).join(",")}`); } catch (e) { cloudErr = e.message; } } // the phone's readings are still published
    // An offline device's cloud values are the last ones it reported, not a reading, so publish no live numbers for it.
    if (!cloudErr && (await cloudBlocked(env))) cloudErr = "Tuya cloud paused: its quota is used up (error 28841004)"; // not asking is not the same as being fine: say so
    const plugs = devs.map((d) => {
      const l = lv(d), m = meta[d.id], gone = Boolean(l?.unreachable), was = prev.plugs?.find((x) => x.id === d.id); // gone: the agent can't reach this plug
      const r = l && !gone ? { on: l.on, hasPower: l.watts != null, watts: l.watts, volts: l.volts, amps: l.amps, kwh: l.kwh } : gone ? { on: null, hasPower: l.lastWatts != null || Boolean(was?.hasPower), watts: null, volts: null, amps: null, kwh: null } : readings(status[d.id] ?? []);
      const off = gone || (!l && m?.online === false);
      return { id: d.id, name: d.name, role: d.role, icon: d.icon, category: m?.category ?? null, online: gone ? false : l ? true : m ? m.online : null, local: Boolean(l) && !gone, timer: l && !gone ? (l.timer ?? null) : null, on: off ? null : r.on, hasPower: r.hasPower,
        watts: off ? null : r.watts, volts: off ? null : r.volts, amps: off ? null : r.amps, kwh: r.kwh ?? null,
        lastWatts: gone ? (l.lastWatts ?? was?.lastWatts ?? was?.watts ?? null) : off ? r.watts : null, lastSeen: gone ? (l.lastSeenAt ?? was?.lastSeen ?? was?.at ?? null) : off && m?.update_time ? m.update_time * 1000 : null, at: now };
    });
    let histT = prev.histT ?? 0;
    const gridLast = prev.agg?.gridLast ?? null; let gridNew = gridLast;
    if (now - histT > (liveFresh ? 30_000 : 60_000)) {
      const stmts = [];
      for (const p of plugs) {
        if (p.role === "grid") { if (p.online != null) { const present = p.online ? 1 : 0; if (!gridLast || gridLast.present !== present || now - gridLast.t > 10 * 60e3) { stmts.push(env.DB.prepare("INSERT OR REPLACE INTO grid(t,present) VALUES(?,?)").bind(now, present)); gridNew = { present, t: now }; } } } // only on a change, plus a heartbeat every 10 minutes
        else if (p.hasPower || p.online === false) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO samples(t,id,w) VALUES(?,?,?)").bind(now, p.id, p.watts));
      }
      if (stmts.length) await env.DB.batch(stmts);
      if (gridNew !== gridLast) await kvSet(env, "gridCache", null); // the grid state changed: don't serve the cached panel
      histT = now;
    }
    // Cross-check: even when the phone covers every plug, about every 3 minutes Tuya's cloud is asked for each plug's relay state. If it disagrees with the phone for two checks in a row, the plug is flagged
    // (the app shows both answers and an alert goes out), so one wrong source can never go unnoticed again. The phone's answer is still the one shown, because it is the quicker and more direct one.
    let cross = prev.cross ?? { at: 0, miss: {} };
    if (liveFresh && now - cross.at > 10 * 60e3 && !(await cloudBlocked(env))) {
      const ids = plugs.filter((p) => p.local && p.role !== "grid" && typeof p.on === "boolean").map((p) => p.id);
      if (ids.length) {
        try {
          const cloud = await tuya(env, "GET", `/v1.0/devices/status?device_ids=${ids.join(",")}`), miss = {};
          for (const p of plugs) { if (!ids.includes(p.id)) continue; const co = readings(cloud[p.id] ?? []).on; if (typeof co === "boolean" && co !== p.on) miss[p.id] = (cross.miss?.[p.id] ?? 0) + 1; }
          cross = { at: now, miss };
        } catch { cross = { ...cross, at: now - 2 * 60e3 }; } // could not ask: try again in a minute
      } else cross = { at: now, miss: {} };
    }
    for (const p of plugs) if ((cross.miss?.[p.id] ?? 0) >= 2) { p.cloudDisagrees = true; p.cloudOn = !p.on; }
    const agg = await updateAgg(env, prev.agg, plugs, now); agg.gridLast = gridNew;
    for (const p of plugs) { p.kwhToday = Math.round(agg.wh[p.id] ?? 0) / 1000; const c = agg.swChange?.[p.id]; p.relaySince = c && !c.initial ? c.at : null; } // relaySince: when the relay last switched, if we saw it happen
    const tank = plugs.find((p) => p.role === "tank");
    await kvSet(env, "state", { now, cloud: cloudErr ? { ok: false, at: prev.cloud?.ok ? prev.cloud.at : prev.cloud?.at ?? null, error: cloudErr } : { ok: true, at: now, error: null }, plugs, totals: totalsNow(devs, tank?.watts ?? null, agg), histT, agg, cross });
    return plugs;
  } catch (e) {
    await kvSet(env, "state", { ...prev, cloud: { ok: false, at: prev.cloud?.at ?? null, error: e.message } });
    throw e;
  }
}

// ---------- automation (the fridge) and the data log ----------
const LOG_KEEP_DAYS = 120;
let logTables = false; // the two log tables are created here on first use, so no separate database step is needed
async function ensureLogTables(env) {
  if (logTables) return;
  await env.DB.batch([env.DB.prepare("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, msg TEXT NOT NULL, data TEXT)"), env.DB.prepare("CREATE INDEX IF NOT EXISTS events_t ON events (t)"), env.DB.prepare("CREATE TABLE IF NOT EXISTS datalog (t INTEGER PRIMARY KEY, d TEXT NOT NULL)")]);
  logTables = true;
}
const schedulesHeld = () => true; // the fridge belongs to Automation in every mode, so its own schedules never run
async function getAuto(env) { const a = (await kvGet(env, "auto")) ?? {}; return { mode: a.mode === "manual" || a.mode === "absolute" ? a.mode : a.mode ? "auto" : "manual", manualUntil: a.manualUntil ?? null, weak: Boolean(a.weak), weakSince: a.weakSince ?? null, dayThrottle: Boolean(a.dayThrottle), daySince: a.daySince ?? null, cfg: mergeAuto(a.cfg) }; } // older saved modes (frost, cycle) become Automatic
const saveAuto = (env, a) => kvSet(env, "auto", a);
// Every automatic action, button press and mode change, with the reason. The last few are kept in the saved state so the app needs no database read.
async function logEvent(env, kind, msg, data) {
  await ensureLogTables(env);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO events(t,kind,msg,data) VALUES(?,?,?,?)").bind(t, kind, msg, data ? JSON.stringify(data) : null).run();
  const recent = ((await kvGet(env, "autoRecent")) ?? []); recent.unshift({ t, kind, msg }); await kvSet(env, "autoRecent", recent.slice(0, 20));
}
// Remember a command the Worker itself sent to the fridge, so the next check can tell it from someone pressing the switch.
async function noteCmd(env, id, on, src) { const st = (await kvGet(env, "autoState")) ?? {}; st.cmd = { id, on, at: Date.now(), src }; await kvSet(env, "autoState", st); }
async function gridOnNow(env, plugs) {
  const g = plugs.find((p) => p.role === "grid"); if (g) return g.online == null ? null : Boolean(g.online);
  const l = await kvGet(env, "gridLight"); return l && Date.now() - l.at < 15 * 60e3 ? Boolean(l.on) : null;
}
const fmtH = (ms) => (ms < 3600e3 ? Math.round(ms / 60000) + " min" : (ms / 3600e3).toFixed(1) + " h");
// Runs on its own timer (odd minutes) with its own CPU allowance, and reads the plugs from the saved state the agent keeps fresh.
// When the display has not been read for a while at night, with no grid, the battery is estimated from the last reading minus what the tank has supplied since (its measured watts,
// 7.8 Wh to the percent). Solar charging is ignored, which only ever makes the estimate lower than the truth, and the estimate is only used at night, when there is no sun anyway.
// It keeps the fridge protection working through a gap in readings; it is never used to cut the tank output.
async function estimateBattery(env, batt, tank, now) {
  const since = batt.at, hrs = (now - since) / 3600e3;
  if (hrs <= 0 || hrs > 6) return null;
  const gridBefore = await env.DB.prepare("SELECT present FROM grid WHERE t<=? ORDER BY t DESC LIMIT 1").bind(since).first();
  const gridSince = await env.DB.prepare("SELECT COUNT(*) n FROM grid WHERE t>? AND present=1").bind(since).first();
  if (gridBefore?.present === 1 || (gridSince?.n ?? 0) > 0) return null; // the grid was charging the tank in the gap: no way to tell how much
  const r = await env.DB.prepare("SELECT AVG(w) a, COUNT(w) n FROM samples WHERE id=? AND t>=?").bind(tank.id, since).first();
  if (!r || r.a == null || r.n < 3) return null;
  const drop = (r.a * hrs) / 7.8; // percent
  return { pct: Math.max(0, Math.round(batt.percent - drop)), from: batt.percent, drop: Math.round(drop * 10) / 10, at: since };
}
// After a cut, the plug's own timer (it runs inside the plug, with no Wi-Fi) brings the tank output back at about 10:30 the next morning, or a set time later if the cut is in the daytime.
// Without it the output could not come back at all: it can only be switched on through the router, which has no power while the output is off.
function tankBackSecs(cfg, L) {
  const tgt = Number(cfg.cutBackAt.slice(0, 2)) * 60 + Number(cfg.cutBackAt.slice(3, 5)), m = L.mins;
  if (m >= tgt && m < 15 * 60) return Math.round((cfg.cutBackDayMin * 60) / 1.02);
  let d = tgt - m; if (d <= 0) d += 1440;
  // never sooner than the daytime delay: the battery needs time to recover first. The plug's timer was measured to run about 9 % slow (900 s took 980 s), so it is set a little shorter to land on time (a 4-hour timer was later measured at about real speed, so only 2 %).
  return Math.round(Math.min(86400, Math.max(d * 60, cfg.cutBackDayMin * 60)) / 1.02);
}
// The rhythm that applies right now (null in plain daytime, when the fridge simply stays on), so an event can restart it from where the fridge really is.
function rhythmNow(A, cfg, now, date) { return A.weak ? cfg.weak : windowAt(cfg.night.from, cfg.night.to, now, date) ? cfg.night : A.dayThrottle ? cfg.dayThrottle : null; }
async function autoTick(env) {
  const stt = await kvGet(env, "state"), plugs = stt?.plugs ?? [], now = Date.now();
  const st = (await kvGet(env, "autoState")) ?? {}; if (st.lastT && now - st.lastT < 60e3) return; // a double firing of the timer must not act twice
  await ensureLogTables(env);
  const A = await getAuto(env), L = lagos(), cfg = A.cfg;
  if (A.mode === "manual" && A.manualUntil && now >= A.manualUntil) { A.mode = "auto"; A.manualUntil = null; await saveAuto(env, A); await logEvent(env, "mode", "Manual ended: back to Automatic"); } // Manual only lasts a while
  const fr = plugs.find((p) => p.role === "fridge"), tank = plugs.find((p) => p.role === "tank"), settings = await getSettings(env), batt = await kvGet(env, "battery"), gridOn = await gridOnNow(env, plugs);
  if (st.dayDate !== L.date) { st.dayDate = L.date; st.dayOnMs = 0; }
  if (fr?.on === true && st.seenOn === true && st.lastT) st.dayOnMs = (st.dayOnMs ?? 0) + Math.min(now - st.lastT, 6 * 60e3);
  // what changed since the last check: the fridge switch (and who did it), the grid, the tank output
  if (fr && fr.on != null) {
    if (st.seenOn != null && fr.on !== st.seenOn) {
      const ours = st.cmd && st.cmd.id === fr.id && st.cmd.on === fr.on && now - st.cmd.at < 6 * 60e3;
      if (!ours && A.mode !== "auto") { // in Manual and Absolute your own press is respected: held for the Manual time, or until the mode changes or you press again
        st.hold = { on: fr.on, at: now, mode: A.mode, until: A.mode === "manual" ? now + cfg.manualH * 3600e3 : null };
        if (A.mode === "manual") { A.manualUntil = st.hold.until; await saveAuto(env, A); } // the Manual time counts from your last press
      }
      await logEvent(env, ours ? "relay" : "press", `Fridge switched ${fr.on ? "on" : "off"}${ours ? (st.cmd.src === "schedule" ? " by a schedule" : st.cmd.src === "cycle" ? " by the night rhythm" : st.cmd.src === "hold" ? " (held)" : " by Automatic") : A.mode === "auto" ? " by you: the fridge rules put it back" : st.hold.until ? ` by you: held for ${fmtH(cfg.manualH * 3600e3)}` : " by you: held until you change the mode or switch it again"}`);
    }
    if (st.seenOn !== fr.on) { if (fr.on) { st.onSince = now; st.offSince = null; } else { st.offSince = now; st.onSince = null; } }
    st.seenOn = fr.on;
  }
  if (gridOn != null && st.seenGrid != null && gridOn !== st.seenGrid) { await logEvent(env, "grid", `Grid ${gridOn ? "came on" : "went off"}`); if (!gridOn) { const sp = rhythmNow(A, cfg, now, L.date); st.anchor = sp ? phaseAnchor(sp, fr, fr?.on ? st.onSince : st.offSince, now) : now; st.anchorAt = now; } } // the fridge has just run on the grid, so the rhythm starts again with a rest
  if (gridOn != null) st.seenGrid = gridOn;
  if (tank && tank.on != null && st.seenTank != null && tank.on !== st.seenTank) await logEvent(env, "relay", `Power tank output switched ${tank.on ? "on" : "off"}`);
  if (tank && tank.on != null) st.seenTank = tank.on;
  st.lastT = now; await kvSet(env, "autoState", st); // saved now, so an interrupted run can never report the same change twice
  let pct = batt?.percent ?? null; const pctAgeMin = batt?.at ? (now - batt.at) / 60000 : null; let battOk = pct != null && pctAgeMin != null && pctAgeMin <= cfg.staleMin, est = null;
  if (!battOk && pct != null && pctAgeMin != null && pctAgeMin < 360 && gridOn === false && tank && windowAt(cfg.night.from, cfg.night.to, now, L.date)) { est = await estimateBattery(env, batt, tank, now).catch(() => null); if (est) { pct = est.pct; battOk = true; } }
  const trusted = battOk && !est; // a real reading: only these may cut the tank output or end Weak night
  // the fridge stays off after the emergency level until the battery is 4 points clear of it
  if (A.weak && trusted && pct >= cfg.weak.endAt) { A.weak = false; A.weakSince = null; await saveAuto(env, A); { const sp = rhythmNow(A, cfg, now, L.date); st.anchor = sp ? phaseAnchor(sp, fr, fr?.on ? st.onSince : st.offSince, now) : now; st.anchorAt = now; } st.lastWeakEnd = { at: now, pct }; await logEvent(env, "mode", `Weak night ended: battery at ${pct}%, back to the normal night plan`); }
  if (A.dayThrottle && windowAt(cfg.night.from, cfg.night.to, now, L.date)) { A.dayThrottle = false; A.daySince = null; await saveAuto(env, A); await logEvent(env, "mode", "Day throttle ended: the night plan has started"); }
  st.emOff = gridOn === true ? false : battOk ? pct <= cfg.emergency || (Boolean(st.emOff) && pct <= cfg.emergency + 4) : Boolean(st.emOff);
  if (st.hold && (st.hold.mode !== A.mode || A.mode === "auto" || (st.hold.until && now >= st.hold.until))) st.hold = null; // the hold ends with the Manual time or when the mode changes
  const togAt = Math.max(A.weak ? A.weakSince ?? 0 : 0, A.dayThrottle ? A.daySince ?? 0 : 0), evAt = Math.max(st.anchorAt ?? 0, st.anchor ?? 0), planAnchorAt = Math.max(evAt, togAt), planAnchor = togAt > evAt ? togAt : (st.anchor ?? 0);
  let plan = autoPlan({ cfg, now, today: L.date, fr, tankW: tank?.watts ?? null, limit: settings.limit, pct, gridOn, emOff: st.emOff, weak: A.weak, dayThrottle: A.dayThrottle, anchor: planAnchor, anchorAt: planAnchorAt });
  if (st.hold && plan && !plan.urgent) plan = { action: st.hold.on === fr.on ? null : st.hold.on ? "on" : "off", reason: `Held ${st.hold.on ? "on" : "off"} by you${st.hold.until ? " until " + new Date(st.hold.until + 3600e3).toISOString().slice(11, 16) : " until you change the mode or switch it again"}`, urgent: false, src: "hold" }; // only the safety rules (15 %, overload) override a hold
  let why = plan?.reason ?? "The fridge plug is offline, so nothing can be changed", acted = null, switched = false;
  const resting = plan?.src === "cycle" && plan.action !== "on" && plan.restMin > 0;
  if (fr && st.cdUntil && st.cdUntil > now && !resting) { try { await sendCountdown(env, fr.id, 0); st.cdUntil = null; } catch { /* retried on the next check */ } } // the plug's timer must never switch the fridge on when the rules want it off (15 % level, a hold) or after the rest is over
  if (plan?.action && fr) { // Automatic always puts the fridge where it should be, whatever was pressed in the meantime
    const want = plan.action === "on";
    try { const retry = st.cmd && st.cmd.id === fr.id && st.cmd.on === want && now - st.cmd.at < 6 * 60e3; const sw = await sendSwitch(env, fr.id, want, { local: !retry }); st.cmd = { id: fr.id, on: want, at: retry ? st.cmd.at : now, src: plan.src }; acted = plan.action; switched = true; await logEvent(env, plan.src, `Fridge ${want ? "on" : "off"}: ${why}${sw?.via === "phone" ? " · sent through the phone" : retry ? " · phone did not manage it, cloud route used" : ""}`, { pct, grid: gridOn }); }
    catch (e) { await logEvent(env, "error", `Could not switch the fridge ${want ? "on" : "off"}: ${e.message}`); }
    if (acted === "off" && resting) { try { await sendCountdown(env, fr.id, (plan.restMin + 3) * 60); st.cdUntil = now + (plan.restMin + 3) * 60e3; } catch (e) { await logEvent(env, "error", `Could not set the plug timer: ${e.message}`); } }
  }
  // the very last resort: cut the tank output before the tank runs empty (it can only be restarted by hand), and bring it back once the battery has recovered and there is no grid
  if (tank && tank.online !== false) {
    try {
      // While a cut is in force the plug carries ONE timer that runs to the morning (cutBackAt, about when the sun starts charging): no coming back on during the night, so no battery is wasted. It is looked at on every
      // check and set again if it is ever missing (0 or never set), so it can no longer be absent without anyone noticing. A test cut (kv testCut) is left alone.
      const timerKnown = tank.timer !== null && tank.timer !== undefined, back0 = tankBackSecs(cfg, L);
      const needTimer = st.cutAt && !st.lastCut?.test && tank.on === false && (timerKnown ? tank.timer === 0 : !st.tankTimerAt) && now - (st.tankTimerTry ?? 0) > 50e3; // tank.on === false is read live; the Hub also refuses a timer on a plug that is on
      // The planned return time has passed, the plug is reachable and still off (the timer ran out, or never ran): do not wait for another timer, switch it on now. Nothing is allowed to keep the output off past its time.
      if (st.cutAt && !st.lastCut?.test && tank.on === false && st.lastCut?.backAt && now > st.lastCut.backAt + 120e3 && (!timerKnown || tank.timer === 0)) { try { await sendSwitch(env, tank.id, true); st.cutAt = null; st.tankTimerAt = null; switched = true; await logEvent(env, "restore", "The tank output was still off after its planned return time: switched on now"); } catch (e) { await logEvent(env, "error", `Could not switch the tank output on: ${e.message}`); } }
      if (needTimer) { st.tankTimerTry = now; try { await sendCountdown(env, tank.id, back0); st.tankTimerAt = now; if (st.lastCut) st.lastCut.backAt = now + back0 * 1000; await logEvent(env, "cut", `The tank plug had no timer running during the cut: it is set again to switch the output back on at ${new Date(now + back0 * 1000 + 3600e3).toISOString().slice(11, 16)}`); } catch (e) { await logEvent(env, "error", `Could not set the tank plug's timer: ${e.message}`); } }
      if (st.tankTimerAt && tank.on === true) { try { await sendCountdown(env, tank.id, 0); st.tankTimerAt = null; } catch { /* retried on the next check */ } } // the output is back on (by hand, by the rules or by its own timer): the timer must not switch it off later
      // A self-test of the whole cut-and-comeback cycle can be requested (kv "testCut": { at, seconds }); it runs the very same code below, but only while the grid is on and the battery is at 50 % or more.
      const tc = await kvGet(env, "testCut"), testCut = Boolean(tc) && now - tc.at < 5 * 60e3 && tank.on === true && (tc.force === true || (gridOn === true && (pct ?? 0) >= 50));
      if (tc) await kvSet(env, "testCut", null);
      if (testCut || (cfg.cutOn && gridOn === false && trusted && pct <= cfg.cutAt && tank.on === true)) {
        await sendSwitch(env, tank.id, false); st.cutAt = now; st.lastCut = { at: now, pct, test: testCut || undefined }; switched = true;
        const back = testCut ? Math.max(60, Math.min(3600, Number(tc.seconds) || 150)) : tankBackSecs(cfg, L); try { await sendCountdown(env, tank.id, back); st.tankTimerAt = now; st.lastCut.backAt = now + back * 1000; } catch (e) { await logEvent(env, "error", `Could not set the tank plug's own timer: ${e.message}`); }
        await logEvent(env, "cut", `${testCut ? "TEST: " : ""}Battery at ${pct}%: the tank output was switched off so the tank does not run empty${st.lastCut.backAt ? `; the plug's own timer will switch it back on at ${new Date(st.lastCut.backAt + 3600e3).toISOString().slice(11, 16)}, even if the router has died; it is checked on every pass and set again if it goes missing` : ""}`);
      }
      else if (st.cutAt && tank.on === false && gridOn === false && trusted && pct >= cfg.restoreAt) { await sendSwitch(env, tank.id, true); if (st.tankTimerAt) { try { await sendCountdown(env, tank.id, 0); st.tankTimerAt = null; } catch { /* retried */ } } st.cutAt = null; st.lastRestore = { at: now, pct }; switched = true; await logEvent(env, "restore", `Battery at ${pct}%: the tank output was switched back on`); }
      else if (st.cutAt && tank.on === true && now - st.cutAt > 60e3) st.cutAt = null; // it is back on (its own timer, the rules or someone by hand): the cut is over
    } catch (e) { await logEvent(env, "error", `Could not switch the tank output: ${e.message}`); }
  }
  // average draw over the last 30 minutes (what the "time left" on the battery card is based on)
  let avgTank = null, avgFridge = null, avgCover = 0;
  if (tank) { const ids = [tank.id, fr?.id ?? tank.id], rows = (await env.DB.prepare("SELECT id, AVG(w) a, COUNT(w) n FROM samples WHERE t>=? AND id IN (?,?) GROUP BY id").bind(now - 30 * 60e3, ids[0], ids[1]).all()).results; for (const r of rows) { if (r.id === tank.id) { avgTank = r.a; avgCover = r.n / 2; } else avgFridge = r.a; } }
  // what the tank delivers with the fridge off / on, from the last 6 hours (both plugs are sampled together); with the plan's rhythm that gives a steady "time left"
  let forecast = null;
  if (tank && fr && pct != null && gridOn !== true && !st.cutAt) {
    try {
      const q = (await env.DB.prepare("SELECT (b.w < 1) off, AVG(a.w) w, COUNT(*) n FROM samples a JOIN samples b ON b.t = a.t AND b.id = ? WHERE a.id = ? AND a.t >= ? AND a.w > 1 GROUP BY (b.w < 1)").bind(fr.id, tank.id, now - 6 * 3600e3).all()).results, offR = q.find((r) => r.off === 1), onR = q.find((r) => r.off === 0);
      if (offR && offR.n >= 10) { const offW = offR.w, onW = onR && onR.n >= 10 ? onR.w : offW + 45; forecast = forecastTank({ cfg, now, pct, wh: cfg.usableWh ?? 800, offW, onW: Math.max(onW, offW), weak: A.weak, dayThrottle: A.dayThrottle, anchor: planAnchor, anchorAt: planAnchorAt }); }
    } catch { /* the plain figure still shows */ }
  }
  st.status = { forecast, estPct: est?.pct ?? null, estFrom: est?.from ?? null, estDrop: est?.drop ?? null, avgTankW: avgTank == null ? null : Math.round(avgTank * 10) / 10, avgFridgeW: avgFridge == null ? null : Math.round(avgFridge * 10) / 10, avgCoverMin: Math.round(avgCover), at: now, reason: why, wouldDo: plan?.action ?? null, urgent: Boolean(plan?.urgent), dayOnMin: Math.round((st.dayOnMs ?? 0) / 60000), offForMin: st.offSince ? Math.round((now - st.offSince) / 60000) : 0, gridOn, cutAt: st.cutAt ?? null, emOff: Boolean(st.emOff), weak: A.weak, dayThrottle: A.dayThrottle, hold: st.hold ? { on: st.hold.on, until: st.hold.until } : null };
  if (acted) st.lastActed = { at: now, action: acted, reason: why, urgent: Boolean(plan?.urgent), src: plan.src };
  await kvSet(env, "autoState", st);
  if (switched) { await sleep(1500); await poll(env).catch(() => {}); }
}
// The three jobs also run from the home agent's regular reports (every ~10 s): each report starts whichever job is due, one at a time, so a job never gets more than a request's worth of CPU
// and the automation keeps running even if Cloudflare's timers stall. The timers stay as a backup; every job ignores a second run within a minute.
const JOB_EVERY = 110e3;
async function runDueJob(env) {
  const now = Date.now(), j = (await kvGet(env, "jobs")) ?? {};
  // the job that has waited longest goes first; with a fixed order the automation, always due again by the next timer tick, left the alerts and the log waiting for ever
  const due = [["auto", autoTick], ["alerts", alertsTick], ["log", dataLogTick]].map(([name, fn]) => ({ name, fn, wait: now - (j[name] ?? 0) })).filter((x) => x.wait >= JOB_EVERY).sort((a, b) => b.wait - a.wait)[0];
  if (!due) return;
  j[due.name] = now; await kvSet(env, "jobs", j);
  try { await due.fn(env); } catch (e) { console.error(due.name + " failed:", e.message); }
}
// The data-log row, built from what the other jobs saved.
async function dataLogTick(env) {
  await ensureLogTables(env);
  const last = await env.DB.prepare("SELECT MAX(t) AS m FROM datalog").first(); if (last?.m && Date.now() - last.m < 90e3) return; // one row per ~2 minutes, however it was triggered
  const stt = await kvGet(env, "state"), plugs = stt?.plugs ?? [], st = (await kvGet(env, "autoState")) ?? {}, A = await getAuto(env), now = Date.now(), s0 = st.status ?? {};
  await dataLog(env, plugs, A, { reason: s0.reason ?? null, action: s0.wouldDo ?? null, floor: s0.floor ?? null, onLevel: s0.onLevel ?? null, reservePct: s0.reservePct ?? null }, st, s0.gridOn ?? null, now, lagos());
}
// One row of everything that is known, every 2 minutes. Kept as JSON so new fields can be added later without changing the table; /api/log/export turns it into columns.
async function dataLog(env, plugs, A, d, st, gridOn, now, L) {
  const batt = await kvGet(env, "battery"), gl = await kvGet(env, "gridLight"), live = await kvGet(env, "live"), phone = await kvGet(env, "phone"), cam = await kvGet(env, "camera"), r = (await kvGet(env, "router")) ?? {}, z = r.zte ?? {};
  const row = { local: new Date(now + 3600e3).toISOString().slice(0, 16).replace("T", " "), dow: L.dow, mode: A.mode, paused: Boolean(A.manualUntil && A.manualUntil > now) ? 1 : 0,
    grid_on: gridOn == null ? null : gridOn ? 1 : 0, grid_light_score: gl?.score ?? null, grid_light_age_s: gl ? Math.round((now - gl.at) / 1000) : null,
    bat_pct: batt?.percent ?? null, bat_age_s: batt ? Math.round((now - batt.at) / 1000) : null, bat_charging: batt ? (batt.charging ? 1 : 0) : null, bat_votes: batt?.votes ?? null,
    agent_age_s: live ? Math.round((now - live.at) / 1000) : null, phone_pct: phone?.percent ?? null, phone_status: phone?.status ?? null, phone_plugged: phone?.plugged ?? null, phone_temp: phone?.temp ?? null,
    cam_ok: cam ? (cam.ok ? 1 : 0) : null, cam_front: cam ? (cam.front ? 1 : 0) : null, cam_torch: cam ? (cam.torch ? 1 : 0) : null,
    net_loss: r.netLoss ?? null, net_ms: r.netMs ?? null, net_up24: r.uptime24 ?? null, sig_type: z.type ?? null, sig_bars: z.bars ?? null, sig_rsrp: z.rsrp ?? null, sig_sinr: z.sinr ?? null, sig_band: z.band ?? null, router_devices: Array.isArray(z.devices) ? z.devices.length : null, month_rx: z.monthRx ?? null,
    auto_reason: d.reason, auto_wants: d.action, auto_floor: d.floor, auto_restart_at: d.onLevel, auto_reserve_pct: d.reservePct, fridge_run_today_min: Math.round((st.dayOnMs ?? 0) / 60000) };
  const tank = plugs.find((p) => p.role === "tank"), fr = plugs.find((p) => p.role === "fridge");
  row.supply = tank && tank.online && tank.on ? "tank" : gridOn === true && fr?.on ? "grid" : tank && (tank.online === false || tank.on === false) ? "none-or-grid" : "unknown";
  for (const p of plugs) {
    const k = p.role === "tank" ? "tank" : p.role === "fridge" ? "fridge" : p.role === "grid" ? "gridplug" : "dev_" + p.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 16);
    Object.assign(row, { [k + "_on"]: p.on == null ? null : p.on ? 1 : 0, [k + "_w"]: p.watts ?? null, [k + "_v"]: p.volts ?? null, [k + "_a"]: p.amps ?? null, [k + "_online"]: p.online == null ? null : p.online ? 1 : 0, [k + "_local"]: p.local ? 1 : 0, [k + "_kwh_today"]: p.kwhToday ?? null, [k + "_timer"]: p.timer ?? null });
  }
  await env.DB.prepare("INSERT OR REPLACE INTO datalog(t,d) VALUES(?,?)").bind(now, JSON.stringify(row)).run();
}
const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
async function exportLog(env, table, days, fmt) {
  await ensureLogTables(env);
  const from = Date.now() - days * 86400e3;
  if (table === "events") {
    const rows = (await env.DB.prepare("SELECT t,kind,msg,data FROM events WHERE t>=? ORDER BY t").bind(from).all()).results;
    if (fmt === "json") return rows;
    return "t_ms,local,kind,msg,data\n" + rows.map((r) => [r.t, new Date(r.t + 3600e3).toISOString().slice(0, 16).replace("T", " "), r.kind, r.msg, r.data].map(csvCell).join(",")).join("\n");
  }
  const rows = (await env.DB.prepare("SELECT t,d FROM datalog WHERE t>=? ORDER BY t").bind(from).all()).results.map((r) => ({ t_ms: r.t, ...JSON.parse(r.d) }));
  if (fmt === "json") return rows;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return cols.join(",") + "\n" + rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
}

// ---------- Telegram alerts ----------
async function getAlerts(env) { return mergeAlerts(await kvGet(env, "alerts")); }
async function sendTelegram(env, text) {
  const token = clean(env.TELEGRAM_TOKEN), chat = clean(env.TELEGRAM_CHAT); if (!token || !chat) throw new Error("Telegram isn't set up on the server");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({})); if (!j.ok) throw new Error(j.description || "Telegram refused the message");
}
// Called after every automation check. A condition sends once when it begins, again at most every repeatMin while it lasts, and says so once when it ends.
async function alertsTick(env) {
  const cfg = await getAlerts(env); if (!cfg.enabled || !clean(env.TELEGRAM_TOKEN)) return;
  const now = Date.now(), stt = await kvGet(env, "state"), plugs = stt?.plugs ?? [], au = (await kvGet(env, "autoState")) ?? {}, s0 = au.status ?? {}, A = await getAuto(env), batt = await kvGet(env, "battery"), live = await kvGet(env, "live"), camera = await kvGet(env, "camera"), settings = await getSettings(env);
  const st = (await kvGet(env, "alertState")) ?? { c: {}, lastGrid: null, dailyDate: null }, gridOn = s0.gridOn ?? null;
  if (st.lastRun && now - st.lastRun < 60e3) return; st.lastRun = now; // the timer sometimes fires twice a few seconds apart
  await kvSet(env, "alertState", st);
  const send = async (key, text) => { try { await sendTelegram(env, text); await logEvent(env, "alert", text.replace(/^\S+\s/, "")); return true; } catch (e) { console.error("alert failed:", key, e.message); return false; } };
  const list = conditions({ cfg, plugs, cloud: stt?.cloud ?? null, gridOn, pct: batt?.percent ?? null, pctAgeMin: batt?.at ? (now - batt.at) / 60000 : null, d: { reservePct: s0.reservePct ?? 0, wouldDo: now - (s0.at ?? 0) < 5 * 60e3 ? s0.wouldDo ?? null : null, reason: s0.reason ?? null }, limit: settings.limit, emergency: A.cfg.emergency, agentAgeMin: live ? (now - live.at) / 60000 : null, camera, active: Object.fromEntries(Object.entries(st.c).map(([k, v]) => [k, v.sentAt != null])) });
  for (const c of list) {
    const s1 = (st.c[c.key] ??= { since: null, sentAt: null });
    if (c.raw) {
      s1.since ??= now;
      if (now - s1.since >= c.afterMin * 60e3 && (!s1.sentAt || now - s1.sentAt >= (c.repeatMin ?? cfg.repeatMin) * 60e3)) { const was = s1.sentAt; s1.sentAt = now; await kvSet(env, "alertState", st); if (!(await send(c.key, c.text))) { s1.sentAt = was; await kvSet(env, "alertState", st); } }
    } else {
      if (s1.sentAt) { const was = s1.sentAt; s1.sentAt = null; s1.since = null; await kvSet(env, "alertState", st); if (!(await send(c.key, "✅ " + c.clear))) { s1.sentAt = was; await kvSet(env, "alertState", st); } } else s1.since = null;
    }
  }
  if (cfg.grid && gridOn != null) { // grid on or off: once per change, with how long the other state lasted
    const g = st.lastGrid;
    if (g && g.on !== gridOn) { st.lastGrid = { on: gridOn, at: now }; await kvSet(env, "alertState", st); await send("grid", gridOn ? `⚡ The grid is on (it was off for ${hm(now - g.at)}).` : `🔌 The grid went off (it was on for ${hm(now - g.at)}).`); }
    else if (!g) st.lastGrid = { on: gridOn, at: now };
  }
  if (cfg.frost && A.mode === "auto" && gridOn === false && !A.weak) { // the night plan: with no switches for the light and fan yet, a message says when to turn them off
    const f = A.cfg.night, w = windowAt(f.from, f.to, now, lagos().date), tankW = plugs.find((p) => p.role === "tank")?.watts, draw = tankW != null ? ` The house is drawing ${Math.round(tankW)} W.` : "";
    if (w && st.frostStart !== w.start) { st.frostStart = w.start; await kvSet(env, "alertState", st); await send("frost", `🧊 Night plan: the fridge runs ${f.onMin} min on, ${f.offMin} off until ${f.to}. Keep the lights off${f.fanUntil ? ` and the fan only until ${f.fanUntil}` : ""}.${draw}`); }
    const fanAt = w && f.fanUntil ? nextAfter(w.start, f.fanUntil) : null;
    if (w && fanAt && now >= fanAt && now < w.end && st.frostFan !== w.start) { st.frostFan = w.start; await kvSet(env, "alertState", st); await send("frost", `🌀 Fan time is over (${f.fanUntil}). Switch the fan off to save battery for the fridge.${draw}`); }
  }
  if (cfg.weakNudge && gridOn === false && !A.weak && batt?.percent != null && batt.at && now - batt.at <= A.cfg.staleMin * 60e3 && batt.percent < A.cfg.weak.endAt) { // the night is about to start (or has just started) with a low battery: suggest Weak night, once per night
    const nw = windowAt(A.cfg.night.from, A.cfg.night.to, now + (cfg.weakNudgeMin ?? 30) * 60e3, lagos(new Date(now + (cfg.weakNudgeMin ?? 30) * 60e3)).date);
    if (nw && now < nw.start + 60 * 60e3 && st.weakNudgeFor !== nw.start) { st.weakNudgeFor = nw.start; await kvSet(env, "alertState", st); await send("weakNudge", weakNudgeText(batt.percent, A.cfg, now)); }
  }
  if (cfg.frost && A.weak && A.weakSince && A.weakSince > (st.weakSent ?? 0)) { st.weakSent = A.weakSince; await kvSet(env, "alertState", st); await send("frost", `🌑 Weak night is on: the fridge runs ${A.cfg.weak.onMin} min on, ${A.cfg.weak.offMin} off. Keep the fan and lights off. It switches itself off when the battery reaches ${A.cfg.weak.endAt}%.`); }
  if (cfg.frost && au.lastWeakEnd && au.lastWeakEnd.at > (st.weakEndSent ?? 0)) { st.weakEndSent = au.lastWeakEnd.at; await kvSet(env, "alertState", st); await send("frost", `✅ Weak night ended: battery at ${au.lastWeakEnd.pct}%, back to the normal night plan.`); }
  if (cfg.cut && au.lastCut && au.lastCut.at > (st.cutSent ?? 0)) { st.cutSent = au.lastCut.at; await kvSet(env, "alertState", st); await send("cut", `${au.lastCut.test ? "🧪 TEST of the cut, not a real one. " : ""}⚫ Battery at ${au.lastCut.pct}%: the tank output was switched off so the tank does not run empty. The house is dark. The phone and router keep running on their own batteries for a while. ${au.lastCut.backAt ? `The plug's own timer switches the output back on at ${new Date(au.lastCut.backAt + 3600e3).toISOString().slice(11, 16)}, even if the router has died by then, and it is checked every two minutes while we can reach it.` : "If the router dies, nothing can switch it back on remotely: it needs the button on the plug."}`); }
  if (cfg.cut && au.lastRestore && au.lastRestore.at > (st.restoreSent ?? 0)) { st.restoreSent = au.lastRestore.at; await kvSet(env, "alertState", st); await send("cut", `✅ Battery at ${au.lastRestore.pct}%: the tank output is back on.`); }
  const la = au.lastActed; if (cfg.autoOff && la && la.src === "auto" && la.action === "off" && !la.urgent && la.at > (st.autoOffAt ?? 0)) { st.autoOffAt = la.at; await kvSet(env, "alertState", st); await send("autoOff", `🧊 Automation switched the fridge off: ${la.reason}.`); }
  const L = lagos(), due = Number(cfg.dailyAt.slice(0, 2)) * 60 + Number(cfg.dailyAt.slice(3, 5));
  if (cfg.daily && st.dailyDate !== L.date && L.mins >= due && L.mins < due + 120) {
    st.dailyDate = L.date; await kvSet(env, "alertState", st); // marked first, so it can only ever be sent once
    await ensureLogTables(env);
    const q = "FROM datalog WHERE t>=?", from = now - 24 * 3600e3, agg = await env.DB.prepare("SELECT COUNT(*) n, MIN(json_extract(d,'$.bat_pct')) lowp, SUM(json_extract(d,'$.grid_on')=1) g1, SUM(json_extract(d,'$.grid_on')=0) g0, SUM(json_extract(d,'$.fridge_on')=1) f1, SUM(json_extract(d,'$.mode')='auto' AND json_extract(d,'$.paused')=0) au " + q).bind(from).first();
    const low = agg?.lowp != null ? await env.DB.prepare("SELECT json_extract(d,'$.local') l " + q + " AND json_extract(d,'$.bat_pct')=? LIMIT 1").bind(from, agg.lowp).first() : null, msg = dailySummary({ ...agg, lowAt: low?.l ?? null });
    if (msg) await send("daily", msg);
  }
  await kvSet(env, "alertState", st);
}

// ---------- grid check for schedules ----------
// Minutes of grid supply between two instants, from the Grid device's presence samples (each sample covers until the next, capped at 6 min
// so a stretch with no samples is "unknown", not an outage). coveredMin says how much of the window the samples actually cover.
async function gridSupply(env, fromMs, toMs) {
  const rows = (await env.DB.prepare("SELECT t,present FROM grid WHERE t>=? AND t<=? ORDER BY t").bind(fromMs - 12 * 60e3, toMs).all()).results;
  let supply = 0, covered = 0;
  rows.forEach((r, i) => {
    const nx = rows[i + 1], start = Math.max(r.t, fromMs), end = Math.min(nx?.t ?? toMs, nx && nx.present === r.present && nx.t - r.t <= 20 * 60e3 ? nx.t : r.t + 12 * 60e3, toMs);
    if (end > start) { covered += end - start; if (r.present) supply += end - start; }
  });
  return { supplyMin: Math.round(supply / 60000), coveredMin: Math.round(covered / 60000) };
}

// ---------- schedules ----------
async function runSchedules(env, plugs) {
  const schedules = await getSchedules(env), run = (await kvGet(env, "scheduleRun")) ?? {}, now = lagos();
  let changed = false;
  const A = await getAuto(env);
  for (const s of schedules) {
    if (!s.enabled || !s.days.includes(now.dow)) continue;
    const dev = plugs.find((p) => p.id === s.deviceId);
    if (dev && dev.role === "fridge" && schedulesHeld(A)) continue; // Automation, the cycle or Absolute mode is in charge of the fridge
    if (!dev || dev.online === false || dev.on == null) continue; // offline: keep retrying until the window ends
    if (run[s.id]?.date === now.date && run[s.id]?.at === s.at) continue;
    const due = Number(s.at.slice(0, 2)) * 60 + Number(s.at.slice(3, 5));
    if (now.mins < due || now.mins > due + GRACE_MIN) continue;
    // Grid check: if the Grid supplied enough power in the window just before the set time, there is no need to act today.
    const gc = s.gridCheck;
    if (gc?.enabled && plugs.some((p) => p.role === "grid")) {
      const dueMs = now.midnight + due * 60000, g = await gridSupply(env, dueMs - gc.windowMin * 60000, dueMs);
      if (g.coveredMin >= gc.windowMin * 0.5 && g.supplyMin >= gc.minSupplyMin) { // too little data to judge = run as normal
        run[s.id] = { date: now.date, at: s.at, skipped: "grid", supplyMin: g.supplyMin, windowMin: gc.windowMin }; changed = true;
        console.log(`scheduled: ${dev.name} ${s.action} skipped, grid supplied ${g.supplyMin} of ${gc.windowMin} min`);
        continue;
      }
    }
    try {
      const want = s.action === "on";
      if (dev.on !== want) { await noteCmd(env, dev.id, want, "schedule"); await sendSwitch(env, dev.id, want); }
      run[s.id] = { date: now.date, at: s.at }; changed = true;
      console.log(`scheduled: ${dev.name} switched ${s.action}`);
    } catch (e) { console.error("scheduled action failed, will retry:", e.message); }
  }
  if (changed) { await kvSet(env, "scheduleRun", run); await sleep(1500); await poll(env).catch(() => {}); }
}

// ---------- grid supply (from the device with the 'grid' role) ----------
async function gridDataCached(env, dev) { // the panel scans two weeks of rows, so it is recomputed at most every 2 minutes, however often the app asks
  if (!dev) return { demo: true };
  const c = await kvGet(env, "gridCache"), led = Boolean(dev.led);
  if (c && c.led === led && Date.now() - c.at < 120_000) return c.v;
  const v = await gridData(env, dev); await kvSet(env, "gridCache", { at: Date.now(), led, v }); return v;
}
async function gridData(env, gridDev) {
  if (!gridDev) return { demo: true };
  const now = lagos(), weekStart = shiftDate(now.date, -now.dow), prevStart = shiftDate(weekStart, -7), from = Date.parse(`${prevStart}T00:00:00${TZ_OFFSET}`);
  const rows = (await env.DB.prepare("SELECT t,present FROM grid WHERE t>=? ORDER BY t").bind(from).all()).results;
  // Two things are worked out from the rows: which minutes had a reading (known) and which of those had no grid (out). A row covers until the next one, up to 12 minutes,
  // so a stretch with no rows (phone off, agent down) is "unknown", never "power on".
  const out = {}, known = {};
  const addSeg = (target, s0, e0) => {
    for (let cur = s0; cur < e0;) {
      const L = lagos(new Date(cur)), dayEnd = L.midnight + 86400e3, segEnd = Math.min(e0, dayEnd), a = Math.floor((cur - L.midnight) / 60000), b = segEnd >= dayEnd ? 1440 : Math.floor((segEnd - L.midnight) / 60000);
      if (b > a) (target[L.date] ??= []).push([a, b]); cur = segEnd;
    }
  };
  rows.forEach((r, i) => {
    const nx = rows[i + 1], end = Math.min(nx?.t ?? Date.now(), nx && nx.present === r.present && nx.t - r.t <= 20 * 60e3 ? nx.t : r.t + 12 * 60e3); // a reading that arrives a little late (12 to 20 minutes) with the same state on both sides is not a gap
    if (end <= r.t) return;
    addSeg(known, r.t, end); if (!r.present) addSeg(out, r.t, end);
  });
  for (const t of [out, known]) for (const d of Object.keys(t)) { // merge touching intervals
    t[d].sort((a, b) => a[0] - b[0]);
    t[d] = t[d].reduce((acc, iv) => { const l = acc[acc.length - 1]; if (l && iv[0] <= l[1] + 1) l[1] = Math.max(l[1], iv[1]); else acc.push([...iv]); return acc; }, []);
  }
  const week = (start, t = out) => Array.from({ length: 7 }, (_, i) => t[shiftDate(start, i)] ?? []);
  const last = rows[rows.length - 1]; let since = last?.t ?? null;
  for (let i = rows.length - 1; i >= 0 && rows[i].present === last.present; i--) since = rows[i].t;
  return { demo: false, source: gridDev.led ? "led" : "plug", firstMs: rows[0]?.t ?? null, samples: rows.length, present: last ? last.present === 1 : null, sinceMs: since, days: { today: out[now.date] ?? [], yesterday: out[shiftDate(now.date, -1)] ?? [], dayBefore: out[shiftDate(now.date, -2)] ?? [] }, weeks: { current: week(weekStart), previous: week(prevStart) },
    known: { today: known[now.date] ?? [], yesterday: known[shiftDate(now.date, -1)] ?? [], dayBefore: known[shiftDate(now.date, -2)] ?? [] }, weeksKnown: { current: week(weekStart, known), previous: week(prevStart, known) } };
}

// ---------- battery camera ----------
const VISION_PROMPT = 'This is a photo of the front of a portable power station. Find its battery level display and read the battery percentage. Reply with ONLY a JSON object: {"percent": <integer 0-100, or null if you cannot read it clearly>, "charging": <true, false or null>, "note": "<at most 12 words, e.g. display dark, or glare over the digits>"}. Never guess: use null when unsure.';
async function readBattery(env, b64) {
  const j = await (await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": clean(env.ANTHROPIC_API_KEY), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 150, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: VISION_PROMPT }] }] }),
  })).json();
  if (j.type === "error") throw new Error(j.error?.message ?? "vision request failed");
  const m = /\{[\s\S]*\}/.exec(j.content?.[0]?.text ?? ""); if (!m) throw new Error("no reading returned");
  const o = JSON.parse(m[0]), p = Number.isInteger(o.percent) && o.percent >= 0 && o.percent <= 100 ? o.percent : null;
  return { percent: p, charging: typeof o.charging === "boolean" ? o.charging : null, note: String(o.note ?? "").slice(0, 100) };
}
async function batteryBaseline(env) {
  const b = await kvGet(env, "battery"), rj = await kvGet(env, "battReject");
  return rj && Date.now() - (rj.at ?? rj.since) < 20 * 60e3 ? rj.pct : b?.percent ?? null; // a reading is being held back: the phone should compare against that one, not the stale accepted value
}

async function ingestPhoto(env, body) {
  // One photo, or several of the same display taken a moment apart: each is read separately, and the answer is the number most of them agree on.
  const list = (Array.isArray(body.photos) ? body.photos : [body.b64]).map((p) => String(p ?? "")).slice(0, 5);
  need(list.length > 0 && list.every((p) => p.length > 1000 && p.length < 1_000_000), "Photo missing or too large");
  const now = Date.now(); let reading = null, error = null, shown = list[Math.floor(list.length / 2)];
  await env.DB.prepare("INSERT OR REPLACE INTO photos(t,b64,pct,note) VALUES(?,?,NULL,NULL)").bind(now, shown).run();
  const cur = await kvGet(env, "battery");
  await env.DB.prepare(`DELETE FROM photos WHERE t NOT IN (SELECT t FROM photos ORDER BY t DESC LIMIT ${PHOTO_KEEP}) AND t != ?`).bind(cur?.photoAt ?? 0).run();
  if (body.reading && typeof body.reading === "object") { // what the home agent read from these photos itself (no AI): shown next to the picture in the app
    const r = body.reading, pct = Number.isInteger(r.percent) && r.percent >= 0 && r.percent <= 100 ? r.percent : null;
    const note = pct != null ? `read ${pct}% on the phone${r.total > 1 ? ` · ${Math.min(Number(r.count) || 0, Number(r.total))} of ${Number(r.total)} agree` : ""}` : `couldn't read it${r.note ? ": " + String(r.note).slice(0, 80) : ""}`;
    await env.DB.prepare("UPDATE photos SET pct=?, note=? WHERE t=?").bind(pct, note, now).run();
    if (pct != null && cur?.percent === pct) await kvSet(env, "battery", { ...cur, photoAt: now }); // this photo is the one the current reading came from
  }
  if (clean(env.ANTHROPIC_API_KEY)) {
    const vs = (await kvGet(env, "visionState")) ?? {}, day = lagos().date, n = vs.date === day ? vs.n : 0;
    if (n + list.length > VISION_DAILY_CAP) error = "daily reading limit reached";
    else if (body.force || now - (vs.lastAt ?? 0) > VISION_MIN_GAP_MS) {
      await kvSet(env, "visionState", { date: day, n: n + list.length, lastAt: now });
      const settled = await Promise.allSettled(list.map((p) => readBattery(env, p)));
      const reads = settled.map((s) => (s.status === "fulfilled" ? s.value : { percent: null, charging: null, note: "" }));
      if (settled.every((s) => s.status === "rejected")) { error = settled[0].reason?.message ?? "could not read"; await env.DB.prepare("UPDATE photos SET note=? WHERE t=?").bind("could not read: " + String(error).slice(0, 80), now).run(); }
      else {
        const v = voteReadings(reads);
        if (v.winnerIndex >= 0 && list[v.winnerIndex] !== shown) { shown = list[v.winnerIndex]; await env.DB.prepare("UPDATE photos SET b64=? WHERE t=?").bind(shown, now).run(); } // keep a photo that matches the answer
        const votes = `${v.count} of ${v.total}`, note = v.agreed ? v.note : `photos disagreed (${v.values.join(", ") || "none readable"})`;
        reading = { percent: v.percent, charging: v.charging, note, votes, agreed: v.agreed };
        await env.DB.prepare("UPDATE photos SET pct=?, note=? WHERE t=?").bind(v.percent, `${note}${v.total > 1 ? ` · ${votes} agree` : ""}`.slice(0, 120), now).run();
        if (v.agreed) { await kvSet(env, "battery", { percent: v.percent, charging: v.charging, note, at: now, votes: v.total > 1 ? votes : null }); await env.DB.prepare("INSERT OR REPLACE INTO battery(t,pct) VALUES(?,?)").bind(now, v.percent).run(); }
        // not agreed: the previous reading stays, rather than guessing from disagreeing photos
      }
    }
  }
  return { ok: true, t: now, reading, error, vision: Boolean(clean(env.ANTHROPIC_API_KEY)) };
}

// ---------- auth: verify the Firebase ID token ----------
let jwks = null, jwksAt = 0;
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function verifyUser(req, env) {
  if (env.DEV_NO_AUTH === "1") return true;
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), [h, p, s] = tok.split(".");
  if (!s) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64(h))), payload = JSON.parse(new TextDecoder().decode(b64(p)));
    if (header.alg !== "RS256") return false;
    if (!jwks || Date.now() - jwksAt > 3600e3) { jwks = (await (await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")).json()).keys; jwksAt = Date.now(); }
    const jwk = jwks.find((k) => k.kid === header.kid); if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(s), enc.encode(`${h}.${p}`)))) return false;
    const now = Date.now() / 1000, allowed = env.ALLOWED_EMAILS.split(",").map((x) => x.trim().toLowerCase());
    return payload.iss === `https://securetoken.google.com/${env.FIREBASE_PROJECT}` && payload.aud === env.FIREBASE_PROJECT && payload.exp > now && payload.iat <= now + 60
      && payload.email_verified === true && allowed.includes(String(payload.email).toLowerCase());
  } catch { return false; }
}
const verifyAgent = (req, env) => Boolean(clean(env.INGEST_KEY)) && req.headers.get("x-ingest-key") === clean(env.INGEST_KEY);

// ---------- http ----------
function cors(req, env) {
  const origin = req.headers.get("origin") ?? "";
  const ok = env.ALLOWED_ORIGINS.split(",").includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,content-type,x-ingest-key", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", Vary: "Origin" } : {};
}
const reply = (req, env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(req, env) } });
class Bad extends Error {}
const need = (cond, msg) => { if (!cond) throw new Bad(msg); };

// Bucketed history is cached briefly, so many open tabs (or a long range) don't re-read thousands of rows each time.
async function bucketHistory(env, hours) {
  const ttl = hours <= 1 ? 60_000 : hours <= 6 ? 180_000 : 600_000, key = `hist:${hours}`, cached = await kvGet(env, key);
  if (cached && Date.now() - cached.at < ttl) return cached.data;
  const now = Date.now(), from = now - hours * 3600e3, n = 240, step = (hours * 3600e3) / n;
  const devs = (await getDevices(env)).filter((d) => d.role !== "grid");
  const series = Object.fromEntries(devs.map((d) => [d.id, Array(n).fill(null)]));
  const { results } = await env.DB.prepare("SELECT t,id,w FROM samples WHERE t>=? ORDER BY t").bind(from).all();
  for (const r of results) {
    const s = series[r.id]; if (!s || r.w == null) continue;
    const i = Math.min(n - 1, Math.floor((r.t - from) / step));
    s[i] = Math.max(s[i] ?? 0, r.w);
  }
  const data = { from, to: now, n, series };
  await kvSet(env, key, { at: now, data });
  return data;
}

// The battery's percentage over time, cached briefly. 7 days are averaged into 30-minute points so the chart stays light.
async function batteryHistory(env, hours) {
  const ttl = hours <= 6 ? 60_000 : hours <= 24 ? 120_000 : 600_000, key = `bh:${hours}`, cached = await kvGet(env, key);
  if (cached && Date.now() - cached.at < ttl) return cached.data;
  const now = Date.now(), from = now - hours * 3600e3, rows = (await env.DB.prepare("SELECT t,pct FROM battery WHERE t>=? ORDER BY t").bind(from).all()).results;
  let points = rows.map((r) => [r.t, r.pct]);
  if (hours > 24) { const step = 30 * 60e3, b = {}; for (const r of rows) { const k = Math.floor(r.t / step); (b[k] ??= []).push(r.pct); } points = Object.entries(b).map(([k, v]) => [Number(k) * step + step / 2, Math.round(v.reduce((a, x) => a + x, 0) / v.length)]); }
  const data = { from, to: now, hours, points }; await kvSet(env, key, { at: now, data }); return data;
}

async function autoForApp(env) {
  const A = await getAuto(env), st = (await kvGet(env, "autoState")) ?? {}, recent = (await kvGet(env, "autoRecent")) ?? [];
  return { mode: A.mode, manualUntil: A.mode === "manual" ? A.manualUntil : null, weak: A.weak, weakSince: A.weakSince, dayThrottle: A.dayThrottle, daySince: A.daySince, cfg: A.cfg, status: st.status ?? null, recent: recent.slice(0, 8) };
}

async function stateResponse(env, { force = false } = {}) {
  let st = await kvGet(env, "state");
  if (force || !st || Date.now() - (st.cloud?.at ?? 0) > FRESH_MS) { try { await poll(env, { forceList: force }); } catch {} st = await kvGet(env, "state"); }
  const devices = await getDevices(env), tl = (await kvGet(env, "tuyaList")) ?? { at: 0, list: [] }, now = lagos();
  // Merge the latest name/role/icon from the table, so edits show immediately even before the next poll.
  const plugs = devices.map((d) => ({ online: null, on: null, hasPower: false, watts: null, volts: null, amps: null, ...(st?.plugs?.find((p) => p.id === d.id) ?? {}), id: d.id, name: d.name, role: d.role, icon: d.icon }));
  const known = await allDeviceIds(env), run = (await kvGet(env, "scheduleRun")) ?? {};
  const A0 = await getAuto(env), autoHolds = new Set(schedulesHeld(A0) ? devices.filter((d) => d.role === "fridge").map((d) => d.id) : []);
  const schedules = (await getSchedules(env)).map((s) => {
    const r = run[s.id]?.date === now.date && run[s.id]?.at === s.at ? run[s.id] : null;
    return { ...s, heldByAuto: autoHolds.has(s.deviceId), lastDone: r && !r.skipped ? now.date : null, skipped: r?.skipped ? { supplyMin: r.supplyMin, windowMin: r.windowMin } : null };
  });
  const settings = await getSettings(env), live = await kvGet(env, "live"), acfg = await getAgentCfg(env);
  const lastPhoto = await env.DB.prepare("SELECT t,pct,note FROM photos ORDER BY t DESC LIMIT 1").first(), lastSnap = await env.DB.prepare("SELECT t FROM snaps ORDER BY t DESC LIMIT 1").first();
  return {
    limits: { limit: settings.limit, warn: settings.warn }, cloud: st?.cloud ?? { ok: false, at: null, error: "No data yet" }, plugs,
    totals: { load: null, peakToday: 0, houseKwhToday: 0, fridgeKwhToday: 0, fridgeOnPct6h: null, ...(st?.totals ?? {}) },
    schedules, today: now.date, weekday: now.dow, tuyaAt: tl.at,
    discovered: tl.list.filter((d) => !known.has(d.id)), removed: (await getDevices(env, "removed")).map((d) => ({ id: d.id, name: d.name, role: d.role, icon: d.icon })),
    grid: await gridDataCached(env, devices.find((d) => d.role === "grid") ?? ((await kvGet(env, "gridLight"))?.at > Date.now() - 30 * 60e3 ? { name: "the socket light", led: true } : null)), router: (await kvGet(env, "router")) ?? {},
    agent: { at: live?.at ?? null, live: Boolean(live) && Date.now() - live.at < LIVE_FRESH_MS, photoEveryMin: acfg.photoEveryMin, liveSec: acfg.liveSec, photoNowAt: acfg.photoNowAt, snapNowAt: acfg.snapNowAt, lastSnapAt: lastSnap?.t ?? null, lastPhotoAt: lastPhoto?.t ?? null, lastPhotoPct: lastPhoto?.pct ?? null, lastPhotoNote: lastPhoto?.note ?? null, vision: Boolean(clean(env.ANTHROPIC_API_KEY)) },
    auto: await autoForApp(env),
    alerts: { cfg: await getAlerts(env), configured: Boolean(clean(env.TELEGRAM_TOKEN) && clean(env.TELEGRAM_CHAT)) },
    battery: (await kvGet(env, "battery")) ?? null,
    phone: (await kvGet(env, "phone")) ?? null,
    camera: (await kvGet(env, "camera")) ?? null,
    gridLight: (await kvGet(env, "gridLight")) ?? null,
  };
}

async function handlePost(req, env, path, body) {
  switch (path) {
    case "/api/switch": {
      const dev = (await getDevices(env)).find((d) => d.id === body.id);
      need(dev && typeof body.on === "boolean", "bad request");
      const sw = await sendSwitch(env, dev.id, body.on, { local: true }); await sleep(sw?.via === "phone" ? 3500 : 1500); await poll(env).catch(() => {});
      return { ok: true };
    }
    case "/api/settings": {
      const limit = Math.round(Number(body.limit)), warn = Math.round(Number(body.warn));
      need(limit >= 100 && limit <= 5000 && warn >= 50 && warn < limit, "Target must be above 50 W and below the limit, and the limit between 100 and 5000 W");
      await kvSet(env, "settings", { limit, warn }); return { ok: true };
    }
    case "/api/device/save": { // edit an existing device, or add a newly discovered / restored one
      const name = String(body.name ?? "").trim().slice(0, 40), id = String(body.id ?? "");
      need(name && id, "A name is required"); need(ROLES.includes(body.role), "Unknown type"); need(ICONS.includes(body.icon), "Unknown icon");
      const existing = await env.DB.prepare("SELECT * FROM devices WHERE id=?").bind(id).first();
      if (!existing) { // must be a real device on the account
        const tl = (await kvGet(env, "tuyaList")) ?? { list: [] };
        need(tl.list.some((d) => d.id === id), "That device isn't on your Smart Life account");
      }
      if (UNIQUE_ROLES.includes(body.role)) await env.DB.prepare("UPDATE devices SET role='appliance' WHERE role=? AND id<>?").bind(body.role, id).run();
      const sort = existing?.sort ?? ((await env.DB.prepare("SELECT COALESCE(MAX(sort),0)+1 AS n FROM devices").first()).n);
      await env.DB.prepare("INSERT INTO devices(id,name,role,icon,status,sort,added) VALUES(?,?,?,?, 'active',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, icon=excluded.icon, status='active'")
        .bind(id, name, body.role, body.icon, sort, Date.now()).run();
      await poll(env).catch(() => {});
      return { ok: true };
    }
    case "/api/device/remove": {
      need(body.id, "bad request");
      await env.DB.prepare("UPDATE devices SET status='removed' WHERE id=?").bind(body.id).run();
      const sched = (await getSchedules(env)).filter((s) => s.deviceId !== body.id); await kvSet(env, "schedules", sched); // its schedules go with it
      await poll(env).catch(() => {}); return { ok: true };
    }
    case "/api/schedule/save": {
      const dev = (await getDevices(env)).find((d) => d.id === body.deviceId);
      need(dev, "Pick a device"); need(["on", "off"].includes(body.action), "Pick on or off");
      need(/^([01]\d|2[0-3]):[0-5]\d$/.test(body.at ?? ""), "Pick a time");
      const days = [...new Set((body.days ?? []).map(Number))].filter((d) => d >= 0 && d <= 6).sort(); need(days.length, "Pick at least one day");
      const list = await getSchedules(env), id = body.id && list.some((s) => s.id === body.id) ? body.id : "s-" + Date.now().toString(36);
      let gridCheck;
      if (body.gridCheck && typeof body.gridCheck === "object") {
        const w = Math.round(Number(body.gridCheck.windowMin ?? 120)), m = Math.round(Number(body.gridCheck.minSupplyMin ?? 60));
        need(w >= 10 && w <= 720, "Look-back must be between 10 and 720 minutes"); need(m >= 1 && m <= w, "The grid minutes must be between 1 and the look-back time");
        gridCheck = { enabled: body.gridCheck.enabled === true, windowMin: w, minSupplyMin: m };
      }
      const next = { id, deviceId: dev.id, action: body.action, at: body.at, days, enabled: body.enabled !== false, gridCheck };
      await kvSet(env, "schedules", list.some((s) => s.id === id) ? list.map((s) => (s.id === id ? next : s)) : [...list, next]);
      return { ok: true, id };
    }
    case "/api/schedule/delete": { await kvSet(env, "schedules", (await getSchedules(env)).filter((s) => s.id !== body.id)); return { ok: true }; }
    case "/api/auto/weak": { // the Weak night switch
      const A = await getAuto(env), on = body.on === true; A.weak = on; A.weakSince = on ? Date.now() : null; await saveAuto(env, A);
      const st = (await kvGet(env, "autoState")) ?? {}; st.anchor = Date.now(); await kvSet(env, "autoState", st); // the rhythm starts again with a rest
      await logEvent(env, "mode", on ? `Weak night turned on: fridge ${A.cfg.weak.onMin} min on, ${A.cfg.weak.offMin} off, ends itself at ${A.cfg.weak.endAt}%` : "Weak night turned off");
      return { ok: true };
    }
    case "/api/auto/day": { // the Day throttle switch
      const A = await getAuto(env), on = body.on === true; A.dayThrottle = on; A.daySince = on ? Date.now() : null; await saveAuto(env, A);
      const st = (await kvGet(env, "autoState")) ?? {}; st.anchor = Date.now(); await kvSet(env, "autoState", st); // the rhythm starts from now
      await logEvent(env, "mode", on ? `Day throttle turned on: in the daytime the fridge runs ${A.cfg.dayThrottle.onMin} min on, ${A.cfg.dayThrottle.offMin} off until the night plan starts` : "Day throttle turned off");
      return { ok: true };
    }
    case "/api/auto/save": { // the mode and/or the numbers
      const A = await getAuto(env), before = A.mode;
      if (body.mode != null) { need(["auto", "manual", "absolute"].includes(body.mode), "Pick Automatic, Manual or Absolute"); A.mode = body.mode; A.manualUntil = body.mode === "manual" ? Date.now() + A.cfg.manualH * 3600e3 : null; }
      if (body.cfg) { try { A.cfg = cleanAuto(body.cfg, A.cfg); } catch (e) { throw new Bad(e.message); } }
      await saveAuto(env, A);
      if (body.restart) await logEvent(env, "settings", "Day throttle level changed: the rhythm restarted with a rest");
      else if (body.mode != null && body.mode !== before) await logEvent(env, "mode", { auto: "Switched to Automatic: it now runs the fridge, whatever you press", manual: `Switched to Manual for ${fmtH(A.cfg.manualH * 3600e3)}: the fridge rules still apply, the fan and light are left alone, then back to Automatic`, absolute: "Switched to Absolute: the fridge rules still apply, the fan and light are left alone, with no time limit" }[body.mode]);
      if (body.restart) { const st = (await kvGet(env, "autoState")) ?? {}, t = Date.now(); st.anchor = t; await kvSet(env, "autoState", st); if (A.dayThrottle) { A.daySince = t; await saveAuto(env, A); } } // the rhythm starts again with a rest
      else if (body.cfg) await logEvent(env, "settings", "Automation settings changed");
      return { ok: true };
    }
    case "/api/alerts/save": { try { await kvSet(env, "alerts", cleanAlerts(body.cfg ?? {}, await getAlerts(env))); } catch (e) { throw new Bad(e.message); } return { ok: true }; }
    case "/api/alerts/test": { try { await sendTelegram(env, "✅ Tenergy alerts are working. You'll get messages here when something needs attention."); } catch (e) { throw new Bad(e.message); } return { ok: true }; }
    case "/api/devices/refresh": { const list = await refreshTuyaList(env); await poll(env, { forceList: false }).catch(() => {}); return { ok: true, found: list.length }; }
    case "/api/agent/settings": { // how often the home agent takes photos and reports
      const photoEveryMin = Math.round(Number(body.photoEveryMin)), liveSec = Math.round(Number(body.liveSec ?? DEFAULT_AGENT.liveSec));
      need(photoEveryMin >= 1 && photoEveryMin <= 240, "Photo interval must be 1 to 240 minutes"); need(liveSec >= 5 && liveSec <= 120, "Reading interval must be 5 to 120 seconds");
      await kvSet(env, "agent", { ...(await getAgentCfg(env)), photoEveryMin, liveSec }); return { ok: true };
    }
    case "/api/agent/photo-now": { await kvSet(env, "agent", { ...(await getAgentCfg(env)), photoNowAt: Date.now() }); return { ok: true }; }
    case "/api/view/now": { await kvSet(env, "agent", { ...(await getAgentCfg(env)), snapNowAt: Date.now() }); return { ok: true }; }
  }
  return null;
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, env) });

  // The agent keeps one request open here: it returns the moment a "Read now" or "Look now" is pressed (or after ~20 s with nothing), so the agent reacts in about a second instead of waiting for its next report.
  if (req.method === "GET" && url.pathname === "/api/agent/wait") {
    if (!verifyAgent(req, env)) return reply(req, env, { error: "no" }, 401);
    const snap = Number(url.searchParams.get("snap") || 0), photo = Number(url.searchParams.get("photo") || 0), cmdSince = Number(url.searchParams.get("cmd") || 0);
    for (let i = 0; i < 10; i++) {
      const c = await getAgentCfg(env);
      const hc = ((await kvGet(env, "hubCmds")) ?? []).filter((x) => x.at > cmdSince && Date.now() - x.at < 3 * 60e3);
      if (c.snapNowAt > snap || c.photoNowAt > photo || hc.length) return reply(req, env, { changed: true, snapNowAt: c.snapNowAt, photoNowAt: c.photoNowAt, commands: hc });
      await new Promise((r) => setTimeout(r, 2000));
    }
    return reply(req, env, { changed: false });
  }

  // What the phone needs to carry on the fridge and tank rules by itself if it cannot reach this Worker for a while.
  if (req.method === "GET" && url.pathname === "/api/hub/plan") {
    if (!verifyAgent(req, env)) return reply(req, env, { error: "no" }, 401);
    await ensureSeed(env);
    const A = await getAuto(env), st = (await kvGet(env, "autoState")) ?? {}, settings = await getSettings(env), devs = await getDevices(env);
    const hold = st.hold && A.mode !== "auto" ? { on: Boolean(st.hold.on), until: st.hold.until ?? null, mode: st.hold.mode } : null;
    return reply(req, env, { at: Date.now(), cfg: A.cfg, mode: A.mode, weak: A.weak, weakSince: A.weakSince, dayThrottle: A.dayThrottle, daySince: A.daySince, anchor: st.anchor ?? 0, anchorAt: st.anchorAt ?? st.anchor ?? 0, fridgeOn: st.seenOn ?? null, fridgeSince: st.onSince ?? st.offSince ?? null, emOff: Boolean(st.emOff), hold, limit: settings.limit, fridgeId: devs.find((d) => d.role === "fridge")?.id ?? null, tankId: devs.find((d) => d.role === "tank")?.id ?? null });
  }
  // The phone reports what it did on its own while it could not reach us, so the log is complete and a switch it made is not mistaken for a press.
  if (req.method === "POST" && url.pathname === "/api/hub/failover") {
    if (!verifyAgent(req, env)) return reply(req, env, { error: "no" }, 401);
    await ensureSeed(env);
    const body = JSON.parse(await req.text()), list = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
    for (const e of list) await logEvent(env, "failover", String(e.text ?? "").slice(0, 300), { at: Number(e.at) || null });
    const last = [...list].reverse().find((e) => e.fridgeOn != null);
    if (last && Date.now() - Number(last.at) < 6 * 60e3) { const st = (await kvGet(env, "autoState")) ?? {}, fr = (await getDevices(env)).find((d) => d.role === "fridge"); if (fr) { st.cmd = { id: fr.id, on: Boolean(last.fridgeOn), at: Number(last.at), src: "cycle" }; await kvSet(env, "autoState", st); } }
    return reply(req, env, { ok: true });
  }

  // ----- the home agent (shared key, not a Google sign-in) -----
  if (req.method === "POST" && ["/api/router", "/api/readings", "/api/battery/photo", "/api/battery/reading", "/api/grid/light", "/api/view/snap", "/api/hub/status"].includes(url.pathname)) {
    if (!verifyAgent(req, env)) return reply(req, env, { error: "no" }, 401);
    await ensureSeed(env);
    if (url.pathname === "/api/battery/photo" && (req.headers.get("content-type") ?? "").startsWith("image/")) {
      // A plain JPEG upload, so automation apps (Tasker, MacroDroid, HTTP Shortcuts) can send a photo without building JSON.
      const buf = new Uint8Array(await req.arrayBuffer()); need(buf.length > 1000 && buf.length < 1_200_000, "Photo missing or too large");
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return reply(req, env, await ingestPhoto(env, { b64: btoa(bin), force: req.headers.get("x-force") === "1" }));
    }
    const raw = await req.text(); need(raw.length < 1_800_000, "too big"); const body = JSON.parse(raw);
    if (url.pathname === "/api/grid/light") { // the agent looked at the red light on the wall socket: lit = the grid is supplying it
      const now = Date.now(), before = await kvGet(env, "gridLight"), on = Boolean(body.on), write = !before || before.on !== on || now - (before.wrote ?? 0) > 10 * 60e3;
      await kvSet(env, "gridLight", { on, score: num(body.score), at: now, wrote: write ? now : before.wrote });
      if (write && !(await getDevices(env, "active")).some((d) => d.role === "grid")) await env.DB.prepare("INSERT OR REPLACE INTO grid(t,present) VALUES(?,?)").bind(now, on ? 1 : 0).run().then(() => kvSet(env, "gridCache", null)); // a real Grid switch, once added, takes over; a row only on a change or every 10 minutes
      return reply(req, env, { ok: true });
    }
    if (url.pathname === "/api/battery/reading") { // the agent read the display itself (no AI involved): just record the number
      const pct = Number(body.percent); need(Number.isInteger(pct) && pct >= 0 && pct <= 100, "percent must be 0-100");
      const now = Date.now(), votes = body.total > 1 ? `${Math.min(Number(body.count) || 0, Number(body.total))} of ${Number(body.total)}` : null;
      const prev = await kvGet(env, "battery"); // keep pointing at the same photo while the number hasn't changed
      // A reading that jumps further than the battery could really move is a misread, not news (the display once showed 11 and was read as 0). The tank charges much faster than it drains
      // (about 1 % a minute when the grid is charging it), so rises are allowed more room. A held reading is believed once the next one agrees with it, or the same number returns 30 minutes later.
      if (prev?.percent != null && now - prev.at < 40 * 60e3) {
        const room = (mins, up) => 6 + mins * (up ? 1.3 : 0.4), rj = await kvGet(env, "battReject");
        if (Math.abs(pct - prev.percent) > room((now - prev.at) / 60000, pct > prev.percent)) {
          const held = rj ? rj.at ?? rj.since : 0, agrees = rj && Math.abs(pct - rj.pct) <= room((now - held) / 60000, pct > rj.pct) && now - held < 20 * 60e3;
          if (!(agrees || (rj && rj.pct === pct && now - rj.since >= 30 * 60e3))) { await kvSet(env, "battReject", { pct, at: now, since: rj && rj.pct === pct ? rj.since : now }); return reply(req, env, { ok: true, rejected: true, t: now }); }
          await kvSet(env, "battReject", null); // believed
        } else if (rj) await kvSet(env, "battReject", null);
      }
      const rising = prev?.percent != null && pct > prev.percent && now - prev.at < 30 * 60e3, falling = prev?.percent != null && pct < prev.percent;
      const chargingAt = falling ? null : body.charging === true || rising ? now : prev?.chargingAt ?? null; // the last time there was a sign of charging: the number blinked, or the percentage went up
      await kvSet(env, "battery", { percent: pct, charging: chargingAt != null && now - chargingAt < 15 * 60e3, chargingAt, note: "read on the phone", at: now, votes, photoAt: prev?.percent === pct ? prev.photoAt ?? null : null });
      await env.DB.prepare("INSERT OR REPLACE INTO battery(t,pct) VALUES(?,?)").bind(now, pct).run();
      return reply(req, env, { ok: true, t: now });
    }
    if (url.pathname === "/api/hub/status") { const c = body; await kvSet(env, "camera", { ok: Boolean(c.ok), front: false, torch: Boolean(c.torch), shotAt: num(c.shotAt), at: Date.now(), source: "hub", note: String(c.note ?? "").slice(0, 160), version: String(c.version ?? "").slice(0, 24), failover: Boolean(c.failover) }); return reply(req, env, { ok: true }); } // the Android hub app says whether its own camera works
    if (url.pathname === "/api/router") { await kvSet(env, "router", { ...body, receivedAt: Date.now() }); return reply(req, env, { ok: true }); }
    if (url.pathname === "/api/readings") {
      const devs = await getDevices(env), live = { at: Date.now(), devices: {} };
      for (const r of body.devices ?? []) if (devs.some((d) => d.id === r.id)) live.devices[r.id] = r.unreachable ? { unreachable: true, on: null, watts: null, volts: null, amps: null, kwh: null, lastSeenAt: num(r.lastSeenAt), lastWatts: num(r.lastWatts) } : { on: typeof r.on === "boolean" ? r.on : null, watts: num(r.watts), volts: num(r.volts), amps: num(r.amps), kwh: num(r.kwh), timer: num(r.timer) };
      await kvSet(env, "live", live);
      if (body.camera && typeof body.camera === "object") { const c = body.camera; await kvSet(env, "camera", { ok: Boolean(c.ok), front: Boolean(c.front), torch: Boolean(c.torch), shotAt: num(c.lastShotAt), at: Date.now() }); } // is the phone's camera server (IP Webcam) answering?
      if (body.phone && typeof body.phone === "object") { const p = body.phone, pct = Math.round(Number(p.percent)); if (pct >= 0 && pct <= 100) await kvSet(env, "phone", { percent: pct, status: String(p.status ?? "").slice(0, 20), plugged: String(p.plugged ?? "").slice(0, 20), temp: num(p.temp), health: String(p.health ?? "").slice(0, 20), at: Date.now() }); }
      let cmds = ((await kvGet(env, "hubCmds")) ?? []); const nowC = Date.now();
      if (Array.isArray(body.acks) && body.acks.length) { cmds = cmds.filter((c) => !body.acks.includes(c.at)); await kvSet(env, "hubCmds", cmds); }
      cmds = cmds.filter((c) => nowC - c.at < 3 * 60e3);
      await poll(env).catch(() => {});
      ctx?.waitUntil?.(runDueJob(env)); // after the reply: the automation, alerts or data log, whichever is due
      const c = await getAgentCfg(env);
      return reply(req, env, { ok: true, liveSec: c.liveSec, photoEveryMin: c.photoEveryMin, photoNowAt: c.photoNowAt, snapNowAt: c.snapNowAt, batteryPct: await batteryBaseline(env), commands: cmds });
    }
    if (url.pathname === "/api/view/snap") { // a home-view picture from the selfie camera
      const b = String(body.b64 ?? ""); need(b.length > 1000 && b.length < 1_000_000, "Photo missing or too large");
      const t = Date.now();
      await env.DB.prepare("INSERT OR REPLACE INTO snaps(t,b64) VALUES(?,?)").bind(t, b).run();
      await env.DB.prepare(`DELETE FROM snaps WHERE t NOT IN (SELECT t FROM snaps ORDER BY t DESC LIMIT ${SNAP_KEEP})`).run();
      return reply(req, env, { ok: true, t });
    }
    return reply(req, env, await ingestPhoto(env, body));
  }

  if (!(await verifyUser(req, env))) return reply(req, env, { error: "Not signed in" }, 401);
  await ensureSeed(env);
  if (env.DEV_NO_AUTH === "1" && url.pathname === "/api/_dev/gridsupply") { // local testing only: DEV_NO_AUTH is never set in production
    const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
    return reply(req, env, await gridSupply(env, from, to));
  }
  if (url.pathname === "/api/state") return reply(req, env, await stateResponse(env, { force: url.searchParams.get("force") === "1" }));
  if (url.pathname === "/api/log/export") { // the whole record, for analysis: ?table=datalog|events&days=7&fmt=csv|json
    const days = Math.min(LOG_KEEP_DAYS, Math.max(1, Number(url.searchParams.get("days")) || 7)), table = url.searchParams.get("table") === "events" ? "events" : "datalog", fmt = url.searchParams.get("fmt") === "json" ? "json" : "csv";
    const out = await exportLog(env, table, days, fmt);
    return fmt === "json" ? reply(req, env, { rows: out }) : new Response(out, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...cors(req, env) } });
  }
  if (url.pathname === "/api/battery/history") { const h = Number(url.searchParams.get("hours")); return reply(req, env, await batteryHistory(env, [6, 24, 168].includes(h) ? h : 24)); }
  if (url.pathname === "/api/history") return reply(req, env, await bucketHistory(env, Math.min(24, Number(url.searchParams.get("hours") ?? 6))));
  if (url.pathname === "/api/view/snaps") return reply(req, env, { snaps: (await env.DB.prepare("SELECT t FROM snaps ORDER BY t DESC LIMIT 6").all()).results });
  if (url.pathname === "/api/view/snap") {
    const t = Number(url.searchParams.get("t")), row = t ? await env.DB.prepare("SELECT b64 FROM snaps WHERE t=?").bind(t).first() : await env.DB.prepare("SELECT b64 FROM snaps ORDER BY t DESC LIMIT 1").first();
    if (!row) return reply(req, env, { error: "no picture" }, 404);
    return new Response(Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=300", ...cors(req, env) } });
  }
  if (url.pathname === "/api/battery/photos") return reply(req, env, { photos: (await env.DB.prepare("SELECT t,pct,note FROM photos ORDER BY t DESC LIMIT 8").all()).results });
  if (url.pathname === "/api/battery/photo") { // the picture itself, as a JPEG
    const t = Number(url.searchParams.get("t")), row = t ? await env.DB.prepare("SELECT b64 FROM photos WHERE t=?").bind(t).first() : await env.DB.prepare("SELECT b64 FROM photos ORDER BY t DESC LIMIT 1").first();
    if (!row) return reply(req, env, { error: "no photo" }, 404);
    return new Response(Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=300", ...cors(req, env) } });
  }
  if (req.method === "POST") {
    const out = await handlePost(req, env, url.pathname, await req.json().catch(() => ({})));
    if (out) return reply(req, env, out);
  }
  return reply(req, env, { error: "not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { return reply(req, env, { error: e.message }, e instanceof Bad ? 400 : 500); }
  },
  // Four timers, each in its own invocation because the free plan allows only 10 ms of CPU per run.
  async scheduled(event, env) {
    const run = async (name, fn) => { try { await fn(); } catch (e) { console.error(name + " failed:", e.message); } };
    switch (event.cron) {
      case "1-59/2 * * * *": return run("automation", () => autoTick(env));
      case "0-58/2 * * * *": return run("alerts", () => alertsTick(env));
      case "2-58/2 * * * *": return run("data log", () => dataLogTick(env));
      default: { // "*/2 * * * *": read the plugs, run the schedules, tidy old rows once an hour
        const live = await kvGet(env, "live"); if (!live || Date.now() - live.at > LIVE_FRESH_MS) await run("job", () => runDueJob(env)); // the home agent is not reporting, so nothing else is driving the automation and the alerts (the "agent offline" alert must still fire)
        const plugs = await poll(env);
        await run("schedules", () => runSchedules(env, plugs));
        if (lagos().mins % 60 < 2) { const old = Date.now() - 15 * 24 * 3600e3, logOld = Date.now() - LOG_KEEP_DAYS * 86400e3; await run("tidy", () => env.DB.batch([env.DB.prepare("DELETE FROM samples WHERE t<?").bind(old), env.DB.prepare("DELETE FROM grid WHERE t<?").bind(old), env.DB.prepare("DELETE FROM battery WHERE t<?").bind(Date.now() - 90 * 24 * 3600e3), env.DB.prepare("DELETE FROM datalog WHERE t<?").bind(logOld), env.DB.prepare("DELETE FROM events WHERE t<?").bind(logOld)])); }
      }
    }
  },
};
