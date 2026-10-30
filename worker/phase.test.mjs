// The rhythm restarts from where the fridge really is (not always "rest first"). Run: node phase.test.mjs
import { autoPlan, mergeAuto, phaseAnchor } from "./src/auto.js";
const cfg = mergeAuto({}), min = 60e3, night = cfg.night, today = "2026-10-21";
const at = (h, m) => Date.parse(`${today}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+01:00`);
let bad = 0; const check = (name, got, want) => { const ok = got === want; if (!ok) bad++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : `  got "${got}", wanted "${want}"`)); };
const plan = (now, fr, anchor, extra = {}) => autoPlan({ cfg, now, today, fr: { on: fr, online: true }, tankW: 50, limit: 480, pct: 60, gridOn: false, emOff: false, weak: false, dayThrottle: false, anchor, anchorAt: now, ...extra });
const when = (spec, on, sinceMinAgo, now) => phaseAnchor(spec, { on }, now - sinceMinAgo * min, now);

let now = at(19, 0);
// 1. your case: it had been resting, the grid gave it 2 minutes, then went off
let a = when(night, true, 2, now);
let p = plan(now, true, a); check("rested long, 2 min on the grid, grid off: carries on, stays ON", p.action === null && /fridge on for another 43 min/.test(p.reason), true);
// 2. the usual case: on for hours on the grid, grid goes off: rest first
a = when(night, true, 300, now); p = plan(now, true, a); check("on for hours on the grid, grid off: rests first (switch OFF)", p.action === "off" && /off for another 60 min/.test(p.reason), true);
// 3. it was on for 20 minutes when the grid went off: carries on for the remaining 25
a = when(night, true, 20, now); p = plan(now, true, a); check("on for 20 min: carries on for 25 more", /on for another 25 min/.test(p.reason), true);
// 4. off for 100 minutes (more than a full rest): starts the on-phase now
a = when(night, false, 100, now); p = plan(now, false, a); check("off for 100 min: switches ON now for the full on-phase", p.action === "on" && /on for another 45 min/.test(p.reason), true);
// 5. off for 20 minutes: carries on resting for 40 more
a = when(night, false, 20, now); p = plan(now, false, a); check("off for 20 min: keeps resting 40 more", p.action === null && /off for another 40 min/.test(p.reason), true);
// 6. the event happens just after the night began: the shifted anchor (before 17:30) still counts
now = at(17, 40); a = when(night, true, 2, now); p = plan(now, true, a); check("shortly after night starts, carries on (anchor before the window start still counts)", /fridge on for another 43 min/.test(p.reason), true);
// 7. an old anchor from yesterday does not leak into tonight
now = at(18, 30); p = autoPlan({ cfg, now, today, fr: { on: true, online: true }, tankW: 50, limit: 480, pct: 60, gridOn: false, emOff: false, weak: false, dayThrottle: false, anchor: at(18, 30) - 24 * 60 * min, anchorAt: at(18, 30) - 24 * 60 * min });
check("a day-old anchor is ignored: counts from the start of the night (17:30, 60 min rest then on)", /on for another/.test(p.reason), true);
// 8. no anchorAt given (older callers): behaves exactly as before (anchor = when it happened)
now = at(19, 0); p = autoPlan({ cfg, now, today, fr: { on: true, online: true }, tankW: 50, limit: 480, pct: 60, gridOn: false, emOff: false, weak: false, dayThrottle: false, anchor: now }); check("old style anchor = now: rest first", p.action === "off" && /off for another 60 min/.test(p.reason), true);
// 9. Weak night uses its own lengths
const weak = cfg.weak; a = when(weak, true, 5, now); p = plan(now, true, a, { weak: true }); check("Weak night: on for 5 min, carries on 55 more", /Weak night rhythm: fridge on for another 55 min/.test(p.reason), true);
// 10. Day throttle in the daytime
now = at(12, 0); const day = cfg.dayThrottle; a = when(day, false, 10, now); p = plan(now, false, a, { dayThrottle: true }); check("Day throttle: off 10 min, keeps resting " + (day.offMin - 10) + " more", new RegExp(`Day throttle: fridge off for another ${day.offMin - 10} min`).test(p.reason), true);
// 11. nothing known about the fridge: rest first
check("fridge state unknown: rest first (anchor = now)", phaseAnchor(night, { on: null }, null, now), now);
console.log(bad ? `${bad} FAILED` : "all passed"); process.exit(bad ? 1 : 0);
