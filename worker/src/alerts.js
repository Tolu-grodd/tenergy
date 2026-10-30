// Telegram alerts: which conditions are worth a message, and what the message says. Pure functions, no network.

export const DEFAULT_ALERTS = {
  enabled: true,
  emergency: true, cut: true, overload: true, tankOff: true,
  fridgeOffline: true, fridgeOfflineMin: 10, fridgeStuck: true, plugMismatch: true, tuyaCloud: true,
  grid: true, autoOff: true,
  agentOffline: true, agentOfflineMin: 10, cameraDown: true,
  frost: true, weakNudge: true, readingStale: true, readingStaleMin: 25, daily: true, dailyAt: "08:00",
  weakNudgeMin: 30, // the Weak night suggestion goes out this many minutes before the night starts
  repeatMin: 60, // a condition that stays true is repeated at most this often
};
export const mergeAlerts = (saved) => ({ ...DEFAULT_ALERTS, ...(saved ?? {}) });
const FLAGS = ["enabled", "emergency", "cut", "overload", "tankOff", "fridgeOffline", "fridgeStuck", "plugMismatch", "tuyaCloud", "grid", "autoOff", "agentOffline", "cameraDown", "frost", "weakNudge", "readingStale", "daily"];
export function cleanAlerts(inp, cur) {
  const c = mergeAlerts({ ...cur, ...inp });
  for (const k of FLAGS) c[k] = c[k] === true;
  for (const [k, a, b, label] of [["fridgeOfflineMin", 1, 240, "Fridge offline minutes"], ["agentOfflineMin", 2, 240, "Home agent offline minutes"], ["repeatMin", 10, 1440, "Repeat time"]]) {
    c[k] = Number(c[k]); if (!Number.isFinite(c[k]) || c[k] < a || c[k] > b) throw new Error(`${label} must be between ${a} and ${b}`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.dailyAt)) throw new Error("Pick a time for the daily summary");
  return c;
}

// The conditions. `raw` says whether the problem exists right now; `afterMin` how long it must last before a message is sent.
// ctx: { cfg, plugs, gridOn, pct, pctAgeMin, d (the automation's decision), limit, agentAgeMin }
export function conditions(ctx) {
  const { cfg, plugs, gridOn, pct, pctAgeMin, d, limit, agentAgeMin } = ctx, active = ctx.active ?? {}, hys = (k) => (active[k] ? 3 : 0), // an alert that is already showing clears only when the battery is 3 points clear of its threshold, so it cannot flip on and off
   tank = plugs.find((p) => p.role === "tank"), fr = plugs.find((p) => p.role === "fridge");
  const battOk = pct != null && pctAgeMin != null && pctAgeMin <= 20, noGrid = gridOn !== true;
  const out = [];
  if (cfg.emergency) out.push({ key: "emergency", urgent: true, afterMin: 0, raw: noGrid && battOk && pct <= ctx.emergency + hys("emergency"), text: `🔴 Battery is at ${pct}% with no grid. The fridge is off so the fan, light and Wi-Fi last as long as possible.`, clear: "Battery is back above the emergency level" });
  if (cfg.overload) out.push({ key: "overload", urgent: true, afterMin: 0, raw: noGrid && tank?.watts != null && tank.watts > limit, text: `🔴 The power tank is supplying ${Math.round(tank?.watts ?? 0)} W, over its ${limit} W limit.`, clear: "The tank load is back within its limit" });
  // the fridge plug answering means the house has power, so a flaky tank plug is not an outage
  if (cfg.tankOff) out.push({ key: "tankOff", urgent: true, afterMin: 2, raw: Boolean(tank) && gridOn === false && (tank.online === false || tank.on === false) && fr?.online !== true, text: `🔴 The power tank output is ${tank?.online === false ? "offline" : "switched off"} and the grid is off, so the house has no power.`, clear: "The power tank output is back" });
  if (cfg.fridgeOffline) out.push({ key: "fridgeOffline", urgent: true, afterMin: cfg.fridgeOfflineMin, raw: Boolean(fr) && fr.online === false, text: tank?.online === true && tank.on === true ? `🟠 No power at the fridge socket for ${cfg.fridgeOfflineMin}+ minutes: the plug is offline while the power tank is working. The fridge is off. Check the socket and the wiring.` : `🟠 The fridge plug has been offline for ${cfg.fridgeOfflineMin}+ minutes.`, clear: "The fridge socket has power again" });
  if (cfg.plugMismatch) { const bad = plugs.filter((p) => p.cloudDisagrees); out.push({ key: "plugMismatch", urgent: false, afterMin: 0, raw: bad.length > 0, text: `🟡 The phone and Tuya's cloud disagree about ${bad.map((p) => `${p.name} (phone: ${p.on ? "on" : "off"}, cloud: ${p.cloudOn ? "on" : "off"})`).join(", ")}. Tenergy shows the phone's answer. If the real switch is different, tell me.`, clear: "The phone and Tuya's cloud agree again" }); }
  if (cfg.tuyaCloud) out.push({ key: "tuyaCloud", urgent: false, afterMin: 5, repeatMin: 24 * 60, raw: ctx.cloud?.ok === false && /28841004|quota/i.test(String(ctx.cloud?.error ?? "")), text: "🟡 Tuya's cloud is refusing requests: the free trial's call quota is used up. Tenergy keeps working through the phone (state, switching and the plug timers), but anything that needs the cloud will fail. Renew or extend the IoT Core trial on iot.tuya.com.", clear: "Tuya's cloud answers again" });
  if (cfg.fridgeStuck) out.push({ key: "fridgeStuck", urgent: true, afterMin: 6, raw: Boolean(fr) && fr.online !== false && (d?.wouldDo === "on" || d?.wouldDo === "off"), text: `🟠 The fridge should be switched ${d?.wouldDo} (${d?.reason ?? "the rules say so"}) but it has not changed for 6+ minutes, although the command keeps being sent. Check the fridge plug and its socket.`, clear: "The fridge now matches what the rules want" });
  if (cfg.cameraDown) out.push({ key: "cameraDown", urgent: true, afterMin: 10, raw: Boolean(ctx.camera) && ctx.camera.ok === false && agentAgeMin != null && agentAgeMin < 5, text: "📷 The camera server on the phone has stopped answering, so the battery and grid readings are going stale and the 15 % and 10 % protection is paused. Open IP Webcam on the phone and tap Start server.", clear: "The camera server is answering again" });
  if (cfg.readingStale) out.push({ key: "readingStale", urgent: true, afterMin: 0, raw: pctAgeMin != null && pctAgeMin > cfg.readingStaleMin && agentAgeMin != null && agentAgeMin < 5 && !(ctx.camera && ctx.camera.ok === false), text: `🟠 The tank display has not been read for ${Math.round(pctAgeMin ?? 0)} minutes although the phone is reporting. The phone may have been moved, or something is covering the display. The 15 % and 10 % protection is blind until it reads again.`, clear: "The tank display is being read again" });
  if (cfg.agentOffline) out.push({ key: "agentOffline", urgent: false, afterMin: cfg.agentOfflineMin, raw: agentAgeMin == null || agentAgeMin > cfg.agentOfflineMin, text: `🟡 The home agent (the phone) hasn't reported for ${cfg.agentOfflineMin}+ minutes, so battery and grid readings are going stale.${ctx.cloud?.ok === false && /28841004|quota/i.test(String(ctx.cloud?.error ?? "")) ? " Tuya's cloud is also unavailable (quota), so nothing can switch the plugs until the phone is back." : ""}`, clear: "The home agent is reporting again" });
  return out;
}

