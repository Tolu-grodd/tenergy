// The fridge automation: pure functions that look at the situation and say what the fridge (and, at the very end, the tank output) should do.
// Nothing here touches the network or the database, so every rule can be tested with plain numbers. Every number is a setting.
//
// Automatic, in one paragraph: the grid on = fridge on. No grid, from sunset to morning = the fridge runs a rhythm (45 min on, 60 off) so it stays cold while the battery lasts.
// No grid in the daytime = fridge on (the sun is charging). At 15 % the fridge stops; at 10 % the tank output is cut so the tank never runs empty.

export const DEFAULT_AUTO = {
  emergency: 15, // battery %, no grid: the fridge switches off and stays off until the battery is 4 points above this
  cutOn: true, cutAt: 10, restoreAt: 30, cutBackAt: "08:00", cutBackDayMin: 90, // after a cut the plug's own timer brings the output back at this time (or this many minutes later if the cut is in the daytime), even with no Wi-Fi // at cutAt the tank output plug is switched off (the tank can only be restarted by hand when it runs empty); it comes back on at restoreAt
  night: { from: "17:30", to: "08:00", onMin: 45, offMin: 60, fanUntil: "00:00", offFirst: true }, // the no-grid night: the fridge rhythm, and when the fan should be off (a reminder, until there is a switch for it)
  weak: { onMin: 60, offMin: 120, endAt: 80 }, // "Weak night" (a switch in the app): a thinner fridge rhythm for a night that starts low; it switches itself off once the battery reaches endAt
  dayThrottle: { onMin: 90, offMin: 30 }, // "Day throttle" (a switch in the app): in the daytime with no grid the fridge runs this rhythm instead of staying on, so the tank can charge; it switches itself off when the night plan starts
  gridOnFridgeOn: true, overloadShed: true, staleMin: 20,
  manualH: 2, // Manual (the fan and light are left alone) lasts this many hours, then it is Automatic again
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function mergeAuto(saved) {
  const o = { ...DEFAULT_AUTO };
  for (const k of Object.keys(DEFAULT_AUTO)) if (k !== "night" && k !== "weak" && k !== "dayThrottle" && saved?.[k] !== undefined) o[k] = saved[k];
  o.night = { ...DEFAULT_AUTO.night, ...(saved?.night ?? {}) };
  o.weak = { ...DEFAULT_AUTO.weak, ...(saved?.weak ?? {}) };
  o.dayThrottle = { ...DEFAULT_AUTO.dayThrottle, ...(saved?.dayThrottle ?? {}) };
  return o;
}

// Check what the app sent; returns the cleaned settings or throws a message that is shown to the person.
export function cleanAuto(inp, cur) {
  const c = mergeAuto({ ...cur, ...inp, night: { ...cur.night, ...(inp.night ?? {}) }, weak: { ...cur.weak, ...(inp.weak ?? {}) }, dayThrottle: { ...cur.dayThrottle, ...(inp.dayThrottle ?? {}) } });
  for (const k of ["emergency", "cutAt", "restoreAt", "staleMin", "manualH"]) { c[k] = Number(c[k]); if (!Number.isFinite(c[k])) throw new Error("Every number needs a value"); }
  if (c.emergency < 5 || c.emergency > 60) throw new Error("The fridge level must be between 5 and 60");
  if (c.cutAt < 2 || c.cutAt >= c.emergency) throw new Error("The cut-off level must be at least 2 and below the fridge level");
  if (c.restoreAt <= c.emergency || c.restoreAt > 95) throw new Error("The restore level must be above the fridge level and at most 95");
  if (c.manualH < 0.25 || c.manualH > 48) throw new Error("Manual must last between 0.25 and 48 hours");
  if (c.staleMin < 5 || c.staleMin > 240) throw new Error("Stale reading must be between 5 and 240 minutes");
  const n = c.night; n.onMin = Number(n.onMin); n.offMin = Number(n.offMin);
  if (!HM.test(n.from) || !HM.test(n.to) || n.from === n.to) throw new Error("Pick a start and end time for the night");
  if (!(n.onMin >= 5 && n.onMin <= 720 && n.offMin >= 5 && n.offMin <= 720)) throw new Error("On and off minutes must be between 5 and 720");
  n.offFirst = n.offFirst !== false; // the fridge has been running all day, so the night starts with its rest
  if (n.fanUntil && !HM.test(n.fanUntil)) throw new Error("Pick a time for the fan, or leave it empty"); n.fanUntil = n.fanUntil || "";
  const wk = c.weak; wk.onMin = Number(wk.onMin); wk.offMin = Number(wk.offMin); wk.endAt = Number(wk.endAt);
  if (!(wk.onMin >= 5 && wk.onMin <= 720 && wk.offMin >= 5 && wk.offMin <= 720)) throw new Error("Weak night on and off minutes must be between 5 and 720");
  if (!(wk.endAt > c.emergency + 4 && wk.endAt <= 100)) throw new Error("Weak night must end above the fridge level, at most 100");
  const dt = c.dayThrottle; dt.onMin = Number(dt.onMin); dt.offMin = Number(dt.offMin);
  if (!(dt.onMin >= 5 && dt.onMin <= 720 && dt.offMin >= 5 && dt.offMin <= 720)) throw new Error("Day throttle on and off minutes must be between 5 and 720");
  if (!HM.test(c.cutBackAt)) throw new Error("Pick a time for the output to come back after a cut");
  c.cutBackDayMin = Number(c.cutBackDayMin); if (!(c.cutBackDayMin >= 15 && c.cutBackDayMin <= 720)) throw new Error("The daytime comeback delay must be between 15 and 720 minutes");
  for (const k of ["cutOn", "gridOnFridgeOn", "overloadShed"]) c[k] = c[k] === true;
  return c;
}

const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const dayStart = (date) => Date.parse(`${date}T00:00:00+01:00`); // Lagos has no daylight saving
const shift = (date, n) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Rhythm: on for onMin, off for offMin, over and over, counted from startedAt. With offFirst the rest comes first (the fridge has been on all day).
export function cycleWant(spec, startedAt, now) {
  const on = spec.onMin * 60e3, off = spec.offMin * 60e3, tot = on + off, pos = (((now - startedAt) % tot) + tot) % tot;
  if (spec.offFirst) return pos < off ? { on: false, leftMin: Math.ceil((off - pos) / 60e3) } : { on: true, leftMin: Math.ceil((tot - pos) / 60e3) };
  return pos < on ? { on: true, leftMin: Math.ceil((on - pos) / 60e3) } : { on: false, leftMin: Math.ceil((tot - pos) / 60e3) };
}
// The stretch of the clock that contains `now`, for a window like 17:30 to 08:00 (which crosses midnight): { start, end } in ms, or null.
export function windowAt(from, to, now, today) {
  const a = hm(from), b = hm(to), len = (b > a ? b - a : b + 1440 - a) * 60e3;
  for (const n of [-1, 0]) { const start = dayStart(shift(today, n)) + a * 60e3; if (now >= start && now < start + len) return { start, end: start + len }; }
  return null;
}
// The first time after `startMs` when the clock reads hhmm.
export function nextAfter(startMs, hhmm) { const sinceMidnight = (startMs + 3600e3) % 86400e3, t = startMs - sinceMidnight + hm(hhmm) * 60e3; return t <= startMs ? t + 86400e3 : t; }

// Where the rhythm should be counted from when an event restarts it (the grid going off, Weak night ending). The old rule was always "rest first", which is right for a fridge that has been running on the
// grid for hours, but wrong for one that had been resting a long time and only got a short run on the grid. So the rhythm continues from where the fridge really is:
//   on for a full on-phase or more -> rest first;   on for less -> carry on the on-phase for what is left;
//   off for a full rest or more -> on-phase now;    off for less -> carry on resting for what is left.
// Returns the time to count the rhythm from (to be used with a rest-first rhythm). `fr`: { on }, `since`: when the fridge last changed state (ms), `spec`: { onMin, offMin }.
export function phaseAnchor(spec, fr, since, now) {
  const on = spec.onMin * 60e3, off = spec.offMin * 60e3;
  if (!fr || fr.on == null || since == null || since > now) return now; // nothing known: rest first, as before
  const run = now - since;
  if (fr.on) return run >= on ? now : now - (off + run);   // on-phase carried on / full on-phase done
  return run >= off ? now - off : now - run;               // rest carried on / rest done: on-phase starts now
}

// What the fridge switch should be doing right now. `i`: { cfg, now, today, fr, tankW, limit, pct, gridOn (true/false/null), emOff }
// Returns null when the fridge plug can't be switched, else { action: "on" | "off" | null, reason, urgent, src } — `reason` always says what the stance is, even when nothing changes.
export function autoPlan(i) {
  const { cfg, now, today, fr, tankW, limit, pct, gridOn, emOff, weak, anchor, dayThrottle } = i, anchorAt = i.anchorAt ?? anchor ?? 0; // anchor: where the rhythm is counted from; anchorAt: when that was decided
  if (!fr || fr.online === false || fr.on == null) return null;
  const out = (want, reason, o = {}) => ({ action: want === fr.on ? null : want ? "on" : "off", reason, urgent: Boolean(o.urgent), src: o.src ?? "auto", restMin: o.restMin ?? 0 });
  if (cfg.overloadShed && gridOn !== true && tankW != null && tankW > limit) return out(false, `The tank is at ${Math.round(tankW)} W, over its ${limit} W limit`, { urgent: true });
  if (gridOn === true) return cfg.gridOnFridgeOn ? out(true, "The grid is on") : { action: null, reason: "The grid is on", urgent: false, src: "auto" };
  const unk = gridOn == null ? " (grid unknown)" : ""; // the phone is not reporting: carry on with the time-based rhythm as if there were no grid, so the fridge can never get stuck off
  if (emOff) return out(false, `Battery at ${pct ?? "?"}%, at or below ${cfg.emergency}%: the fridge stays off until it recovers`, { urgent: true });
  const w = windowAt(cfg.night.from, cfg.night.to, now, today);
  if (w) { // the rhythm restarts (rest first) when the grid goes off or Weak night changes, so it counts from the later of that and the start of the night
    const c = cycleWant(weak ? { ...cfg.weak, offFirst: true } : cfg.night, anchorAt >= w.start ? (anchor ?? w.start) : w.start, now);
    return out(c.on, `${weak ? "Weak night" : "Night"} rhythm${unk}: fridge ${c.on ? "on" : "off"} for another ${c.leftMin} min`, { src: "cycle", restMin: c.on ? 0 : c.leftMin });
  }
  if (dayThrottle) { // daytime with the throttle on: the fridge cycles so the tank can charge; the rhythm counts from the later of the morning and when it was switched on (or the grid last went off)
    const morning = dayStart(today) + hm(cfg.night.to) * 60e3, c = cycleWant({ ...cfg.dayThrottle, offFirst: true }, anchorAt >= morning ? (anchor ?? morning) : morning, now); // the fridge has been on, so the throttle starts with its rest
    return out(c.on, `Day throttle${unk}: fridge ${c.on ? "on" : "off"} for another ${c.leftMin} min`, { src: "cycle", restMin: c.on ? 0 : c.leftMin });
  }
  return out(true, `Daytime${unk}: the fridge stays on`);
}

// How long the tank lasts if the rules carry on as planned: the fridge follows its rhythm (night, weak night or day throttle), so the figure does not jump every time the fridge switches.
// Walks forward a minute at a time with the plan's own rules. offW / onW: what the tank delivers with the fridge off / on (measured). No sun is assumed. Returns null when no rhythm is active now.
// { regime, cutMin, cutAt, endsAt, pctAtEnd }: cutMin = minutes until the battery reaches the cut-off (null if it does not within 36 h); endsAt / pctAtEnd = where the current rhythm period ends and the level then.
export function forecastTank(i) {
  const { cfg, now, pct, wh, offW, onW, weak, dayThrottle, anchor, anchorAt } = i;
  if (pct == null || !(wh > 0) || !(offW >= 0) || !(onW >= offW)) return null;
  const dateOf = (t) => new Date(t + 3600e3).toISOString().slice(0, 10), nightNow = windowAt(cfg.night.from, cfg.night.to, now, dateOf(now));
  const regime = weak ? "weak" : nightNow ? "night" : dayThrottle ? "day" : null;
  if (!regime) return null;
  let p = pct, endsAt = weak ? null : nightNow ? nightNow.end : null, pctAtEnd = null, cutMin = null, dt = Boolean(dayThrottle), firstNightStart = null;
  if (regime === "day") { firstNightStart = nextAfter(now, cfg.night.from); endsAt = firstNightStart; }
  for (let m = 0; m < 36 * 60; m++) {
    const t = now + m * 60e3;
    if (endsAt != null && pctAtEnd == null && t >= endsAt) pctAtEnd = Math.round(p);
    if (firstNightStart != null && t >= firstNightStart) dt = false;
    if (p <= cfg.cutAt) { cutMin = m; break; }
    const plan = autoPlan({ cfg, now: t, today: dateOf(t), fr: { online: true, on: false }, tankW: null, limit: 1e9, pct: p, gridOn: false, emOff: p <= cfg.emergency, weak, dayThrottle: dt, anchor, anchorAt });
    p -= ((plan && plan.action === "on" ? onW : offW) / 60 / wh) * 100;
  }
  if (endsAt != null && pctAtEnd == null && cutMin == null) pctAtEnd = Math.round(p);
  return { regime, cutMin, cutAt: cutMin == null ? null : now + cutMin * 60e3, endsAt, pctAtEnd: cutMin != null && endsAt != null && now + cutMin * 60e3 < endsAt ? null : pctAtEnd, offW: Math.round(offW), onW: Math.round(onW) };
}