export const hm = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim(); };

// The 8 AM summary, from totals the database counted over the last 24 hours (each log row stands for 2 minutes).
export function dailySummary(g) {
  if (!g || g.n < 30) return null;
  const m = (rows) => hm((rows ?? 0) * 2 * 60e3);
  return [`☀️ Last 24 hours`,
    g.lowp != null ? `Battery: lowest ${g.lowp}%${g.lowAt ? " at " + g.lowAt.slice(11) : ""}` : "Battery: no readings",
    `Grid: on for ${m(g.g1)}, off for ${m(g.g0)}`,
    `Fridge: switched on for ${m(g.f1)}`,
    `Mode: Automatic for ${m(g.au)} of ${m(g.n)} recorded`].join("\n");
}

// The evening suggestion to turn Weak night on: when the night is about to start with no grid and the battery is below where Weak night would end itself.
// The times are estimates from the measured draw: about 45 W for the fan, router and phone, plus the fridge at 42 W for its share of the rhythm, and 7.8 Wh to the percent.
const ESSENTIAL_W = 45, FRIDGE_W = 42, WH_PER_PCT = 7.8;
const ratePerHour = (spec) => (ESSENTIAL_W + (FRIDGE_W * spec.onMin) / (spec.onMin + spec.offMin)) / WH_PER_PCT;
const clock = (ms) => { const d = new Date(ms + 3600e3); return d.toISOString().slice(11, 16); };
export function weakNudgeText(pct, auto, now) {
  const f = auto.night, w = auto.weak, floor = auto.emergency;
  const reach = (spec) => now + (Math.max(0, pct - floor) / ratePerHour(spec)) * 3600e3;
  return `🌗 Battery is ${pct}% and the grid is off, with the night starting at ${f.from}. At the normal night rhythm (${f.onMin} min on, ${f.offMin} off) the fridge would be stopped at ${floor}% around ${clock(reach(f))}; with Weak night (${w.onMin} on, ${w.offMin} off) around ${clock(reach(w))}. Switch Weak night on in the Solar card of the app if you want it. It ends by itself at ${w.endAt}%.`;
}
