import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, browserLocalPersistence, indexedDBLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig, API_URL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// Order matters: localStorage first, so the sign-in popup works in an installed phone app.
const auth = initializeAuth(app, { persistence: [browserLocalPersistence, indexedDBLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 10 ? "just now" : s < 90 ? Math.round(s) + "s ago" : s < 5400 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "under a minute" : m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const nz = (v) => (v == null || Number.isNaN(v) ? 0 : v);
const fW = (v) => { v = nz(v); return v < 10 ? (v === 0 ? "0" : v.toFixed(1)) : String(Math.round(v)); };
const fK = (v) => nz(v).toFixed(2);
const fmt12 = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const daysLabel = (d) => d.length === 7 ? "Every day" : [1, 2, 3, 4, 5].every((x) => d.includes(x)) && d.length === 5 ? "Weekdays" : d.length === 2 && d.includes(0) && d.includes(6) ? "Weekends" : d.map((x) => DAYS[x]).join(", ");
const set = (sel, text, root = document) => { const el = $(sel, root); if (el && el.textContent !== text) el.textContent = text; };
const q = (root, f) => $(`[data-f="${f}"]`, root);

// Count-up tween for big numbers.
function tween(el, to, fmt = fW, ms = 700) {
  if (!el) return; to = nz(to); const from = el._v ?? 0; el._v = to; cancelAnimationFrame(el._raf);
  if (reduce || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}

/* ================= icons + roles ================= */
const ICON_PATHS = {
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  fridge: '<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M5 10h14M9 6v1.5M9 14v3"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  fan: '<circle cx="12" cy="12" r="1.8"/><path d="M12 10.2C12 6 13 4 15 4s2 3-1 5M13.8 12c4.2 0 6.2 1 6.2 3s-3 2-5-1M12 13.8c0 4.2-1 6.2-3 6.2s-2-3 1-5M10.2 12C6 12 4 11 4 9s3-2 5 1"/>',
  snow: '<path d="M12 2v20M4.2 7l15.6 10M4.2 17 19.8 7M9 3.5 12 6l3-2.5M9 20.5 12 18l3 2.5"/>',
  washer: '<rect x="4" y="2" width="16" height="20" rx="3"/><circle cx="12" cy="13" r="4.5"/><path d="M8 6h.01M11 6h.01"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  flame: '<path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-8z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 20h20"/>',
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10"/><path d="M10 20v-6h4v6"/>',
  peak: '<path d="M3 18 9 9l4 5 3-4 5 8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  loss: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="3"/><path d="M11 18h2"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  power: '<path d="M12 2v10M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
};
const iconSvg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[n] || ICON_PATHS.plug}</svg>`;
const KEBAB = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';
const PICK_ICONS = ["plug", "bolt", "fridge", "bulb", "tv", "fan", "snow", "washer", "wifi", "drop", "flame", "laptop"];
const ROLES = {
  tank: { label: "Main output (power tank)", short: "Main output", tone: "t-blue", icon: "bolt", help: "The plug measuring everything the tank supplies. It drives the gauge, the limits and the flow. Only one device can be this: choosing it here turns the current one into an appliance." },
  fridge: { label: "Fridge or freezer", short: "Fridge", tone: "t-purple", icon: "fridge", help: "Shows the compressor timeline and run time. Only one device can be this." },
  appliance: { label: "Appliance", short: "Appliance", tone: "t-ok", icon: "plug", help: "Any other device you want to see and control. Its power is included in the flow and the chart." },
  grid: { label: "Grid", short: "Grid", tone: "t-warn", icon: "plug", help: "A plug on a socket fed straight from public power. Name it Grid. While it's online, power is present; when it drops offline, that's an outage. Only one device can be this." },
};
// A newly found device named "Grid" is pre-set as the Grid type; everything else starts as an appliance.
const guessDevice = (d) => (/^\s*grid\s*$/i.test(d.name || "") ? { ...d, role: "grid", icon: "plug" } : { ...d, role: "appliance", icon: d.category === "dj" ? "bulb" : "plug" });
const CATEGORY = { cz: "Smart plug", kg: "Smart switch", dj: "Light", tdq: "Smart switch", pc: "Power strip", wk: "Thermostat", fs: "Fan" };

/* ================= state ================= */
let S = null, H = { 1: null, 6: null, 24: null }, range = 1, user = null;
const SERIES_COLORS = ["var(--cyan)", "var(--pink)", "var(--teal)", "var(--warn)", "var(--indigo)"];
const dev = (role) => S?.plugs.find((p) => p.role === role);

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove("show"), 3400); }
function ask({ title, text, ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const d = $("#dlg"); $("#dlgTitle").textContent = title; $("#dlgText").textContent = text;
    $("#dlgOk").textContent = ok; $("#dlgOk").className = "btn " + (danger ? "danger" : "primary");
    d.onclose = () => resolve(d.returnValue === "ok"); d.showModal();
  });
}

/* ================= API ================= */
// Local testing only: on localhost with ?api=http://127.0.0.1:8799 the page talks to a dev Worker with auth off.
const devApi = location.hostname === "localhost" ? new URLSearchParams(location.search).get("api") : null;
const API = devApi || API_URL;
user = devApi ? { email: "dev@localhost" } : null;
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (!devApi) headers.Authorization = "Bearer " + (await auth.currentUser.getIdToken());
  const r = await fetch(API + path, { ...opts, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
// Run a change, report the result, then refresh straight away so the screen reflects it.
async function change(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await tick(); return true; }
  catch (e) { toast(e.message || "That didn't work"); return false; }
}

/* ================= menu (the 3 vertical dots) ================= */
const menuEl = $("#menu"); let menuBtn = null, menuItems = [];
function openMenu(btn, items) {
  closeMenu(); menuItems = items; menuBtn = btn; btn.setAttribute("aria-expanded", "true");
  menuEl.innerHTML = items.map((it, i) => `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}">${it.icon ? iconSvg(it.icon) : ""}${esc(it.label)}</button>`).join("");
  menuEl.hidden = false;
  const r = btn.getBoundingClientRect(), w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.style.left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8) + "px";
  menuEl.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
}
function closeMenu() { if (menuBtn) menuBtn.setAttribute("aria-expanded", "false"); menuBtn = null; menuEl.hidden = true; }
menuEl.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const it = menuItems[b.dataset.i]; closeMenu(); it?.fn(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
addEventListener("scroll", closeMenu, { passive: true }); addEventListener("resize", closeMenu);

const deviceMenu = (id) => {
  const p = S.plugs.find((x) => x.id === id); if (!p) return [];
  return [
    { label: "Edit device", icon: "edit", fn: () => openDeviceDialog("edit", p) },
    ...(p.role !== "grid" ? [{ label: "Add schedule", icon: "clock", fn: () => openSchedDialog(null, p.id) }] : []),
    { label: "Remove from dashboard", icon: "trash", danger: true, fn: () => removeDevice(p) },
  ];
};
const schedMenu = (id) => {
  const s = S.schedules.find((x) => x.id === id); if (!s) return [];
  return [
    { label: "Edit schedule", icon: "edit", fn: () => openSchedDialog(s) },
    { label: s.enabled ? "Turn schedule off" : "Turn schedule on", icon: "power", fn: () => saveSched({ ...s, enabled: !s.enabled }) },
    { label: "Delete schedule", icon: "trash", danger: true, fn: () => deleteSched(s) },
  ];
};

/* ================= device + schedule actions ================= */
async function removeDevice(p) {
  const n = S.schedules.filter((s) => s.deviceId === p.id).length;
  if (!(await ask({ title: `Remove ${p.name}?`, text: `It disappears from the dashboard${n ? ` and its ${n} schedule${n > 1 ? "s are" : " is"} deleted` : ""}. The device stays in Smart Life, and you can restore it from Settings.`, ok: "Remove", danger: true }))) return;
  await change(() => post("/api/device/remove", { id: p.id }), `${p.name} removed`);
}
const saveSched = (s) => change(() => post("/api/schedule/save", s), "Schedule saved");
async function deleteSched(s) {
  if (!(await ask({ title: "Delete this schedule?", text: `${s.action === "on" ? "Turn on" : "Turn off"} at ${fmt12(s.at)} will stop running.`, ok: "Delete", danger: true }))) return;
  await change(() => post("/api/schedule/delete", { id: s.id }), "Schedule deleted");
}

/* ----- device dialog ----- */
const devDlg = $("#devDlg"); let devEditing = null, devIcon = "plug", devIconTouched = false;
function renderIconPicker() { $("#devIcons").innerHTML = PICK_ICONS.map((n) => `<button type="button" data-icon="${n}" aria-label="${n}" aria-pressed="${n === devIcon}">${iconSvg(n)}</button>`).join(""); }
function openDeviceDialog(mode, d) {
  devEditing = { mode, id: d.id }; devIcon = d.icon || "plug"; devIconTouched = mode === "edit";
  $("#devTitle").textContent = mode === "add" ? "Add device" : mode === "restore" ? "Restore device" : "Edit device";
  $("#devLead").textContent = mode === "edit" ? "Change how this device appears and behaves." : `Found on your Smart Life account${d.category ? " · " + (CATEGORY[d.category] || "Device") : ""}.`;
  $("#devName").value = d.name || ""; $("#devSave").textContent = mode === "edit" ? "Save" : "Add to dashboard";
  const role = d.role || "appliance";
  $("#devRole").innerHTML = Object.entries(ROLES).map(([k, r]) => `<option value="${k}">${esc(r.label)}</option>`).join(""); $("#devRole").value = role;
  $("#devRoleHelp").textContent = ROLES[role].help; renderIconPicker(); devDlg.showModal();
}
$("#devRole").addEventListener("change", (e) => { $("#devRoleHelp").textContent = ROLES[e.target.value].help; if (!devIconTouched) { devIcon = ROLES[e.target.value].icon; renderIconPicker(); } });
$("#devIcons").addEventListener("click", (e) => { const b = e.target.closest("button[data-icon]"); if (!b) return; devIcon = b.dataset.icon; devIconTouched = true; renderIconPicker(); });
$("#devCancel").addEventListener("click", () => devDlg.close());
$("#devForm").addEventListener("submit", async (e) => {
  e.preventDefault(); if (!devEditing) return;
  const body = { id: devEditing.id, name: $("#devName").value.trim(), role: $("#devRole").value, icon: devIcon };
  $("#devSave").disabled = true;
  const ok = await change(() => post("/api/device/save", body), devEditing.mode === "edit" ? "Device updated" : `${body.name} added`);
  $("#devSave").disabled = false; if (ok) devDlg.close();
});

/* ----- schedule dialog ----- */
const schedDlg = $("#schedDlg"); let schedEditing = null, schedAction = "off", schedDays = [0, 1, 2, 3, 4, 5, 6];
function renderSchedDays() { $("#schedDays").innerHTML = DAYS.map((d, i) => `<button type="button" data-d="${i}" aria-pressed="${schedDays.includes(i)}">${d}</button>`).join(""); }
function renderSchedAction() { $$("#schedAction button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === schedAction)); }
function openSchedDialog(s, deviceId) {
  const options = S.plugs.filter((p) => p.role !== "grid");
  if (!options.length) return toast("Add a device first");
  schedEditing = s ? s.id : null; schedAction = s?.action ?? "off"; schedDays = s ? [...s.days] : [0, 1, 2, 3, 4, 5, 6];
  $("#schedTitle").textContent = s ? "Edit schedule" : "New schedule";
  $("#schedDevice").innerHTML = options.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("#schedDevice").value = s?.deviceId ?? deviceId ?? options[0].id; $("#schedAt").value = s?.at ?? "16:00";
  const gc = s?.gridCheck; $("#gcOn").setAttribute("aria-checked", String(gc?.enabled === true)); $("#gcWin").value = gc?.windowMin ?? 120; $("#gcMin").value = gc?.minSupplyMin ?? 60;
  $("#schedDelete").hidden = !s; renderSchedDays(); renderSchedAction(); updateGcHelp(); schedDlg.showModal();
}
// "Only when the Grid is off": skip the run if the Grid supplied enough power in the window before the set time.
function updateGcHelp() {
  const on = $("#gcOn").getAttribute("aria-checked") === "true"; $("#gcFields").hidden = !on;
  const w = Number($("#gcWin").value) || 0, m = Number($("#gcMin").value) || 0, at = $("#schedAt").value ? fmt12($("#schedAt").value) : "the set time", act = schedAction === "on" ? "turn on" : "turn off";
  $("#gcHelp").textContent = on ? `If the Grid supplied at least ${m} of the ${w} minutes before ${at}, this run is skipped. Otherwise it will ${act}.${S.plugs.some((p) => p.role === "grid") ? "" : " There's no Grid device yet, so this has no effect until you add one."}` : "Runs every time, whatever the Grid is doing.";
}
$("#gcOn").addEventListener("click", () => { const b = $("#gcOn"); b.setAttribute("aria-checked", String(b.getAttribute("aria-checked") !== "true")); updateGcHelp(); });
for (const id of ["#gcWin", "#gcMin", "#schedAt"]) $(id).addEventListener("input", updateGcHelp);
$("#schedAction").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; schedAction = b.dataset.v; renderSchedAction(); updateGcHelp(); });
$("#schedDays").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const d = Number(b.dataset.d); schedDays = schedDays.includes(d) ? schedDays.filter((x) => x !== d) : [...schedDays, d].sort(); renderSchedDays(); });
$("#schedCancel").addEventListener("click", () => schedDlg.close());
$("#schedDelete").addEventListener("click", async () => { const s = S.schedules.find((x) => x.id === schedEditing); schedDlg.close(); if (s) await deleteSched(s); });
$("#schedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur = S.schedules.find((x) => x.id === schedEditing);
  const ok = await change(() => post("/api/schedule/save", { id: schedEditing, deviceId: $("#schedDevice").value, action: schedAction, at: $("#schedAt").value, days: schedDays, enabled: cur?.enabled ?? true, gridCheck: { enabled: $("#gcOn").getAttribute("aria-checked") === "true", windowMin: Number($("#gcWin").value), minSupplyMin: Number($("#gcMin").value) } }), "Schedule saved");
  if (ok) schedDlg.close();
});

/* ================= delegated clicks ================= */
document.addEventListener("click", async (e) => {
  const kb = e.target.closest(".kebab[data-menu]");
  if (kb) { if (menuBtn === kb) return closeMenu(); const [kind, id] = kb.dataset.menu.split(":"); return openMenu(kb, kind === "dev" ? deviceMenu(id) : schedMenu(id)); }
  const sw = e.target.closest(".switch[data-id]");
  if (sw && S) {
    const p = S.plugs.find((x) => x.id === sw.dataset.id), want = !p.on;
    if (p.role === "tank" && !want && !(await ask({ title: "Cut power to the whole house?", text: "This switches off everything fed through the main output plug, including the router.", ok: "Switch off", danger: true }))) return;
    p.on = want; updateDeviceValues();
    try { await post("/api/switch", { id: p.id, on: want }); toast(S.auto && p.role === "fridge" ? (S.auto.mode === "auto" ? "Automatic is in charge and will put the fridge back within 2 minutes. Choose Manual or Absolute to hold it." : S.auto.mode === "manual" ? `Fridge held ${want ? "on" : "off"} for ${S.auto.cfg.manualH} h, then Automatic takes over again.` : `Fridge held ${want ? "on" : "off"} until you change the mode or switch it again.`) : `${p.name} ${want ? "on" : "off"}`); await tick(); }
    catch (err) { p.on = !want; updateDeviceValues(); toast("Couldn't switch: " + err.message); }
    return;
  }
  const st = e.target.closest(".switch[data-sched-toggle]");
  if (st && S) { const s = S.schedules.find((x) => x.id === st.dataset.schedToggle); if (s) saveSched({ ...s, enabled: !s.enabled }); return; }
  const as = e.target.closest("[data-add-sched]"); if (as) return openSchedDialog(null, as.dataset.addSched);
  const ad = e.target.closest("[data-add-device]"); if (ad && S) { const d = S.discovered.find((x) => x.id === ad.dataset.addDevice); if (d) openDeviceDialog("add", guessDevice(d)); return; }
  const rs = e.target.closest("[data-restore]"); if (rs && S) { const d = S.removed.find((x) => x.id === rs.dataset.restore); if (d) openDeviceDialog("restore", d); return; }
  if (e.target.closest("#addSched")) return openSchedDialog(null);
  if (e.target.closest("#refreshDevices")) { const b = $("#refreshDevices"); b.disabled = true; b.textContent = "Checking…"; await change(async () => { const r = await post("/api/devices/refresh", {}); toast(`Checked Smart Life: ${r.found} device${r.found === 1 ? "" : "s"} on your account`); }); b.disabled = false; b.textContent = "Refresh from Smart Life"; return; }
  if (e.target.closest("#saveLimits")) { const target = Number($("#limTarget").value), limit = Number($("#limLimit").value); await change(() => post("/api/settings", { warn: target, limit }), "Limits saved"); return; }
  const th = e.target.closest("[data-theme]"); if (th) { applyTheme(th.dataset.theme); return; }
  if (e.target.closest("#signOutBtn")) return signOut(auth);
  if (e.target.closest("#photoClose")) return $("#photoDlg").close();
  const ph = e.target.closest("[data-photo]"); if (ph) return openPhoto(Number(ph.dataset.photo), ph.dataset.cap || "");
  if (e.target.closest("[data-photo-now]")) return photoNow();
  if (e.target.closest("[data-snap-now]")) return snapNow();
  const nb = e.target.closest("[data-banner]");
  if (nb && S) {
    if (nb.dataset.banner === "dismiss") { try { sessionStorage.setItem("dismissedNew", S.discovered.map((d) => d.id).join(",")); } catch {} return updateBanner(); }
    const d = S.discovered[0]; if (d) openDeviceDialog("add", guessDevice(d));
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "agPhotoEvery" || e.target.id === "agLiveSec") await change(() => post("/api/agent/settings", { photoEveryMin: Number($("#agPhotoEvery").value), liveSec: Number($("#agLiveSec").value) }), "Saved");
});

/* ================= ring gauge ================= */
function drawTicks(warn, limit) {
  let s = "";
  for (const w of [warn, limit]) { const a = ((135 + (w / limit) * 270) * Math.PI) / 180; s += `<line x1="${120 + 80 * Math.cos(a)}" y1="${120 + 80 * Math.sin(a)}" x2="${120 + 108 * Math.cos(a)}" y2="${120 + 108 * Math.sin(a)}"/>`; }
  $("#gTicks").innerHTML = s;
}
// What is running the house? The rule: grid light ON + the tank-output plug OFF (offline or switched off) + a house plug (the fridge, later others) still ON = the house is on the grid.
// If the tank-output plug is on, the house is on the tank. Watts is what the OTHER plugs draw, which is all that can be measured while the tank plug is off.
function supply() {
  const tank = dev("tank"), gl = S.gridLight, gd = dev("grid");
  if (!tank) return { src: "unknown", watts: 0 };
  const gridOn = gd ? (gd.online == null ? null : gd.online) : gl && Date.now() - gl.at < 6 * 60e3 ? gl.on : null;
  const tankOff = tank.online === false || tank.on === false, tankOn = tank.online === true && tank.on === true;
  const others = S.plugs.filter((p) => p !== tank && p.role !== "grid"), houseOn = others.some((p) => p.online === true && p.on === true), watts = others.reduce((a, p) => a + nz(p.watts), 0);
  if (tankOn) return { src: "tank", watts };
  if (tankOff && houseOn) return { src: gridOn === true ? "grid" : gridOn === false ? "other" : "unknown", watts, since: tank.lastSeen ?? null };
  if (tankOff) return { src: "none", watts };
  return { src: "unknown", watts };
}
function updateRing() {
  const { limit: lim, warn } = S.limits, tank = dev("tank"), off = tank?.online === false, none = !tank, sp = supply(), onGrid = sp.src === "grid";
  const w = onGrid ? sp.watts : nz(tank?.watts), f = Math.min(1, w / lim);
  const lvl = none ? "none" : onGrid ? "grid" : off ? "off" : w >= lim ? "bad" : w >= warn ? "warn" : "ok";
  $("#gZone").setAttribute("stroke-dasharray", `0 ${(warn / lim) * 75} ${(1 - warn / lim) * 75} 100`); drawTicks(warn, lim);
  const v = $("#gVal"); v.style.opacity = f > 0 ? 1 : 0; v.setAttribute("stroke-dasharray", `${Math.max(f * 75, 0.01)} 100`);
  v.setAttribute("stroke", `url(#${lvl === "bad" ? "gBad" : lvl === "warn" ? "gWarn" : "gOk"})`);
  v.style.setProperty("--glow-c", lvl === "bad" ? "rgba(255,69,58,.55)" : lvl === "warn" ? "rgba(255,176,32,.5)" : "rgba(50,215,75,.5)");
  tween($("#gNum"), w);
  const chip = $("#gChip"); chip.className = "chip " + (lvl === "off" || lvl === "none" ? "" : lvl === "grid" ? "ok" : lvl);
  chip.textContent = { none: "SET UP", off: "OFFLINE", grid: "ON GRID", ok: "WITHIN TARGET", warn: "ABOVE TARGET", bad: "OVER LIMIT" }[lvl];
  set("#gNote", onGrid ? "" : none ? "Choose a main output device in Settings" : off ? "Main plug offline, so no power is being supplied" : w >= lim ? `${Math.round(w - lim)} W over the limit` : w >= warn ? `${Math.round(lim - w)} W until the limit` : w === 0 ? "Nothing drawing power" : "Looking good");
  set("#kTarget", `Target ${warn} W`); set("#kLimit", `Limit ${lim} W`);
  tween($("#mHead"), Math.max(0, lim - w)); tween($("#mPeak"), S.totals?.peakToday);
}

/* ================= energy flow (any number of devices) ================= */
let flowSig = "";
function flowNodes() {
  const appl = S.plugs.filter((p) => p.role === "fridge" || p.role === "appliance").filter((p) => p.hasPower);
  const fr = appl.filter((p) => p.role === "fridge"), rest = appl.filter((p) => p.role !== "fridge").sort((a, b) => nz(b.watts) - nz(a.watts));
  return [...fr, ...rest].slice(0, 2);
}
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const SRC_ICON = { tank: '<rect x="2" y="5" width="21" height="12" rx="3"/><path d="M26 9v4M11 8l-2 4h4l-2 4"/>', grid: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>' }; // the top node is a battery for the tank and a plug for the grid
function buildFlow(nodes) {
  const n = nodes.length + 1, w = n === 1 ? 180 : n === 2 ? 174 : 112, gap = 12, total = n * w + (n - 1) * gap, x0 = (400 - total) / 2;
  const home = n === 1 ? [200] : n === 2 ? [165, 235] : [150, 200, 250];
  const items = [...nodes.map((p) => ({ name: p.name, icon: p.icon, color: p.role === "fridge" ? "#bf5af2" : "#32d74b", gradient: "fg2" })), { name: n === 3 ? "Other" : "Other loads", icon: "bolt", color: "#32d74b", gradient: "fg3", other: true }];
  const big = n < 3, fs = big ? 14 : 12, fv = big ? 20 : 17, tx = big ? 44 : 36;
  let svg = `<defs>
    <linearGradient id="fg1" gradientUnits="userSpaceOnUse" x1="200" y1="74" x2="200" y2="138"><stop offset="0" stop-color="#5ac8fa"/><stop offset="1" stop-color="#0a84ff"/></linearGradient>
    <linearGradient id="fg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#bf5af2"/></linearGradient>
    <linearGradient id="fg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#32d74b"/></linearGradient></defs>
    <path class="f-line" d="M200 74 V138"/><path class="f-run" id="fr0" d="M200 74 V138" stroke="url(#fg1)"/>`;
  items.forEach((it, i) => {
    const cx = x0 + i * (w + gap) + w / 2, hx = home[i];
    svg += `<path class="f-line" d="M${hx} 196 C${hx} 232 ${cx} 226 ${cx} 262"/><path class="f-run" id="fr${i + 1}" d="M${hx} 196 C${hx} 232 ${cx} 226 ${cx} 262" stroke="url(#${it.gradient})"/>`;
    const x = cx - w / 2;
    svg += `<rect class="f-node" x="${x}" y="262" width="${w}" height="58" rx="18"/><g transform="translate(${x + 12} ${276}) scale(${big ? 1 : .85})" fill="none" stroke="${it.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[it.icon] || ICON_PATHS.plug}</g>
      <text class="f-t" x="${x + tx + (big ? 4 : 2)}" y="287" font-size="${fs}">${esc(short(it.name, big ? 12 : 7))}</text><text class="f-v" id="fv${i}" x="${x + tx + (big ? 4 : 2)}" y="308" font-size="${fv}">0 W</text>`;
  });
  svg += `<rect class="f-node" x="120" y="14" width="160" height="60" rx="18"/><g id="fSrcIcon" transform="translate(138 30)" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SRC_ICON.tank}</g>
    <text class="f-t" id="fSrc" x="174" y="39" font-size="14">Power tank</text><text class="f-v" id="fTank" x="174" y="60" font-size="20">0 W</text>
    <rect class="f-node" x="120" y="136" width="160" height="60" rx="18"/><g transform="translate(138 151)" fill="none" stroke="#bf5af2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13 14 3l12 10M5 11v13h18V11"/><path d="M11 24v-7h6v7"/></g>
    <text class="f-t" x="174" y="161" font-size="14">Home</text><text class="f-v" id="fHome" x="174" y="182" font-size="20">0 W</text>`;
  $("#flowSvg").innerHTML = svg;
}
function updateFlow() {
  const tank = dev("tank"), nodes = flowNodes(), sig = nodes.map((p) => p.id + p.name + p.icon + p.role).join("|");
  if (sig !== flowSig) { flowSig = sig; buildFlow(nodes); }
  const sp = supply(), onGrid = sp.src === "grid", load = onGrid ? sp.watts : nz(tank?.watts), named = nodes.reduce((a, p) => a + nz(p.watts), 0), other = Math.max(0, load - named);
  set("#fSrc", onGrid ? "Grid" : "Power tank"); const si = $("#fSrcIcon"); if (si && si.dataset.src !== (onGrid ? "grid" : "tank")) { si.dataset.src = onGrid ? "grid" : "tank"; si.innerHTML = SRC_ICON[si.dataset.src]; } set("#fTank", fW(load) + " W"); set("#fHome", fW(load) + " W");
  // a device counts as connected to the flow whenever its switch is on, even while it draws 0 W (a fridge with its compressor resting is still on)
  const isOn = (p) => nz(p.watts) > 0 || (p.online === true && p.on === true), tankOn = tank?.online === true && tank?.on === true, flowing = load > 0 || tankOn || nodes.some(isOn);
  nodes.forEach((p, i) => { set(`#fv${i}`, fW(p.watts) + " W"); $(`#fr${i + 1}`)?.classList.toggle("on", isOn(p)); });
  set(`#fv${nodes.length}`, fW(other) + " W"); $(`#fr${nodes.length + 1}`)?.classList.toggle("on", other > 1);
  $("#fr0")?.classList.toggle("on", load > 0 || tankOn || (onGrid && nodes.some(isOn)));
  const chip = $("#fChip"); chip.className = "chip " + (flowing ? "ok" : ""); chip.textContent = flowing ? "LIVE" : "IDLE";
  set("#fNote", !tank ? "Choose a main output device in Settings." : onGrid ? "" : tank.online === false ? "Main plug is offline, so nothing is flowing." : "");
}

/* ================= tiles ================= */
const tileHTML = (cls, icon, k, id, unit, note) => `<div class="card tile"><div class="ti ${cls}">${iconSvg(icon)}</div><div class="k">${k}</div><div class="v"><span id="${id}">0</span><small>${unit}</small></div><div class="n">${note}</div></div>`;
let tilesSig = "";
function updateTiles() {
  const fridge = dev("fridge"), t = S.totals || {}, sig = fridge ? "f" : "n";
  if (sig !== tilesSig) {
    tilesSig = sig;
    $("#tiles").innerHTML = tileHTML("t-blue", "home", "House today", "tHouse", "kWh", "since midnight") + tileHTML("t-warn", "peak", "Peak today", "tPeak", "W", "highest house load")
      + (fridge ? tileHTML("t-purple", "fridge", `${esc(fridge.name)} today`, "tFridge", "kWh", "since midnight") + tileHTML("t-ok", "clock", `${esc(fridge.name)} switched on`, "tDuty", "%", '<span id="tDutyNote">of the last 6 hours</span><br><span id="tDutyComp"></span>')
        : tileHTML("t-ok", "plug", "Devices online", "tOnline", "", "right now") + tileHTML("t-soft", "clock", "Active schedules", "tSched", "", "running automatically"));
  }
  tween($("#tHouse"), t.houseKwhToday, fK); tween($("#tPeak"), t.peakToday);
  if (fridge) { tween($("#tFridge"), t.fridgeKwhToday, fK); const swp = t.fridgeSwOnPct6h; if (swp == null) set("#tDuty", "—"); else tween($("#tDuty"), swp, (v) => String(Math.round(v)));
    const cm = t.fridgeSwCoverMin ?? 0; set("#tDutyNote", swp == null ? "waiting for the switch state" : "of the last " + (cm >= 355 ? "6 hours" : cm < 90 ? cm + " min" : Math.round(cm / 60) + " h"));
    set("#tDutyComp", t.fridgeCompressorPct6h == null ? "" : "compressor ran " + t.fridgeCompressorPct6h + "% of that"); }
  else { tween($("#tOnline"), S.plugs.filter((p) => p.online !== false).length, (v) => String(Math.round(v))); tween($("#tSched"), S.schedules.filter((s) => s.enabled).length, (v) => String(Math.round(v))); }
}

/* ================= device cards ================= */
let devSig = "";
function schedRow(s) {
  return `<div class="srow"><div class="s-t"><b>${s.action === "on" ? "Turn on" : "Turn off"} · ${fmt12(s.at)}</b><span>${daysLabel(s.days)}${s.gridCheck?.enabled ? " · only if Grid off" : ""}${s.enabled && s.heldByAuto ? " · paused while Automatic" : ""}${s.enabled && !s.heldByAuto && s.lastDone === S.today ? " · done today" : ""}${s.enabled && s.skipped ? ` · skipped today, Grid supplied ${s.skipped.supplyMin} min` : ""}</span></div>
    <button class="switch sm" role="switch" aria-checked="${s.enabled}" data-sched-toggle="${esc(s.id)}" aria-label="Schedule on or off"></button>
    <button class="kebab" data-menu="sched:${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Schedule options">${KEBAB}</button></div>`;
}
function devCard(p) {
  const r = ROLES[p.role] || ROLES.appliance, ss = S.schedules.filter((s) => s.deviceId === p.id);
  return `<section class="card c-6 dev" data-id="${esc(p.id)}">
    <div class="dev-top"><div class="dev-id"><div class="dev-ico ${r.tone}">${iconSvg(p.icon)}</div><div class="dev-names"><div class="dev-name" data-f="name">${esc(p.name)}</div><div class="dev-state"><span class="dot" data-f="dot"></span><span data-f="state"></span></div></div></div>
      <div class="dev-actions"><button class="kebab" data-menu="dev:${esc(p.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">${KEBAB}</button>
        <button class="switch" role="switch" aria-checked="false" data-id="${esc(p.id)}" data-f="sw" aria-label="${esc(p.name)} power" disabled></button></div></div>
    ${p.role === "grid" ? `<div class="dev-read"><div><div class="dev-num word" data-f="word">Online</div><div class="meta"><span>Online means public power is present</span></div></div></div>`
      : p.hasPower ? `<div class="dev-read"><div><div class="dev-num"><span data-f="w">0</span><small>W</small></div><div class="meta"><span><b data-f="v">0</b> V</span><span><b data-f="a">0.00</b> A</span><span>Today <b data-f="kwh">0.00</b> kWh</span></div></div><svg class="spark" data-f="spark" viewBox="0 0 230 64" preserveAspectRatio="none" aria-hidden="true"></svg></div>`
      : `<div class="dev-read"><div><div class="dev-num word" data-f="word">Off</div></div></div>`}
    <div class="last" data-f="note" hidden></div>
    ${p.role === "grid" ? "" : `<div class="srows">${ss.map(schedRow).join("")}<button class="link" data-add-sched="${esc(p.id)}">+ Add schedule</button></div>`}
  </section>`;
}
const lastSeenText = (t) => { if (!t) return "Unknown"; const d = new Date(t); return d.toDateString() === new Date().toDateString() ? clock(t) : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }); };
function spark(series, color, uid) {
  const W = 230, Ht = 64, vals = series || [], valid = vals.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const max = Math.max(10, ...valid.map(([, v]) => v)) * 1.15, n = Math.max(1, vals.length - 1);
  const x = (i) => (i / n) * W, y = (v) => Ht - 4 - (v / max) * (Ht - 10);
  let d = valid.length ? "" : `M0 ${y(0)}H${W}`;
  valid.forEach(([i, v], k) => { d += k ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(i).toFixed(1)} ${y(v).toFixed(1)}`; });
  const area = valid.length ? `${d}H${x(valid[valid.length - 1][0]).toFixed(1)}V${Ht}H${x(valid[0][0]).toFixed(1)}Z` : "";
  return `<defs><linearGradient id="sg-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${area ? `<path d="${area}" fill="url(#sg-${uid})"/>` : ""}<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" ${valid.length ? "" : 'opacity=".4" stroke-dasharray="4 5"'}/>`;
}
const SPARK_COLOR = { tank: "#0a84ff", fridge: "#bf5af2", appliance: "#32d74b", grid: "#ffb020" };
function updateDeviceValues() {
  const sp = supply();
  for (const p of S.plugs) {
    const el = $(`.dev[data-id="${CSS.escape(p.id)}"]`); if (!el) continue;
    const off = p.online === false;
    set('[data-f="name"]', p.name, el);
    let state;
    if (p.role === "grid") state = off ? ["bad", "No grid power"] : p.online ? ["ok", "Grid power present"] : ["", "Waiting for data"];
    else if (p.role === "tank" && sp.src === "grid") state = ["", "Not supplying · house on the grid"];
    else state = off ? ["bad", "Offline"] : p.on == null && p.watts == null ? ["", "Waiting for data"] : p.on === false ? ["", "Switched off" + (p.relaySince ? " since " + clock(p.relaySince) : "")] : p.role === "tank" ? ["ok", "Supplying power"] : p.role === "fridge" ? [nz(p.watts) > 5 ? "ok" : "ok", nz(p.watts) > 5 ? "Compressor running" : "On · compressor resting"] : ["ok", "On"];
    if (p.cloudDisagrees) state = ["warn", `Phone says ${p.on ? "on" : "off"}, Tuya cloud says ${p.cloudOn ? "on" : "off"}`];
    q(el, "dot").className = "dot " + state[0]; q(el, "state").textContent = state[1];
    const sw = q(el, "sw"); sw.setAttribute("aria-checked", String(p.on === true)); sw.disabled = off || p.on == null || p.role === "grid";
    if (p.role === "grid") { sw.hidden = true; const w = q(el, "word"); w.textContent = off ? "Outage" : "Power on"; }
    else if (p.hasPower) {
      tween(q(el, "w"), p.watts); tween(q(el, "v"), p.volts, (v) => String(Math.round(v))); tween(q(el, "a"), p.amps, (v) => v.toFixed(2)); tween(q(el, "kwh"), p.kwhToday, fK);
      const sp = H[1]?.series?.[p.id]; if (H[1]) q(el, "spark").innerHTML = spark(sp, SPARK_COLOR[p.role] || "#32d74b", p.id.slice(-6));
    } else { const w = q(el, "word"); if (w) w.textContent = off ? "Offline" : p.on ? "On" : "Off"; }
    const note = q(el, "note"); note.hidden = !off;
    if (off) note.innerHTML = p.role === "grid" ? `<div><span>Last seen</span><b>${lastSeenText(p.lastSeen)}</b></div><div><span>Status</span><b>Outage</b></div>` : `<div><span>Last online</span><b>${lastSeenText(p.lastSeen)}</b></div><div><span>${p.hasPower ? "Last draw" : "Last state"}</span><b>${p.hasPower ? fW(p.lastWatts) + " W" : "Unknown"}</b></div>`;
  }
}
function updateDevices() {
  const order = { tank: 0, fridge: 1, appliance: 2, grid: 3 };
  const list = [...S.plugs].sort((a, b) => order[a.role] - order[b.role]);
  const sig = JSON.stringify([list.map((p) => [p.id, p.name, p.role, p.icon, p.hasPower]), S.schedules, S.today]);
  if (sig !== devSig) { devSig = sig; $("#devices").innerHTML = list.map(devCard).join("") || `<section class="card c-12"><div class="set-empty">No devices yet. Open Settings to add one from your Smart Life account.</div></section>`; }
  updateDeviceValues();
}

/* ================= chart ================= */
function mono(p) { // monotone cubic path, no overshoot
  const n = p.length; if (n < 2) return "";
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0] || 1e-6); m.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) { const h = dx[i] / 3; d += `C${(p[i][0] + h).toFixed(1)} ${(p[i][1] + t[i] * h).toFixed(1)} ${(p[i + 1][0] - h).toFixed(1)} ${(p[i + 1][1] - t[i + 1] * h).toFixed(1)} ${p[i + 1][0].toFixed(1)} ${p[i + 1][1].toFixed(1)}`; }
  return d;
}
function renderChart() {
  const data = H[range], box = $("#chart"); if (!data || !S || !box.clientWidth) return;
  const W = box.clientWidth, Ht = box.clientHeight, m = { l: 40, r: 14, t: 16, b: 26 }, { warn, limit } = S.limits;
  const n = data.n, step = (data.to - data.from) / n, times = Array.from({ length: n }, (_, i) => Math.round(data.from + (i + 1) * step));
  const tank = dev("tank"), fridge = dev("fridge"), others = S.plugs.filter((p) => p.role === "appliance" && p.hasPower);
  const house = tank ? data.series[tank.id] ?? Array(n).fill(null) : Array(n).fill(null), fridgeS = fridge ? data.series[fridge.id] : null;
  const extra = others.map((p, i) => ({ p, color: SERIES_COLORS[i % SERIES_COLORS.length], s: data.series[p.id] ?? Array(n).fill(null) }));
  const peak = house.reduce((b, v, i) => (v != null && v > b.v ? { v, i } : b), { v: -1, i: 0 });
  const ymax = Math.max(limit * 1.12, Math.max(0, peak.v) * 1.1), t0 = data.from, t1 = data.to;
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r), Y = (v) => Ht - m.b - (Math.min(v, ymax) / ymax) * (Ht - m.t - m.b);
  const segs = (s) => { const out = []; let cur = []; for (let i = 0; i < n; i++) { if (s[i] == null) continue; if (cur.length && times[i] - cur[cur.length - 1][3] > Math.max(step * 5, 6 * 60e3)) { out.push(cur); cur = []; } cur.push([X(times[i]), Y(s[i]), s[i], times[i]]); } if (cur.length) out.push(cur); return out; };
  const line = (ss) => ss.map(mono).join(""), zero = (s) => mono(times.map((t, i) => [X(t), Y(s[i] ?? 0)]));
  const hs = segs(house), area = hs.filter((s) => s.length > 1).map((s) => mono(s) + `L${s[s.length - 1][0].toFixed(1)} ${Y(0)}L${s[0][0].toFixed(1)} ${Y(0)}Z`).join("");
  const ticks = [0, 100, 200, 300, 400, 500, 600, 800, 1000].filter((v) => v <= ymax), nx = W < 520 ? 4 : 7, right = W - m.r, bottom = Ht - m.b;
  const xt = Array.from({ length: nx }, (_, i) => t0 + ((i + 0.5) / nx) * (t1 - t0));
  const lastT = hs.length ? hs[hs.length - 1].at(-1) : null, hasData = hs.length || (fridgeS && fridgeS.some((v) => v != null)), peakShow = peak.v > 5;
  box.querySelector("svg")?.remove();
  box.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Power over the selected period">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--blue)" stop-opacity=".32"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient>
      <clipPath id="cOk"><rect x="0" y="${Y(warn)}" width="${W}" height="${Ht}"/></clipPath><clipPath id="cWarn"><rect x="0" y="${Y(limit)}" width="${W}" height="${Y(warn) - Y(limit)}"/></clipPath><clipPath id="cBad"><rect x="0" y="0" width="${W}" height="${Y(limit)}"/></clipPath></defs>
    <rect x="${m.l}" y="${Y(limit)}" width="${right - m.l}" height="${Y(warn) - Y(limit)}" fill="var(--warn)" opacity=".07"/>
    <rect x="${m.l}" y="${m.t - 6}" width="${right - m.l}" height="${Y(limit) - m.t + 6}" fill="var(--bad)" opacity=".07"/>
    ${ticks.map((v) => `<line x1="${m.l}" x2="${right}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--card-border)" stroke-width="1" ${v ? 'stroke-dasharray="2 4"' : ""}/><text x="${m.l - 9}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--faint)">${v}</text>`).join("")}
    <line x1="${m.l}" x2="${right}" y1="${Y(warn)}" y2="${Y(warn)}" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="6 5"/><line x1="${m.l}" x2="${right}" y1="${Y(limit)}" y2="${Y(limit)}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="6 5"/>
    <text x="${m.l + 8}" y="${Y(warn) - 6}" font-size="11" font-weight="650" fill="var(--warn)">${warn} W target</text><text x="${m.l + 8}" y="${Y(limit) - 6}" font-size="11" font-weight="650" fill="var(--bad)">${limit} W limit</text>
    ${xt.map((t) => `<text x="${X(t)}" y="${Ht - 7}" text-anchor="middle" font-size="11" fill="var(--faint)">${clock(t)}</text>`).join("")}
    ${fridgeS ? `<path d="${zero(fridgeS)}" fill="none" stroke="var(--faint)" stroke-width="1.6" stroke-dasharray="3 5" opacity=".6"/>` : ""}
    <path d="${zero(house)}" fill="none" stroke="var(--faint)" stroke-width="1.6" stroke-dasharray="3 5" opacity=".8"/>
    <path d="${area}" fill="url(#ga)"/>
    ${extra.map((e) => `<path d="${line(segs(e.s))}" fill="none" stroke="${e.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`).join("")}
    ${fridgeS ? `<path d="${line(segs(fridgeS))}" fill="none" stroke="var(--purple)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    <g fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="${line(hs)}" stroke="var(--blue)" clip-path="url(#cOk)"/><path d="${line(hs)}" stroke="var(--warn)" clip-path="url(#cWarn)"/><path d="${line(hs)}" stroke="var(--bad)" clip-path="url(#cBad)"/></g>
    ${hasData ? "" : `<text x="${(m.l + right) / 2}" y="${(m.t + bottom) / 2 - 14}" text-anchor="middle" font-size="13" fill="var(--faint)">No live readings in this period. Offline time is shown as zero.</text>`}
    ${peakShow ? `<g><circle cx="${X(times[peak.i])}" cy="${Y(peak.v)}" r="3.5" fill="var(--bg)" stroke="var(--text)" stroke-width="1.5"/><text x="${Math.min(Math.max(X(times[peak.i]), m.l + 28), right - 28)}" y="${Math.max(Y(peak.v) - 10, 12)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--text)">Peak ${fW(peak.v)} W</text></g>` : ""}
    ${lastT ? `<circle cx="${lastT[0]}" cy="${lastT[1]}" r="10" fill="var(--blue)" opacity=".18"/><circle cx="${lastT[0]}" cy="${lastT[1]}" r="4.5" fill="var(--blue)" stroke="var(--bg)" stroke-width="2"/>` : ""}
    <g id="cross" style="display:none"><line y1="${m.t}" y2="${bottom}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3"/><circle r="5" fill="var(--blue)" stroke="var(--bg)" stroke-width="2.5"/></g>
    <rect id="hit" x="${m.l}" y="0" width="${right - m.l}" height="${Ht}" fill="transparent"/></svg>`);
  const hit = $("#hit"), cross = $("#cross"), tip = $("#tip");
  const move = (ev) => {
    const r = box.getBoundingClientRect(), t = t0 + ((ev.clientX - r.left - m.l) / (right - m.l)) * (t1 - t0);
    let bi = 0; for (let i = 0; i < n; i++) if (Math.abs(times[i] - t) < Math.abs(times[bi] - t)) bi = i;
    const x = X(times[bi]), v = house[bi], lvl = v >= limit ? "var(--bad)" : v >= warn ? "var(--warn)" : "var(--blue)";
    cross.style.display = ""; const ln = cross.querySelector("line"); ln.setAttribute("x1", x); ln.setAttribute("x2", x);
    const c = cross.querySelector("circle"); c.setAttribute("cx", x); c.setAttribute("cy", Y(v ?? 0)); c.setAttribute("fill", lvl);
    tip.style.display = "block"; tip.style.left = Math.min(Math.max(x, 80), W - 80) + "px"; tip.style.top = "4px";
    tip.innerHTML = `<div class="t">${clock(times[bi])}${v == null ? " · offline" : ""}</div><div><i style="color:${lvl}">●</i> House <b>${fW(v)} W</b></div>${fridge ? `<div><i style="color:var(--purple)">●</i> ${esc(fridge.name)} <b>${fW(fridgeS?.[bi])} W</b></div>` : ""}${extra.map((e) => `<div><i style="color:${e.color}">●</i> ${esc(e.p.name)} <b>${fW(e.s[bi])} W</b></div>`).join("")}`;
  };
  hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => { cross.style.display = "none"; tip.style.display = "none"; });
  $("#legend").innerHTML = `<span><i style="background:var(--blue)"></i>House total</span>${fridge ? `<span><i style="background:var(--purple)"></i>${esc(fridge.name)}</span>` : ""}${extra.map((e) => `<span><i style="background:${e.color}"></i>${esc(e.p.name)}</span>`).join("")}<span><i style="background:var(--warn)"></i>Above ${warn} W</span><span><i style="background:var(--bad)"></i>Above ${limit} W</span><span><i style="background:var(--faint)"></i>Offline (shown as 0)</span>`;
  renderTimeline(data, times, fridge, fridgeS);
}
function renderTimeline(data, times, fridge, s) {
  $("#tlWrap").hidden = !fridge; if (!fridge) return;
  $("#tlTitle").textContent = `${fridge.name} compressor`;
  const n = times.length, w = 1000 / n; let out = `<rect width="1000" height="34" fill="var(--soft)"/>`;
  s.forEach((v, i) => { if (v == null) return; out += `<rect x="${(i * w).toFixed(2)}" y="${v > 5 ? 3 : 15}" width="${(w + 0.4).toFixed(2)}" height="${v > 5 ? 28 : 4}" rx="1.5" fill="${v > 5 ? "var(--purple)" : "var(--faint)"}" opacity="${v > 5 ? 1 : 0.5}"/>`; });
  $("#tlSvg").innerHTML = out;
  $("#tlAxis").innerHTML = Array.from({ length: 5 }, (_, i) => `<span>${clock(data.from + (i / 4) * (data.to - data.from))}</span>`).join("");
  const on = s.filter((v) => v != null && v > 5).length, known = s.filter((v) => v != null).length;
  $("#tlNote").textContent = known ? `Running ${Math.round((on / known) * 100)}% of the time` : "No readings in this period";
}

/* ================= grid supply ================= */
const lagosParts = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
};
const dayShift = (dateStr, n) => { const d = new Date(dateStr + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function seeded(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
function demoOutages(dateStr) {
  const r = seeded(dateStr), n = 1 + Math.floor(r() * 3), raw = [];
  for (let i = 0; i < n; i++) { const s = Math.floor(r() * 1300), len = 25 + Math.floor(r() * 210); raw.push([s, Math.min(1440, s + len)]); }
  raw.sort((a, b) => a[0] - b[0]); const out = [];
  for (const iv of raw) { const last = out[out.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push([...iv]); }
  return out;
}
const clip = (out, upTo) => out.filter(([s]) => s < upTo).map(([s, e]) => [s, Math.min(e, upTo)]);
const offMins = (out, upTo) => out.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, upTo) - Math.min(s, upTo)), 0);
const upPct = (out, upTo) => Math.max(0, ((upTo - offMins(out, upTo)) / upTo) * 100);
const gridBar = (out, upTo, marker, known) => `<svg viewBox="0 0 1440 30" preserveAspectRatio="none" aria-hidden="true"><rect width="1440" height="30" fill="var(--track)"/>${known.map(([s, e]) => (s < upTo ? `<rect x="${s}" width="${Math.max(0, Math.min(e, upTo) - s)}" height="30" fill="var(--ok)"/>` : "")).join("")}${out.map(([s, e]) => `<rect x="${s}" width="${Math.max(2, e - s)}" height="30" fill="var(--bad)"/>`).join("")}${marker ? `<rect x="${Math.max(0, upTo - 2)}" width="4" height="30" fill="var(--text)" opacity=".85"/>` : ""}</svg>`; // grey = nothing was measured there
const weekOutages = (startDate) => Array.from({ length: 7 }, (_, i) => demoOutages(dayShift(startDate, i)));
// A clear present / absent indicator at the top of the Power tab. From the Grid plug when there is one, otherwise from the socket light the camera watches.
function updateGridStrip() {
  const el = $("#gridStrip"); if (!el || !S) return;
  const g = S.grid || { demo: true }, gl = S.gridLight, gd = dev("grid"), led = g.source === "led" || (!gd && gl);
  if (g.demo !== false && !gl) { el.hidden = true; return; }
  let present = null, since = null;
  if (led) { if (gl && Date.now() - gl.at < 6 * 60e3) { present = gl.on; since = g.present === gl.on && g.sinceMs ? g.sinceMs : gl.at; } }
  else if (gd && gd.online != null) { present = gd.online; since = g.sinceMs ?? null; }
  const state = present == null ? "unk" : present ? "on" : "off";
  const now = lagosParts(), upTo = Math.max(1, now.mins), today = g.demo === false && g.days ? clip(g.days.today, upTo) : null;
  // the share of today that was power, counted only over the minutes that were actually measured
  const kn = g.known?.today ?? [], sumK = (iv, a, b) => iv.reduce((n, [x, y]) => n + Math.max(0, Math.min(y, b) - Math.max(x, a)), 0), kmin = today ? sumK(kn, 0, upTo) : 0;
  const avail = today && kmin >= 30 ? ((kmin - sumK(today, 0, upTo)) / kmin) * 100 : null;
  const sp = supply(), spSince = sp.src === "grid" && sp.since ? sp.since : null;
  const sig = JSON.stringify([sp.src, spSince ? Math.floor(spSince / 60000) : null, state, since ? Math.floor(since / 60000) : null, avail != null ? Math.round(avail) : null, Math.floor(Date.now() / 60000)]);
  if (sig === el.dataset.sig) return; el.dataset.sig = sig; el.hidden = false;
  el.className = "card c-12 gstrip " + state;
  const title = state === "on" ? "Grid power is ON" : state === "off" ? "No grid power" : "Grid power unknown";
  const sub = state === "unk" ? (led ? (gl ? "The camera hasn't checked the socket light for " + dur(Date.now() - gl.at) : "Waiting for the camera to check the socket light") : "The Grid plug isn't reporting") : (since ? (state === "on" ? "On" : "Off") + " since " + clock(since) + " · " + dur(Date.now() - since) : "");
  const srcText = { grid: "House is running on the grid" + (spSince ? " since " + clock(spSince) : ""), tank: "House is running on the power tank", other: "Tank is off and there is no grid: the house is on some other source", none: "Tank output is off and nothing is running", unknown: "" }[sp.src];
  el.innerHTML = `<div class="gs-ico">${iconSvg(state === "off" ? "bolt" : "plug")}</div><div><div class="gs-t">${title}</div><div class="gs-s">${esc(sub)}</div>${srcText ? `<div class="gs-src ${sp.src}"><i></i>${esc(srcText)}</div>` : ""}</div>${avail != null ? `<div class="gs-r"><b>${Math.round(avail)}%</b><span>of today</span></div>` : ""}`;
}
document.addEventListener("click", (e) => { if (e.target.closest("#gridStrip")) $("#gridWeek")?.scrollIntoView({ behavior: "smooth", block: "center" }); });
let gridRowsData = [], gridHold = false, gridBarEl = null;
function gridTipHide() { const t = $("#gridTip"), c = $("#gridCur"); if (t) t.style.display = "none"; if (c) c.style.display = "none"; }
function gridTipShow(e) { // hold a point on a bar to see the time and whether the power was on
  const bar = gridBarEl, tip = $("#gridTip"), cur = $("#gridCur"), box = $("#gridBars"); if (!bar || !bar.isConnected || !tip || !box) return;
  const r = bar.getBoundingClientRect(), b = box.getBoundingClientRect(), x = Math.min(r.width - 1, Math.max(0, e.clientX - r.left)), m = Math.floor((x / r.width) * 1440), d = gridRowsData[Number(bar.dataset.i)]; if (!d) return;
  const inn = (iv) => iv.some(([s0, e0]) => m >= s0 && m < e0), status = m >= d.upTo ? "Not yet" : !inn(d.known) ? "Not measured" : inn(d.out) ? "No power" : "Power on";
  tip.innerHTML = `<div class="t">${d.label} · ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}</div><b>${status}</b>`; tip.style.display = "block";
  tip.style.left = Math.min(b.width - 70, Math.max(70, r.left - b.left + x)) + "px"; tip.style.top = Math.max(0, r.top - b.top - 58) + "px";
  cur.style.display = "block"; cur.style.left = r.left - b.left + x + "px"; cur.style.top = r.top - b.top + "px"; cur.style.height = r.height + "px";
}
document.addEventListener("pointerdown", (e) => { const bar = e.target.closest?.(".gb-bar"); if (bar) { gridHold = true; gridBarEl = bar; gridTipShow(e); } });
document.addEventListener("pointermove", (e) => { if (gridHold) gridTipShow(e); else { const bar = e.target.closest?.(".gb-bar"); if (bar && e.pointerType === "mouse") { gridBarEl = bar; gridTipShow(e); } else gridTipHide(); } });
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { gridHold = false; gridTipHide(); });
function updateGrid() {
  const now = lagosParts(), upTo = Math.max(1, now.mins), g = S.grid || { demo: true }, real = g.demo === false, gd = dev("grid");
  const days = real ? g.days : { today: demoOutages(now.date), yesterday: demoOutages(dayShift(now.date, -1)), dayBefore: demoOutages(dayShift(now.date, -2)) };
  const today = clip(days.today, upTo), yday = days.yesterday;
  let present, sinceMin;
  if (real) { present = g.present !== false; sinceMin = g.sinceMs ? Math.max(0, (Date.now() - g.sinceMs) / 60000) : 0; }
  else { const cur = today.find(([s, e]) => s <= upTo && e >= upTo); present = !cur; sinceMin = upTo - (present ? Math.max(0, ...today.map(([, e]) => e).filter((e) => e < upTo), 0) : cur[0]); }
  const chip = $("#gridChip"); chip.className = "chip " + (real ? "ok" : "demo"); chip.textContent = real ? "LIVE" : "DEMO";
  set("#gridState", present ? "Light is on" : "Light is off");
  $("#gridArt").setAttribute("stroke", present ? "var(--ok)" : "var(--bad)"); $("#gridGlow").setAttribute("fill", present ? "var(--ok-soft)" : "var(--bad-soft)");
  set("#gridSince", `for ${dur(sinceMin * 60000)}${real ? "" : " (sample)"}`);
  // Only minutes that were really measured count: the gaps (before the first reading, a phone that was off, an agent that was down) are grey and left out of every percentage and comparison.
  const kT = real ? (g.known?.today ?? []) : [[0, 1440]], kY = real ? (g.known?.yesterday ?? []) : [[0, 1440]], kD = real ? (g.known?.dayBefore ?? []) : [[0, 1440]], dbf = days.dayBefore ?? [];
  const sumIn = (iv, a, b) => iv.reduce((s, [x, y]) => s + Math.max(0, Math.min(y, b) - Math.max(x, a)), 0);
  const pctK = (known, out, a, b) => { const k = sumIn(known, a, b); return k >= 30 ? ((k - sumIn(out, a, b)) / k) * 100 : null; };
  const tp = pctK(kT, today, 0, upTo), yp = pctK(kY, yday, 0, 1440), dp = pctK(kD, dbf, 0, 1440);
  // "same hours": only the stretch of the day that both days have readings for
  const both = kT.flatMap(([a, b]) => kY.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([s, e]) => e > s)), bothMin = sumIn(both, 0, upTo);
  const dy = bothMin >= 60 ? pctK(both, today, 0, upTo) - pctK(both, yday, 0, upTo) : null, longest = today.reduce((m, [s, e]) => Math.max(m, e - s), 0);
  const delta = (d) => (d == null ? '<span class="muted">n/a yet</span>' : `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts</span>`);
  $("#gridStats").innerHTML = `<div class="mini"><div class="k">Power available today</div><div class="v">${tp == null ? "—" : tp.toFixed(1) + "<small>%</small>"}</div></div><div class="mini"><div class="k">vs yesterday, same hours</div><div class="v">${delta(dy)}</div></div><div class="mini"><div class="k">Outages today</div><div class="v">${today.length}<small>${longest ? " · longest " + dur(longest * 60000) : ""}</small></div></div>`;
  const row = (label, bar, pct, i) => `<div class="gb"><div class="gb-l">${label}</div><div class="gb-p">${pct == null ? "—" : pct.toFixed(0) + "%"}</div><div class="gb-bar" data-i="${i}">${bar}</div></div>`;
  const dbLabel = new Date(dayShift(now.date, -2) + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  gridRowsData = [{ label: "Today", out: today, known: kT, upTo }, { label: "Yesterday", out: yday, known: kY, upTo: 1440 }, { label: dbLabel, out: dbf, known: kD, upTo: 1440 }];
  if (!gridHold) $("#gridBars").innerHTML = row("Today", gridBar(today, upTo, true, kT), tp, 0) + row("Yesterday", gridBar(yday, 1440, false, kY), yp, 1) + row(dbLabel, gridBar(dbf, 1440, false, kD), dp, 2) + `<div class="gb gb-ax"><div class="gb-axis">${[0, 6, 12, 18, 24].map((h) => `<span>${h}:00</span>`).join("")}</div></div><div class="gcur" id="gridCur"></div><div class="tip" id="gridTip"></div>`; // not redrawn while a finger is holding the chart
  const dow = new Date(now.date + "T12:00:00Z").getUTCDay(), start = dayShift(now.date, -dow);
  const wk = real ? g.weeks : { current: weekOutages(start), previous: weekOutages(dayShift(start, -7)) };
  const lim = (i) => (i < dow ? 1440 : upTo), wkC = real ? g.weeksKnown.current : null, wkP = real ? g.weeksKnown.previous : null;
  let cH = 0, pH = 0, comparable = 0; const cols = [];
  for (let i = 0; i < 7; i++) {
    const L = lim(i), kc = real ? sumIn(wkC[i], 0, L) : L, kp = real ? sumIn(wkP[i], 0, L) : L;
    const c = i > dow || kc < 30 ? null : (kc - sumIn(wk.current[i], 0, L)) / 60; // hours of power, over the minutes that were measured
    if (c != null && kc >= L * 0.9 && kp >= L * 0.9) { cH += c; pH += (kp - sumIn(wk.previous[i], 0, L)) / 60; comparable++; } // only days that are (almost) fully measured in both weeks are compared
    cols.push({ c, fullPrev: real ? (sumIn(wkP[i], 0, 1440) >= 1296 ? Math.max(0, (1440 - sumIn(wk.previous[i], 0, 1440)) / 60) : null) : Math.max(0, 1440 - sumIn(wk.previous[i], 0, 1440)) / 60, i });
  }
  const change = comparable && pH > 0 ? ((cH - pH) / pH) * 100 : null, r = change == null ? null : Math.round(change), cls = r == null || r === 0 ? "flat" : r > 0 ? "up" : "down";
  $("#gridWeek").innerHTML = `<div class="wk-h"><div><div class="t">This week vs last week</div><div class="s">${comparable ? `${cH.toFixed(1)} h of power so far, against ${pH.toFixed(1)} h at the same point last week` : "Last week has no readings yet, so there is nothing to compare. This fills in once a full week of readings exists."}</div></div><div class="wk-pct ${cls}">${r == null ? "n/a" : (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r) + "%"}</div></div>
    <div class="wk">${cols.map(({ c, fullPrev, i }) => `<div class="wk-d ${i === dow ? "today" : i > dow ? "future" : ""}"><div class="wk-col">${c != null ? `<div class="wk-fill" style="height:${((c / 24) * 100).toFixed(1)}%"></div>` : ""}${fullPrev != null ? `<div class="wk-prev" style="bottom:${((fullPrev / 24) * 100).toFixed(1)}%"></div>` : ""}</div><div class="n">${DAYS[i]}</div><div class="v">${c != null ? c.toFixed(1) + " h" : ""}</div></div>`).join("")}</div>
    <div class="wk-key"><span><i style="width:10px;height:10px;border-radius:3px;background:var(--ok)"></i>This week</span><span><i style="width:16px;border-top:2px dashed var(--text);opacity:.6"></i>Last week's full day</span></div>`;
  const gaps = real && (kT.length === 0 || sumIn(kT, 0, upTo) < upTo - 5 || sumIn(kY, 0, 1440) < 1435);
  set("#gridNote", real ? (!(g.firstMs) ? "Waiting for the first reading." : gaps ? "Grey means nothing was measured there (before measuring began, or the phone or agent was off)." : "") : "Sample data. Name a plug on a grid-fed socket \"Grid\" and set its type to Grid in Settings, and this shows when public power was actually available.");
}

/* ================= router ================= */
const tilesR = (items) => items.map(([cls, icon, k, v, unit, note]) => `<div class="card tile"><div class="ti ${cls}">${iconSvg(icon)}</div><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div><div class="n">${note}</div></div>`).join("");
function updateRouter() {
  const r = S.router || {}, stale = r.agentStale, map = { 0: ["ok", "All good"], 1: ["warn", "Degraded"], 2: ["bad", "Internet down"], 3: ["bad", "Router unreachable"] };
  let [lvl, text] = r.status == null ? ["", "No data yet"] : map[r.status];
  if (stale) { lvl = ""; text = "Home agent offline"; }
  const chip = $("#rChip"); chip.className = "chip " + lvl; chip.textContent = stale ? "AGENT OFFLINE" : { ok: "ONLINE", warn: "DEGRADED", bad: "PROBLEM", "": "WAITING" }[lvl];
  set("#rStatus", text);
  set("#rSub", stale ? (r.agentAt ? `Last heard from home ${ago(r.agentAt)}` : "Start the agent at home to see router status here.") : `Gateway ${r.gateway || "unknown"}${r.at ? " · checked " + ago(r.at) : ""}`);
  $("#rArc").setAttribute("stroke", { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", "": "var(--faint)" }[lvl]);
  set("#rUp", r.uptime24 == null ? "" : r.uptime24 + "% uptime" + (r.coverageMin != null && r.coverageMin < 1380 ? " · last " + (r.coverageMin < 90 ? r.coverageMin + " min" : Math.round(r.coverageMin / 60) + " h") : ""));
  $("#rStrip").innerHTML = (r.strip || Array(48).fill(null)).map((s) => `<i class="${s == null ? "" : "s" + s}"></i>`).join("");
  const ms = (v) => (stale || v == null ? ["Offline", ""] : [String(v), " ms"]), [gw, gwu] = ms(r.gwMs), [nt, ntu] = ms(r.netMs);
  $("#rTiles").innerHTML = tilesR([["t-ok", "wifi", "Router ping", gw, gwu, "to your router"], ["t-blue", "globe", "Internet ping", nt, ntu, "to the wider internet"],
    ["t-warn", "loss", "Packet loss", stale || r.netLoss == null ? "Offline" : String(r.netLoss), stale || r.netLoss == null ? "" : "%", "lower is better"], ["t-purple", "phone", "Devices seen", stale ? "Offline" : String(r.zte?.ok && r.zte.devices ? r.zte.devices.filter((d) => d.alive !== false).length : r.devices ?? 0), "", "on your network"]]); // the router's own list when we can read it: the phone alone can't see every device
  const o = r.outages || [];
  $("#rOut").innerHTML = o.length ? o.map((x) => `<div><span>${x.kind === "router" ? "Router unreachable" : "Internet down"} · ${new Date(x.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span><b>${x.end ? dur(x.end - x.start) : "ongoing"}</b></div>`).join("") : "<div><span>No outages recorded</span><b></b></div>";
}
const bytes = (n) => n == null ? "0 MB" : n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
const qual = (v, cuts) => v == null ? ["Unknown", ""] : v >= cuts[0] ? ["Excellent", "ok"] : v >= cuts[1] ? ["Good", "ok"] : v >= cuts[2] ? ["Fair", "warn"] : ["Poor", "bad"];
function updateZte() {
  const z = S.router?.zte || {}, card = (id, title, html, chip = "") => { $(id).innerHTML = `<div class="card-h"><h2>${title}</h2>${chip}</div>${html}`; }, all = ["#zSignal", "#zConn", "#zDevices", "#zUsage"];
  if (!z.configured) { all.forEach((id, i) => { $(id).hidden = i > 0; }); return card("#zSignal", "Router admin page", `<div class="callout">Add the router's admin password to the home agent's <code>.env</code> as <code>ROUTER_PASSWORD=</code> and restart it to unlock signal, connection and device details.</div>`); }
  all.forEach((id) => { $(id).hidden = false; });
  if (z.ok && z.modem === "modem_undetected") { // the router isn't using a SIM, so there is no signal or mobile data to show
    card("#zSignal", "Connection", '<div class="row"><div><div class="status-big">Wired internet</div><div class="muted" style="font-size:13.5px">The internet reaches this router over a cable, so it has no signal of its own to report.</div></div></div>');
    $("#zConn").hidden = true; $("#zUsage").hidden = true; $("#zDevices").hidden = false;
    const devs = z.devices || []; return card("#zDevices", "Connected devices", devs.length ? devs.map((d) => `<div class="dev-row" style="${d.alive === false ? "opacity:.5" : ""}"><div>${esc(d.name)}<br><span>${esc(d.mac || "")}</span></div><span>${d.alive === false ? "Not responding" + (d.lastSeenAt ? " · last seen " + ago(d.lastSeenAt) : "") : esc(d.ip || "")}</span></div>`).join("") : '<div class="muted">The router did not report a device list.</div>', `<span class="chip">${devs.filter((d) => d.alive !== false).length}</span>`);
  }
  if (!z.ok) { const msg = `<div class="callout">Couldn't read the router admin page${z.error ? `: ${esc(z.error)}` : ""}. Retrying every 20 seconds.</div>`; card("#zSignal", "Signal", msg); ["#zConn", "#zDevices", "#zUsage"].forEach((id, i) => card(id, ["Connection", "Connected devices", "Data usage"][i], '<div class="muted">Waiting for the router.</div>')); return; }
  const [rq, rl] = qual(z.rsrp, [-80, -90, -100]), [, sl] = qual(z.sinr, [20, 13, 0]), lvl = rl === "bad" || sl === "bad" ? "bad" : rl === "warn" || sl === "warn" ? "warn" : "";
  const bars = [12, 17, 22, 28, 34].map((h, i) => `<i style="height:${h}px" class="${i < nz(z.bars) ? "on" : ""}"></i>`).join(""), pct = Math.max(0, Math.min(100, ((nz(z.rsrp) + 120) / 50) * 100));
  card("#zSignal", "Signal", `<div class="row"><div class="bars ${lvl}">${bars}</div><div><div class="status-big">${esc(z.type || "Unknown")}</div><div class="muted" style="font-size:13.5px">${esc(z.provider || "")}</div></div></div><div class="meter"><i style="width:${pct}%"></i></div>
    <div class="kv" style="margin-top:16px;grid-template-columns:repeat(3,minmax(0,1fr))"><div><div class="k">Power</div><div class="v">${nz(z.rsrp)}<small> dBm</small></div></div><div><div class="k">Quality</div><div class="v">${nz(z.sinr)}<small> dB</small></div></div><div><div class="k">Band</div><div class="v" style="font-size:17px">${esc(z.band || "Unknown")}</div></div></div>
    <div class="faint" style="margin-top:12px">Aim or move the unit and watch these. Power above -90 dBm and quality above 13 dB is good.</div>`, `<span class="chip ${rl}">${rq}</span>`);
  card("#zConn", "Connection", `<div class="kv"><div><div class="k">Public IP</div><div class="v" style="font-size:16px">${esc(z.wanIp || "Unknown")}</div></div><div><div class="k">Connected for</div><div class="v">${z.uptimeS == null ? "Unknown" : dur(z.uptimeS * 1000)}</div></div><div><div class="k">Network</div><div class="v">${esc(z.provider || "Unknown")}</div></div><div><div class="k">Firmware</div><div class="v" style="font-size:13px">${esc(z.firmware || "Unknown")}</div></div></div>`, `<span class="chip ${z.connected ? "ok" : "bad"}">${z.connected ? "CONNECTED" : "DISCONNECTED"}</span>`);
  const devs = z.devices || [];
  card("#zDevices", "Connected devices", devs.length ? devs.map((d) => `<div class="dev-row" style="${d.alive === false ? "opacity:.5" : ""}"><div>${esc(d.name)}<br><span>${esc(d.mac || "")}</span></div><span>${d.alive === false ? "Not responding" + (d.lastSeenAt ? " · last seen " + ago(d.lastSeenAt) : "") : esc(d.ip || "")}</span></div>`).join("") : '<div class="muted">The router didn\'t report a device list.</div>', `<span class="chip">${devs.filter((d) => d.alive !== false).length}</span>`);
  card("#zUsage", "Data usage", `<div class="kv"><div><div class="k">This session, down</div><div class="v">${bytes(z.rx)}</div></div><div><div class="k">This session, up</div><div class="v">${bytes(z.tx)}</div></div><div><div class="k">This month, down</div><div class="v">${bytes(z.monthRx)}</div></div><div><div class="k">This month, up</div><div class="v">${bytes(z.monthTx)}</div></div></div>`);
}

/* ================= new-device banner ================= */
function updateBanner() {
  const el = $("#newBanner"), found = S?.discovered ?? [];
  let dismissed = ""; try { dismissed = sessionStorage.getItem("dismissedNew") || ""; } catch {}
  const ids = found.map((d) => d.id).join(",");
  if (!found.length || ids === dismissed) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `<div class="card banner"><div><b>${found.length === 1 ? "New device found" : `${found.length} new devices found`}</b><div class="muted">${esc(found.map((d) => d.name).slice(0, 3).join(", "))}${found.length > 3 ? ` and ${found.length - 3} more` : ""} on your Smart Life account</div></div><div style="display:flex;gap:8px"><button class="btn sm ghost" data-banner="dismiss">Not now</button><button class="btn sm primary" data-banner="add">Set up</button></div></div>`;
}

/* ================= settings ================= */
let setSig = "", limSig = "";
function applyTheme(t) {
  try { if (t === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", t); } catch {}
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  updateTheme();
}
function updateTheme() {
  let cur = "auto"; try { cur = localStorage.getItem("theme") || "auto"; } catch {}
  $("#setTheme").innerHTML = `<div class="card-h"><h2>Appearance</h2></div><div class="seg theme-seg" role="group" aria-label="Theme">${["auto", "light", "dark"].map((t) => `<button data-theme="${t}" aria-pressed="${t === cur}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>`;
}
const setRow = (ico, main, sub, right, first) => `<div class="set-row ${first ? "first" : ""}"><div class="set-ico">${ico}</div><div class="set-main"><b>${esc(main)}</b><span>${sub}</span></div>${right}</div>`;
function updateSettings() {
  if (!S) return;
  const sig = JSON.stringify([S.plugs.map((p) => [p.id, p.name, p.role, p.icon, p.online]), S.discovered, S.removed, S.schedules.map((s) => ({ ...s, lastDone: 0 })), user?.email]);
  const ae = document.activeElement; if (sig === setSig || (ae && $("#tab-settings").contains(ae) && ae.matches("input"))) { updateAboutLive(); return; }
  setSig = sig;
  const devs = S.plugs, first = (i) => i === 0;
  $("#setDevices").innerHTML = `<div class="card-h"><h2>Devices</h2><button class="btn sm" id="refreshDevices">Refresh from Smart Life</button></div>
    ${devs.length ? devs.map((p, i) => setRow(iconSvg(p.icon), p.name, `${ROLES[p.role]?.short || "Appliance"} · ${p.online === false ? "Offline" : p.online ? "Online" : "Waiting for data"}`, `<button class="kebab" data-menu="dev:${esc(p.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(p.name)}">${KEBAB}</button>`, first(i))).join("") : '<div class="set-empty">No devices on the dashboard yet.</div>'}
    ${S.discovered.length ? `<div class="set-sub">New on your Smart Life account</div>${S.discovered.map((d, i) => setRow(iconSvg(d.category === "dj" ? "bulb" : "plug"), d.name, `${CATEGORY[d.category] || "Device"} · ${d.online ? "Online" : "Offline"}`, `<button class="btn sm primary" data-add-device="${esc(d.id)}">Add</button>`, first(i))).join("")}` : ""}
    ${S.removed.length ? `<div class="set-sub">Removed from dashboard</div>${S.removed.map((d, i) => setRow(iconSvg(d.icon), d.name, "Hidden", `<button class="btn sm" data-restore="${esc(d.id)}">Restore</button>`, first(i))).join("")}` : ""}`;
  const names = Object.fromEntries(S.plugs.map((p) => [p.id, p]));
  $("#setSchedules").innerHTML = `<div class="card-h"><h2>Schedules</h2><button class="btn sm primary" id="addSched">Add schedule</button></div>
    ${S.schedules.length ? S.schedules.map((s, i) => { const d = names[s.deviceId]; return setRow(iconSvg(d?.icon || "clock"), `${s.action === "on" ? "Turn on" : "Turn off"} · ${fmt12(s.at)}`, `${esc(d?.name || "Unknown device")} · ${daysLabel(s.days)}${s.gridCheck?.enabled ? ` · skipped if Grid on ${s.gridCheck.minSupplyMin}+ of ${s.gridCheck.windowMin} min` : ""}`, `<button class="switch sm" role="switch" aria-checked="${s.enabled}" data-sched-toggle="${esc(s.id)}" aria-label="Schedule on or off"></button><button class="kebab" data-menu="sched:${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Schedule options">${KEBAB}</button>`, first(i)); }).join("") : '<div class="set-empty">No schedules yet. Add one to switch a device on or off automatically.</div>'}`;
  updateTheme(); updateAbout();
}
function updateLimits() {
  const sig = JSON.stringify(S.limits), ae = document.activeElement;
  if (sig === limSig || (ae && ae.id && ["limTarget", "limLimit"].includes(ae.id))) return; limSig = sig;
  $("#setLimits").innerHTML = `<div class="card-h"><h2>Power limits</h2></div><div class="num-row"><div class="field" style="margin-top:0"><label for="limTarget">Target (W)</label><input class="input" id="limTarget" type="number" inputmode="numeric" min="50" step="10" value="${S.limits.warn}"></div><div class="field" style="margin-top:0"><label for="limLimit">Limit (W)</label><input class="input" id="limLimit" type="number" inputmode="numeric" min="100" step="10" value="${S.limits.limit}"></div></div>
    <div class="help" style="margin-top:12px">The target is the level you'd like to stay under; the line turns amber above it. The limit is the most the tank can supply; the line turns red above it.</div><div class="dlg-actions" style="margin-top:14px"><button class="btn primary" id="saveLimits">Save limits</button></div>`;
}
function updateAbout() {
  const r = S.router || {};
  $("#setAbout").innerHTML = `<div class="card-h"><h2>Account and data</h2></div>
    ${setRow(iconSvg("phone"), user?.email || "Signed in", "Your Google account. Only this account can open and control Tenergy.", '<button class="btn sm" id="signOutBtn">Sign out</button>', true)}
    ${setRow(iconSvg("wifi"), "Router monitor", r.agentStale ? "The home agent is offline, so router details aren't updating." : "The home agent is reporting.", `<span class="chip ${r.agentStale ? "" : "ok"}">${r.agentStale ? "OFFLINE" : "ONLINE"}</span>`)}
    ${setRow(iconSvg("globe"), "Smart Life devices", `<span id="aboutChecked"></span>`, "")}
    <div class="help" style="margin-top:14px">Tenergy 2.0 · build 4</div>`;
  updateAboutLive();
}
function updateAboutLive() { const el = $("#aboutChecked"); if (el && S) el.textContent = S.tuyaAt ? `Last checked ${ago(S.tuyaAt)}. New switches are picked up automatically.` : "Not checked yet."; }

/* ================= automation ================= */
let autoSig = "", autoSetSig = "", alertSetSig = "", weakSig = "";
const hrs = (h) => (h < 1 ? Math.round(h * 60) + " min" : (Math.round(h * 10) / 10) + " h");
function updateAuto() {
  const box = $("#autoCard"); if (!box || !S?.auto) return;
  const A = S.auto, st = A.status, m = A.mode, c = A.cfg, has = S.plugs.some((p) => p.role === "fridge"); box.hidden = !has; if (!has) return;
  const sig = JSON.stringify([m, A.manualUntil, st, A.recent.map((r) => r.t), Math.floor(Date.now() / 60000)]); if (sig === autoSig) return; autoSig = sig;
  const head = m === "auto" ? "Running the fridge" : m === "manual" ? "Manual: fan and light are yours" : "Absolute: fan and light are yours";
  const sub = !st ? "Waiting for the first check" : m !== "auto" && st.hold ? `Fridge held ${st.hold.on ? "on" : "off"} by you${st.hold.until ? ` until ${clock(st.hold.until)}, when Automatic takes over again` : " until you change the mode or switch it again"}. ${esc(st.reason.startsWith("Held") ? "" : st.reason)}` : m === "auto" ? esc(st.reason) : m === "absolute" ? `${esc(st.reason)}. No time limit: it stays like this until you change it.` : `${esc(st.reason)}. Automatic is back at ${clock(A.manualUntil)} (in ${dur(A.manualUntil - Date.now())}).`;
  const facts = st ? `Fridge on ${hrs(st.dayOnMin / 60)} today · fridge stops at ${c.emergency}%${c.cutOn ? ` · tank output off at ${c.cutAt}%` : ""}${st.cutAt ? ` · ⚫ tank output was cut at ${clock(st.cutAt)}` : ""}` : "";
  box.innerHTML = `<div class="card-h"><h2>Automation</h2></div><div class="seg au-seg" role="group" aria-label="Mode">${[["auto", "Auto"], ["manual", "Manual"], ["absolute", "Absolute"]].map(([k, l]) => `<button data-auto-mode="${k}" aria-pressed="${m === k}">${l}</button>`).join("")}</div>
    <div class="au-status">${head}</div><div class="au-line">${sub}</div>${facts ? `<div class="au-facts">${facts}</div>` : ""}
    ${A.recent.length ? `<div class="au-log">${A.recent.slice(0, 5).map((r) => `<div><time>${new Date(r.t).toDateString() === new Date().toDateString() ? clock(r.t) : new Date(r.t).toLocaleDateString([], { weekday: "short" }) + " " + clock(r.t)}</time><span>${esc(r.msg)}</span></div>`).join("")}</div>` : ""}`;
}
let sliderOpen = false, sliderPending = null; // the slider stays locked until Change is pressed, and only Apply saves it, so a swipe can't change the rhythm
const THROTTLES = [[105, 15], [90, 30], [75, 45], [60, 60]]; // day throttle steps, always 120 minutes: more on = a cooler fridge, more off = more charge for the tank
function updateWeak() {
  const box = $("#weakBox"); if (!box || !S?.auto || !S.plugs.some((p) => p.role === "fridge")) return;
  const A = S.auto, w = A.cfg.weak, d = A.cfg.dayThrottle, sig = JSON.stringify([A.weak, A.dayThrottle, w, d, sliderOpen, sliderPending]); if (sig === weakSig || document.activeElement?.id === "dayLevel") return; weakSig = sig;
  const lv = THROTTLES.findIndex(([on]) => on === d.onMin), cur = lv >= 0 ? lv : THROTTLES.reduce((b, t, i) => (Math.abs(t[0] - d.onMin) < Math.abs(THROTTLES[b][0] - d.onMin) ? i : b), 0), shownIdx = sliderOpen ? sliderPending ?? cur : cur;
  const row = (name, on, onText, offText, attr) => `<div class="au-tog"><span><b>${name}</b><br><span class="faint" style="font-size:12.5px">${on ? onText : offText}</span></span><button class="switch sm" role="switch" aria-checked="${on}" ${attr} aria-label="${name}"></button></div>`;
  box.innerHTML = row("Day throttle", Boolean(A.dayThrottle), `Fridge ${d.onMin} min on, ${d.offMin} off until the night plan starts`, "Off: the fridge stays on in the day", "data-day")
    + `<div class="au-slide"><div class="au-slide-h"><span>Throttle</span><b id="dayLevelText">${THROTTLES[shownIdx][0]} on / ${THROTTLES[shownIdx][1]} off</b></div>${sliderOpen ? `<input type="range" id="dayLevel" min="0" max="${THROTTLES.length - 1}" step="1" value="${shownIdx}" aria-label="Day throttle level"><div class="au-slide-e"><span>Cooler fridge</span><span>More charge</span></div><div class="au-slide-btn"><button class="btn sm primary" data-sl-apply>Apply</button><button class="btn sm" data-sl-cancel>Cancel</button></div>` : `<div class="au-slide-btn"><button class="btn sm" data-sl-open>Change</button></div>`}</div>`
    + row("Weak night", Boolean(A.weak), `Fridge ${w.onMin} min on, ${w.offMin} off · ends itself at ${w.endAt}%`, "Off: the normal night plan", "data-weak");
}
const auNum = (id, label, v, step = 1, unit = "") => `<div class="field"><label for="au-${id}">${label}${unit ? " (" + unit + ")" : ""}</label><input class="input" id="au-${id}" type="number" inputmode="decimal" step="${step}" value="${v}"></div>`;
const auTime = (id, label, v) => `<div class="field"><label for="au-${id}">${label}</label><input class="input" id="au-${id}" type="time" value="${v}"></div>`;
const auTog = (id, label, on, help = "") => `<div class="au-tog"><span>${label}${help ? `<br><span class="faint" style="font-size:12.5px">${help}</span>` : ""}</span><button class="switch sm" role="switch" aria-checked="${on}" data-au-tog="${id}" aria-label="${esc(label)}"></button></div>`;
function updateAlertSettings() {
  const box = $("#setAlerts"); if (!box || !S?.alerts) return;
  const c = S.alerts.cfg, sig = JSON.stringify([c, S.alerts.configured]), ae = document.activeElement; if (sig === alertSetSig || (ae && box.contains(ae) && ae.matches("input"))) return; alertSetSig = sig;
  box.innerHTML = `<div class="card-h"><h2>Telegram alerts</h2>${S.alerts.configured ? '<button class="btn sm" id="testAlert">Send a test</button>' : '<span class="chip warn">NOT SET UP</span>'}</div>
    ${auTog("al-enabled", "Send alerts", c.enabled)}
    <div class="au-h">Urgent</div>
    ${auTog("al-emergency", "Battery at the fridge level, no grid", c.emergency)}${auTog("al-cut", "Tank output switched off or back on", c.cut)}${auTog("al-overload", "Power tank over its limit", c.overload)}${auTog("al-tankOff", "House has no power (tank output off, no grid)", c.tankOff)}
    ${auTog("al-fridgeOffline", "Fridge plug offline", c.fridgeOffline)}<div class="au-grid">${auNum("al-fridgeOfflineMin", "Fridge offline for", c.fridgeOfflineMin, 1, "min")}</div>
    <div class="au-h">Good to know</div>
    ${auTog("al-grid", "Grid came on or went off", c.grid)}${auTog("al-frost", "Night plan reminders (fan and lights)", c.frost)}${auTog("al-tuyaCloud", "Tuya cloud refusing requests (once a day)", c.tuyaCloud)}${auTog("al-plugMismatch", "Phone and Tuya cloud disagree about a switch", c.plugMismatch)}${auTog("al-fridgeStuck", "Fridge will not switch as the rules want", c.fridgeStuck)}${auTog("al-weakNudge", "Suggest Weak night when the battery is low at sunset", c.weakNudge)}${auTog("al-readingStale", "Tank display not readable for a while", c.readingStale)}${auTog("al-agentOffline", "Home agent (the phone) offline", c.agentOffline)}${auTog("al-cameraDown", "Camera server on the phone stopped", c.cameraDown)}<div class="au-grid">${auNum("al-agentOfflineMin", "Agent offline for", c.agentOfflineMin, 1, "min")}</div>
    ${auTog("al-daily", "Daily summary", c.daily)}<div class="au-grid"><div class="field"><label for="au-al-dailyAt">Summary time</label><input class="input" id="au-al-dailyAt" type="time" value="${c.dailyAt}"></div>${auNum("al-repeatMin", "Repeat a lasting problem every", c.repeatMin, 10, "min")}</div>
    <div class="dlg-actions" style="margin-top:16px"><button class="btn primary" id="saveAlerts">Save</button></div>`;
}
function updateAutoSettings() {
  const box = $("#setAuto"); if (!box || !S?.auto) return;
  const c = S.auto.cfg, sig = JSON.stringify(c), ae = document.activeElement; if (sig === autoSetSig || (ae && box.contains(ae) && ae.matches("input"))) return; autoSetSig = sig;
  box.innerHTML = `<div class="card-h"><h2>Automation settings</h2></div>
    <div class="au-h">Fridge at night (no grid)</div><div class="au-grid">${auTime("nt-from", "Starts at", c.night.from)}${auTime("nt-to", "Until", c.night.to)}${auNum("nt-onMin", "On for", c.night.onMin, 5, "min")}${auNum("nt-offMin", "Off for", c.night.offMin, 5, "min")}${auTime("nt-fan", "Fan allowed until", c.night.fanUntil)}</div>${auTog("nt-offFirst", "Start the night with the fridge resting", c.night.offFirst)}
    <div class="au-h">Day throttle</div><div class="au-grid">${auNum("dy-onMin", "On for", c.dayThrottle.onMin, 5, "min")}${auNum("dy-offMin", "Off for", c.dayThrottle.offMin, 5, "min")}</div>
    <div class="au-h">Weak night</div><div class="au-grid">${auNum("wk-onMin", "On for", c.weak.onMin, 5, "min")}${auNum("wk-offMin", "Off for", c.weak.offMin, 5, "min")}${auNum("wk-endAt", "Ends itself at", c.weak.endAt, 1, "%")}</div>
    <div class="au-h">Battery levels (no grid)</div><div class="au-grid">${auNum("emergency", "Fridge stops at", c.emergency, 1, "%")}${auNum("cutAt", "Tank output off at", c.cutAt, 1, "%")}${auNum("restoreAt", "Tank output back on at", c.restoreAt, 1, "%")}${auNum("staleMin", "Battery reading counts as old after", c.staleMin, 5, "min")}${auNum("manualH", "Manual lasts", c.manualH, 0.25, "hours")}</div>
    ${auTog("cutOn", "Switch the tank output off at the cut-off level", c.cutOn)}${auTog("gridOnFridgeOn", "Fridge on whenever the grid is on", c.gridOnFridgeOn)}${auTog("overloadShed", "Protect the tank from overload", c.overloadShed)}
    <div class="dlg-actions" style="margin-top:16px"><button class="btn primary" id="saveAuto">Save</button></div>
    <div class="au-h">Data log</div><div class="faint" style="margin-bottom:10px">Every reading, switch and decision, every 2 minutes, kept for 120 days.</div>
    <div class="au-actions" style="margin-top:0"><button class="btn sm" data-au-dl="datalog">Download readings (7 days)</button><button class="btn sm" data-au-dl="events">Download events (7 days)</button></div>`;
}
async function downloadLog(table) {
  try {
    const r = await fetch(API + `/api/log/export?table=${table}&days=7&fmt=csv`, { headers: { Authorization: "Bearer " + (await auth.currentUser.getIdToken()) } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `tenergy-${table}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast("Couldn't download: " + e.message); }
}
document.addEventListener("input", (e) => { if (e.target.id === "dayLevel") { sliderPending = Number(e.target.value); const t = THROTTLES[sliderPending]; $("#dayLevelText").textContent = `${t[0]} on / ${t[1]} off`; } });
document.addEventListener("click", async (e) => {
  const m = e.target.closest("[data-auto-mode]");
  if (m) {
    const to = m.dataset.autoMode; if (!S?.auto || S.auto.mode === to) return;
    return void (await change(() => post("/api/auto/save", { mode: to }), { auto: "Automatic is on", manual: "Manual: the fan and light are yours for a while", absolute: "Absolute: the fan and light are yours, no time limit" }[to]));
  }
  if (e.target.closest("[data-sl-open]")) { const d = S.auto.cfg.dayThrottle, i = THROTTLES.findIndex(([on]) => on === d.onMin); sliderOpen = true; sliderPending = i >= 0 ? i : 1; weakSig = ""; return void updateWeak(); }
  if (e.target.closest("[data-sl-cancel]")) { sliderOpen = false; sliderPending = null; weakSig = ""; return void updateWeak(); }
  if (e.target.closest("[data-sl-apply]")) { const t = THROTTLES[sliderPending ?? 1]; sliderOpen = false; sliderPending = null; weakSig = ""; return void (await change(() => post("/api/auto/save", { cfg: { dayThrottle: { onMin: t[0], offMin: t[1] } }, restart: true }), `Day throttle: ${t[0]} on, ${t[1]} off, resting first`)); }
  const dy = e.target.closest("[data-day]"); if (dy) return void (await change(() => post("/api/auto/day", { on: dy.getAttribute("aria-checked") !== "true" }), dy.getAttribute("aria-checked") !== "true" ? "Day throttle is on" : "Day throttle is off"));
  const wk = e.target.closest("[data-weak]"); if (wk) return void (await change(() => post("/api/auto/weak", { on: wk.getAttribute("aria-checked") !== "true" }), wk.getAttribute("aria-checked") !== "true" ? "Weak night is on" : "Weak night is off"));
  const t = e.target.closest("[data-au-tog]"); if (t) return void t.setAttribute("aria-checked", t.getAttribute("aria-checked") !== "true");
  const dl = e.target.closest("[data-au-dl]"); if (dl) return void (await downloadLog(dl.dataset.auDl));
  if (e.target.closest("#testAlert")) return void (await change(() => post("/api/alerts/test", {}), "Test sent, check Telegram"));
  const n = (id) => Number($("#au-" + id).value), on = (id) => $(`[data-au-tog="${id}"]`).getAttribute("aria-checked") === "true";
  if (e.target.closest("#saveAlerts")) {
    const cfg = { enabled: on("al-enabled"), emergency: on("al-emergency"), cut: on("al-cut"), overload: on("al-overload"), tankOff: on("al-tankOff"), fridgeOffline: on("al-fridgeOffline"), grid: on("al-grid"), frost: on("al-frost"), tuyaCloud: on("al-tuyaCloud"), plugMismatch: on("al-plugMismatch"), fridgeStuck: on("al-fridgeStuck"), weakNudge: on("al-weakNudge"), readingStale: on("al-readingStale"), agentOffline: on("al-agentOffline"), cameraDown: on("al-cameraDown"), daily: on("al-daily"),
      fridgeOfflineMin: n("al-fridgeOfflineMin"), agentOfflineMin: n("al-agentOfflineMin"), repeatMin: n("al-repeatMin"), dailyAt: $("#au-al-dailyAt").value };
    alertSetSig = ""; await change(() => post("/api/alerts/save", { cfg }), "Alert settings saved"); return;
  }
  if (e.target.closest("#saveAuto")) {
    const cfg = { emergency: n("emergency"), cutAt: n("cutAt"), restoreAt: n("restoreAt"), staleMin: n("staleMin"), manualH: n("manualH"), cutOn: on("cutOn"), gridOnFridgeOn: on("gridOnFridgeOn"), overloadShed: on("overloadShed"),
      night: { from: $("#au-nt-from").value, to: $("#au-nt-to").value, onMin: n("nt-onMin"), offMin: n("nt-offMin"), fanUntil: $("#au-nt-fan").value, offFirst: on("nt-offFirst") }, weak: { onMin: n("wk-onMin"), offMin: n("wk-offMin"), endAt: n("wk-endAt") }, dayThrottle: { onMin: n("dy-onMin"), offMin: n("dy-offMin") } };
    autoSetSig = ""; await change(() => post("/api/auto/save", { cfg }), "Automation settings saved");
  }
});

/* ================= battery camera + home agent ================= */
const photoCache = new Map(); // photo time -> object URL (the pictures need the sign-in header, so <img src> can't fetch them directly)
async function photoUrl(t) {
  if (photoCache.has(t)) return photoCache.get(t);
  const headers = {}; if (!devApi) headers.Authorization = "Bearer " + (await auth.currentUser.getIdToken());
  const r = await fetch(`${API}/api/battery/photo?t=${t}`, { headers }); if (!r.ok) throw new Error("no photo");
  const url = URL.createObjectURL(await r.blob()); photoCache.set(t, url);
  if (photoCache.size > 24) { const [k, v] = photoCache.entries().next().value; URL.revokeObjectURL(v); photoCache.delete(k); }
  return url;
}
async function openPhoto(t, caption) {
  try { const u = await photoUrl(t); $("#photoWrap").innerHTML = `<img src="${u}" alt="Photo of the power tank's display">`; $("#photoCap").textContent = caption || new Date(t).toLocaleString(); $("#photoDlg").showModal(); }
  catch { toast("Couldn't load that photo"); }
}
async function photoNow() {
  const before = S.agent?.lastPhotoAt ?? null;
  try { await post("/api/agent/photo-now", {}); } catch (e) { return toast(e.message); }
  toast(S.agent?.live ? "Reading now: light on, 3 photos…" : "Requested, but the home agent isn't connected right now");
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 4000)); await tick(true); if (S.agent?.lastPhotoAt !== before) return toast(S.agent?.lastPhotoPct != null ? `Read ${S.agent.lastPhotoPct}%. Compare it with the photo.` : "New photo received, but the number couldn't be read"); }
  toast("No new photo yet. Is the home agent running?");
}
/* ---- battery history chart ---- */
let battRange = 24; const BH = {};
async function loadBattHistory() {
  if (!user || (document.hidden && !devApi)) return;
  try { BH[battRange] = await api(`/api/battery/history?hours=${battRange}`); renderBattChart(); } catch {}
}
function battColor(p) { return p <= 15 ? "var(--bad)" : p <= 35 ? "var(--warn)" : "var(--ok)"; }
function renderBattChart() {
  const data = BH[battRange], box = $("#battChart"); if (!box || !box.clientWidth) return;
  const W = box.clientWidth, Ht = box.clientHeight || 170, m = { l: 30, r: 8, t: 10, b: 22 }, pw = W - m.l - m.r, ph = Ht - m.t - m.b;
  if (!data || data.points.length < 2) { box.innerHTML = '<div class="set-empty" style="padding-top:60px">' + (data ? "Not enough readings yet." : "Loading…") + '</div><div class="tip" id="battTip"></div>'; return; }
  const { from, to, points } = data, X = (t) => m.l + ((t - from) / (to - from)) * pw, Y = (p) => m.t + (1 - p / 100) * ph;
  const steps = points.slice(1).map((p, i) => p[0] - points[i][0]).sort((a, b) => a - b), gap = Math.max(25 * 60e3, (steps[Math.floor(steps.length / 2)] || 0) * 4); // a pause longer than this is a gap, not a slope
  const segs = []; let cur = []; points.forEach((p, i) => { if (i && p[0] - points[i - 1][0] > gap) { segs.push(cur); cur = []; } cur.push(p); }); segs.push(cur);
  const line = (s) => s.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join(" ");
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="gl"/>${v % 50 === 0 ? `<text x="${m.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" class="ax">${v}</text>` : ""}`).join("");
  const hours = data.hours, fmt = hours > 24 ? (t) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(t).getDay()] : (t) => clock(t), nTicks = W < 420 ? 4 : 6;
  // 7 days: one label at each midnight, so the day names sit where the day starts; shorter ranges: evenly spaced times
  const tickTimes = hours > 24 ? (() => { const o = [], d = new Date(from); d.setHours(24, 0, 0, 0); while (d.getTime() < to) { o.push(d.getTime()); d.setDate(d.getDate() + 1); } return o; })() : Array.from({ length: nTicks + 1 }, (_, i) => from + ((to - from) * i) / nTicks);
  const ticks = tickTimes.map((t, i) => `<text x="${X(t).toFixed(1)}" y="${Ht - 6}" text-anchor="${hours > 24 ? "middle" : i === 0 ? "start" : i === tickTimes.length - 1 ? "end" : "middle"}" class="ax">${fmt(t)}</text>`).join("");
  const last = points[points.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Battery percentage over time">
    <defs><linearGradient id="bgl" gradientUnits="userSpaceOnUse" x1="0" y1="${Y(100)}" x2="0" y2="${Y(0)}"><stop offset="0" stop-color="var(--ok)"/><stop offset="0.62" stop-color="var(--ok)"/><stop offset="0.66" stop-color="var(--warn)"/><stop offset="0.84" stop-color="var(--warn)"/><stop offset="0.86" stop-color="var(--bad)"/><stop offset="1" stop-color="var(--bad)"/></linearGradient>
    <linearGradient id="bga" gradientUnits="userSpaceOnUse" x1="0" y1="${Y(100)}" x2="0" y2="${Y(0)}"><stop offset="0" stop-color="var(--ok)" stop-opacity=".28"/><stop offset="1" stop-color="var(--ok)" stop-opacity="0"/></linearGradient></defs>
    ${grid}${ticks}
    ${segs.map((s) => s.length > 1 ? `<path d="${line(s)} L${X(s[s.length - 1][0]).toFixed(1)} ${Y(0)} L${X(s[0][0]).toFixed(1)} ${Y(0)} Z" fill="url(#bga)"/><path d="${line(s)}" fill="none" stroke="url(#bgl)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` : "").join("")}
    <line id="bcx" y1="${m.t}" y2="${m.t + ph}" class="gl" style="stroke:var(--faint);display:none"/><circle id="bcd" r="5" style="display:none" fill="var(--text)" stroke="var(--card)" stroke-width="2"/>
    <circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="4" fill="${battColor(last[1])}" stroke="var(--card)" stroke-width="2"/></svg><div class="tip" id="battTip"></div>`;
  const tip = $("#battTip"), cx = $("#bcx"), cd = $("#bcd"), svg = box.querySelector("svg");
  const show = (ev) => { const r = svg.getBoundingClientRect(), x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left; let best = points[0], bd = Infinity; for (const p of points) { const d = Math.abs(X(p[0]) - x); if (d < bd) { bd = d; best = p; } } const px = X(best[0]);
    cx.setAttribute("x1", px); cx.setAttribute("x2", px); cx.style.display = ""; cd.setAttribute("cx", px); cd.setAttribute("cy", Y(best[1])); cd.style.display = "";
    tip.innerHTML = `<div class="t">${hours > 24 ? new Date(best[0]).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : clock(best[0])}</div><b>${best[1]}%</b>`; tip.style.display = "block"; tip.style.left = Math.min(W - 40, Math.max(40, px)) + "px"; tip.style.top = Math.max(0, Y(best[1]) - 58) + "px"; };
  const hide = () => { tip.style.display = "none"; cx.style.display = "none"; cd.style.display = "none"; };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", hide);
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-brange]"); if (!b) return; battRange = Number(b.dataset.brange); $$("[data-brange]").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderBattChart(); loadBattHistory(); });
let battSig = "";
const leftText = (h) => (h >= 48 ? "over 2 days" : h >= 10 ? Math.round(h) + " h" : Math.floor(h) + " h " + Math.round((h % 1) * 60) + " min").replace(" 0 min", "");
function updateBattLeft(pct, stale) {
  const box = $("#battLeft"); if (!box) return;
  const st = S.auto?.status, wh = S.auto?.cfg?.usableWh ?? 800; let html = "";
  if (pct != null && !stale && st) {
    if (st.gridOn === true) html = '<div class="muted" style="font-size:13.5px;margin-top:10px">On grid, so the tank is not being drained.</div>';
    else if (st.forecast) { // a rhythm is running: the figure follows the plan (fridge on and off as scheduled), so it holds steady instead of jumping with every switch
      const f = st.forecast, lab = { night: "Night rhythm", weak: "Weak night", day: "Day throttle" }[f.regime], cut = S.auto?.cfg?.cutAt ?? 10, within = f.cutMin != null && (f.endsAt == null || f.cutAt < f.endsAt);
      const main = within ? `<div><span>${lab} · until ${cut}%</span><b>about ${leftText(f.cutMin / 60)} · ${clock(f.cutAt)}</b></div>` : f.pctAtEnd != null ? `<div><span>${lab} · through to ${clock(f.endsAt)}</span><b>about ${f.pctAtEnd}% left</b></div>` : "";
      const off = f.offW >= 5 ? `<div><span>Fridge off · ${f.offW} W</span><b>about ${leftText(((pct - cut) / 100) * wh / f.offW)}</b></div>` : "";
      html = `<div class="left-rows">${main}${off}</div><div class="faint" style="font-size:12px;margin-top:6px">Follows the fridge rhythm and the last 6 hours of use, with no sun</div>`;
    }
    else if (st.avgTankW != null && st.avgTankW > 1) {
      const energy = (pct / 100) * wh, ess = st.avgFridgeW != null ? st.avgTankW - st.avgFridgeW : null, rough = (st.avgCoverMin ?? 0) < 10;
      html = `<div class="left-rows"><div><span>At the current load · ${Math.round(st.avgTankW)} W</span><b>about ${leftText(energy / st.avgTankW)}</b></div>${ess != null && ess >= 5 && st.avgTankW - ess > 2 ? `<div><span>Fridge off · ${Math.round(ess)} W</span><b>about ${leftText(energy / ess)}</b></div>` : ""}</div><div class="faint" style="font-size:12px;margin-top:6px">Based on the last ${rough ? "few" : "30"} minutes${rough ? " (rough)" : ""} and ${wh} Wh in a full tank</div>`;
    }
  }
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
function updateBattery() {
  const el = $("#batteryCard"), b = S.battery, ag = S.agent || {}, pct = b?.percent ?? null, stale = b && Date.now() - b.at > 40 * 60e3;
  const photoT = b?.photoAt ?? null, shownT = photoT ?? ag.lastPhotoAt ?? null; // the photo this reading came from; the newest photo only if that one isn't known
  const sig = JSON.stringify([b?.charging, S.camera?.ok, pct, b?.at, b?.note, photoT, ag.lastPhotoAt, ag.lastPhotoPct, ag.lastPhotoNote, ag.live, ag.vision]);
  if (sig !== battSig) {
    battSig = sig;
    const color = pct == null ? "var(--faint)" : pct <= 15 ? "var(--bad)" : pct <= 35 ? "var(--warn)" : "var(--ok)";
    const icon = `<svg class="batt-ico" viewBox="0 0 96 56" fill="none" aria-hidden="true"><rect x="3" y="6" width="80" height="44" rx="10" stroke="${pct == null ? "var(--faint)" : "var(--muted)"}" stroke-width="4" ${pct == null ? 'stroke-dasharray="6 6"' : ""}/><path d="M89 21v14" stroke="${pct == null ? "var(--faint)" : "var(--muted)"}" stroke-width="5" stroke-linecap="round"/>${pct == null ? "" : `<rect x="9" y="12" width="${Math.max(2, (68 * pct) / 100)}" height="32" rx="6" fill="${color}"/>`}</svg>`;
    const chip = (b?.charging === true && !stale ? '<span class="chip ok">CHARGING</span> ' : '') + (pct != null ? (stale ? '<span class="chip warn">STALE</span>' + (S.auto?.status?.estPct != null ? ' <span class="chip warn">ESTIMATED ≈ ' + S.auto.status.estPct + '%</span>' : '') : '<span class="chip ok">FROM CAMERA</span>') : ag.lastPhotoAt ? '<span class="chip">PHOTOS ONLY</span>' : '<span class="chip">NOT CONNECTED</span>');
    const main = pct != null ? `<div><div class="batt-pct">${pct}<small>%</small></div><div class="muted" id="battAge" style="font-size:13.5px;margin-top:4px"></div></div>`
      : `<div><div class="status-big">${ag.lastPhotoAt ? "Can't read it yet" : "Awaiting camera"}</div><div class="muted" style="font-size:13.5px;margin-top:2px">${ag.lastPhotoAt ? (ag.vision ? "The last photo wasn't clear enough." : "Photos arrive, but nothing is reading them yet.") : "Charge level isn't being read yet."}</div></div>`;
    const seen = photoT && pct != null ? `<div style="font-weight:600;font-size:15px;margin-bottom:8px">The agent read ${pct}% from this photo</div>` : ag.lastPhotoPct != null ? `<div class="muted" style="font-size:13.5px;margin-bottom:8px">Newest photo: read ${ag.lastPhotoPct}%</div>` : ag.lastPhotoNote ? `<div class="muted" style="font-size:13.5px;margin-bottom:8px">${esc(ag.lastPhotoNote)}</div>` : "";
    const shot = shownT ? `<div class="shot-row"><img class="shot" id="battShot" alt="Latest photo of the display" data-photo="${shownT}" data-cap="${esc(new Date(shownT).toLocaleString() + (photoT && pct != null ? " · the agent read " + pct + "%" : ag.lastPhotoNote ? " · " + ag.lastPhotoNote : ""))}"><div>${seen}<button class="btn sm" data-photo-now>Read now</button><div class="faint" id="battPhotoAge" style="margin-top:8px"></div></div></div>` : `<div style="margin-top:16px"><button class="btn sm" data-photo-now>Read now</button></div>`;
    el.innerHTML = `<div class="card-h"><h2>Battery</h2>${chip}</div><div class="batt">${icon}${main}</div><div id="battLeft"></div>${shot}
      <div class="bh"><div class="bh-top"><span class="seg" role="group" aria-label="Battery history range">${[[6, "6h"], [24, "24h"], [168, "7d"]].map(([h, l]) => `<button data-brange="${h}" aria-pressed="${h === battRange}">${l}</button>`).join("")}</span></div><div class="bh-chart" id="battChart"><div class="tip" id="battTip"></div></div></div>
      <div class="faint" style="margin-top:16px">${S.camera && S.camera.ok === false && Date.now() - S.camera.at < 5 * 60e3 ? "The camera server isn't running on the phone. Open IP Webcam and tap Start server." : pct == null && ag.lastPhotoAt ? "The number couldn't be read yet. Check the framing and the light in the photos." : ""}</div>`;
    if (shownT) photoUrl(shownT).then((u) => { const im = $("#battShot"); if (im) im.src = u; }).catch(() => {});
    renderBattChart();
  }
  updateBattLeft(pct, stale);
  if (b) set("#battAge", `read ${ago(b.at)}${b.votes ? " · " + b.votes + " photos agree" : ""}`); if (shownT) set("#battPhotoAge", `Photo taken ${ago(shownT)}`);
}

/* ================= home view (selfie camera, on request) ================= */
const snapCache = new Map();
async function snapUrl(t) {
  if (snapCache.has(t)) return snapCache.get(t);
  const headers = {}; if (!devApi) headers.Authorization = "Bearer " + (await auth.currentUser.getIdToken());
  const r = await fetch(`${API}/api/view/snap?t=${t}`, { headers }); if (!r.ok) throw new Error("no picture");
  const url = URL.createObjectURL(await r.blob()); snapCache.set(t, url);
  if (snapCache.size > 12) { const [k, v] = snapCache.entries().next().value; URL.revokeObjectURL(v); snapCache.delete(k); }
  return url;
}
let homeSig = "", snapBusyUi = false;
async function snapNow() {
  if (snapBusyUi) return; snapBusyUi = true; homeSig = ""; const before = S.agent?.lastSnapAt ?? null;
  try { await post("/api/view/now", {}); } catch (e) { snapBusyUi = false; return toast(e.message); }
  toast(S.agent?.live || hubUp() ? "Asking the camera to look…" : "Requested, but the home agent isn't connected right now");
  set("#homeBtn", "Looking…");
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 3000)); await tick(true); if (S.agent?.lastSnapAt !== before) { snapBusyUi = false; homeSig = ""; return updateHome(); } }
  snapBusyUi = false; homeSig = ""; toast("No picture yet. Is the home agent running?"); updateHome();
}
function updateHome() {
  const el = $("#homeCard"); if (!S || !el || $("#tab-home").hidden) return;
  const ag = S.agent || {}, sig = JSON.stringify([ag.lastSnapAt, ag.live, hubUp(), snapBusyUi]);
  if (sig !== homeSig) {
    homeSig = sig;
    el.innerHTML = `<div class="card-h"><h2>Home view</h2><span class="chip ${ag.live || hubUp() ? "ok" : ""}">${ag.live || hubUp() ? "CAMERA READY" : "AGENT OFFLINE"}</span></div>
      <div class="home-shot">${ag.lastSnapAt ? `<img id="homeImg" alt="Latest picture from the home camera">` : '<div class="set-empty">No picture yet. Tap “Look now”.</div>'}</div>
      <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap"><button class="btn" id="homeBtn" data-snap-now ${snapBusyUi ? "disabled" : ""}>${snapBusyUi ? "Looking…" : "Look now"}</button><span class="faint" id="homeAge"></span></div>`;
    if (ag.lastSnapAt) snapUrl(ag.lastSnapAt).then((u) => { const im = $("#homeImg"); if (im) im.src = u; }).catch(() => {});
  }
  if (ag.lastSnapAt) set("#homeAge", `Taken ${ago(ag.lastSnapAt)}`);
}

let agentSig = "", galleryAt = null;
async function loadGallery() {
  try {
    const list = (await api("/api/battery/photos")).photos, wrap = $("#agGallery"); if (!wrap) return;
    wrap.innerHTML = list.length ? list.map((p) => `<button class="thumb" data-photo="${p.t}" data-cap="${esc(new Date(p.t).toLocaleString() + (p.pct != null ? " · read " + p.pct + "%" : "") + (p.note ? " · " + p.note : ""))}"><img data-t="${p.t}" alt=""><b>${clock(p.t)}</b>${p.pct != null ? ` ${p.pct}%` : ""}</button>`).join("") : '<div class="set-empty">No photos yet.</div>';
    for (const im of $$("#agGallery img[data-t]")) photoUrl(Number(im.dataset.t)).then((u) => { im.src = u; }).catch(() => {});
  } catch {}
}
// the phone running the agent: if it goes flat, the plug readings and the camera stop
function phoneRow(ph) {
  if (!ph) return setRow(iconSvg("phone"), "Phone battery", "Not reported yet", '<span class="chip">UNKNOWN</span>');
  const stale = Date.now() - ph.at > 5 * 60e3, charging = ph.status === "CHARGING" || ph.status === "FULL", low = !charging && ph.percent <= 15, mid = !charging && ph.percent <= 30;
  const state = stale ? "Not reporting" : ph.status === "FULL" ? "Full, on charger" : charging ? "Charging" : "On battery, not charging";
  const chip = stale ? ["warn", "STALE"] : low ? ["bad", "LOW"] : mid ? ["warn", "LOW SOON"] : ["ok", "GOOD"];
  return setRow(iconSvg("phone"), "Phone battery · " + ph.percent + "%", state + (ph.temp != null ? " · " + Math.round(ph.temp) + "°C" : "") + (stale ? " · last " + ago(ph.at) : ""), `<span class="chip ${chip[0]}">${chip[1]}</span>`);
}
// the camera server on the phone (IP Webcam): without it there are no tank readings and no Look now
const hubUp = () => S?.camera?.source === "hub" && S.camera.ok && Date.now() - S.camera.at < 5 * 60e3;
function cameraRow(c) {
  if (!c) return setRow(iconSvg("camera"), "Camera server", "Not reported yet", '<span class="chip">UNKNOWN</span>');
  const stale = Date.now() - c.at > 5 * 60e3;
  if (stale) return setRow(iconSvg("camera"), "Camera server", "Not reporting, last heard " + ago(c.at), '<span class="chip warn">STALE</span>');
  if (!c.ok) return setRow(iconSvg("camera"), c.source === "hub" ? "Tenergy Hub camera" : "Camera server", c.source === "hub" ? "The Hub app can't use the camera. Open Tenergy Hub on the phone. Tank readings and Look now won't work until it is back." : "IP Webcam isn't answering on the phone. Open it and tap Start server. Tank readings and Look now won't work until it is back.", '<span class="chip bad">NOT RUNNING</span>');
  return setRow(iconSvg("camera"), "Camera server", (c.front ? "Selfie camera" : "Back camera") + (c.shotAt ? " · last picture " + ago(c.shotAt) : " · no picture yet"), '<span class="chip ok">RUNNING</span>');
}
function updateAgentCard() {
  const el = $("#setAgent"); if (!S || $("#tab-settings").hidden) return;
  const ag = S.agent || {}, nLocal = S.plugs.filter((p) => p.local).length;
  const ph = S.phone, cam = S.camera, ae = document.activeElement, sig = JSON.stringify([S.cloud?.ok, cam?.version, cam?.failover, cam?.ok, cam?.front, cam?.shotAt ? Math.floor(cam.shotAt / 60000) : null, cam ? Math.floor((Date.now() - cam.at) / 120000) : null, ph?.percent, ph?.status, ph?.temp, ph ? Math.floor((Date.now() - ph.at) / 120000) : null, ag.live, ag.at ? 1 : 0, ag.vision, ag.photoEveryMin, ag.liveSec, ag.lastPhotoAt, nLocal, S.plugs.length]);
  if (ae && ae.matches("select") && el.contains(ae)) return;
  if (sig !== agentSig) {
    agentSig = sig;
    const status = ag.live ? ["ok", "LIVE"] : ag.at ? ["", "OFFLINE"] : ["", "NOT SET UP"];
    const opts = (vals, cur, fmt) => vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${fmt(v)}</option>`).join("");
    el.innerHTML = `<div class="card-h"><h2>${hubUp() ? "Tenergy Hub" : "Home agent and camera"}</h2><span class="chip ${status[0]}">${status[1]}</span></div>
      ${setRow(iconSvg("wifi"), hubUp() ? "Tenergy Hub" + (cam.version ? " " + cam.version : "") : "Home agent", `<span id="agAge"></span>`, "", true)}
      ${hubUp() ? setRow(iconSvg("bolt"), "Safety net", cam.failover ? "Tenergy can't be reached, so the phone is running the fridge and tank rules itself." : "Standing by. If Tenergy can't be reached for a while, the phone takes over the fridge and tank rules.", cam.failover ? '<span class="chip warn">RUNNING</span>' : '<span class="chip ok">STANDING BY</span>') : ""}
      ${phoneRow(ph)}
      ${cameraRow(cam)}
      ${S.cloud && S.cloud.ok === false ? setRow(iconSvg("globe"), "Tuya cloud", /quota/i.test(S.cloud.error || "") ? "Tuya's free trial quota is used up. Everything keeps working through the phone, but there is no backup route if the phone is down. Extend the IoT Core trial on iot.tuya.com." : esc(S.cloud.error || "Not answering"), '<span class="chip warn">PAUSED</span>') : ""}
      ${setRow(iconSvg("bolt"), "Live plug readings", ag.live && nLocal > 0 ? `Reading ${nLocal} of ${S.plugs.length} devices over Wi-Fi.` : ag.live ? "The agent is connected but can't reach the plugs over Wi-Fi yet, so Tenergy still reads them from Tuya's cloud. Check that the phone is on the same Wi-Fi as the plugs." : "Not running. Tenergy reads the plugs from Tuya's cloud every couple of minutes.", "")}
      ${setRow(iconSvg("clock"), "Battery check", "", `<select class="select" id="agPhotoEvery" style="width:auto" aria-label="Photo interval">${opts([1, 2, 5, 10, 15, 30, 60], ag.photoEveryMin, (v) => `every ${v} min`)}</select>`)}
      ${setRow(iconSvg("peak"), "Reading rate", "", `<select class="select" id="agLiveSec" style="width:auto" aria-label="Reading interval">${opts([10, 20, 30, 60], ag.liveSec, (v) => `every ${v} s`)}</select>`)}
      <div class="card-h" style="margin-top:20px"><h2>Recent photos</h2><button class="btn sm" data-photo-now>Read now</button></div>
      <div class="thumbs" id="agGallery"><div class="set-empty">Loading…</div></div>`;
    loadGallery(); galleryAt = ag.lastPhotoAt;
  } else if (ag.lastPhotoAt !== galleryAt) { galleryAt = ag.lastPhotoAt; loadGallery(); }
  set("#agAge", ag.live ? `Reporting ${ago(ag.at)}` : ag.at ? `Last heard from home ${ago(ag.at)}` : "Not set up yet. The setup guide is in process/AGENT_SETUP.md in the project folder.");
}
/* ================= connection pill ================= */
function updateConn() {
  const c = S.cloud, local = S.agent?.live && S.plugs.some((p) => p.local), bad = !c.ok && !local, old = c.at && Date.now() - c.at > 5 * 60e3, allOff = S.plugs.length > 0 && S.plugs.every((p) => p.online === false);
  // the phone reads and switches the plugs directly, so a refusing Tuya cloud is a warning, not an outage, while the phone is live
  $("#conn .dot").className = "dot " + (bad ? "bad" : !c.ok || old || allOff ? "warn" : "ok");
  $("#connText").textContent = bad ? "Tuya cloud unreachable" : allOff ? "Devices offline" : local ? (c.ok ? "Live · local" : "Live · local, cloud paused") : (old ? "Stale · " : "Live · ") + ago(c.at);
}

/* ================= tabs ================= */
const TABS = [{ id: "power", label: "Power", icon: "bolt" }, { id: "home", label: "Home", icon: "camera" }, { id: "router", label: "Router", icon: "wifi" }, { id: "settings", label: "Settings", icon: "gear" }];
const tabBtn = (t) => `<button role="tab" data-tab="${t.id}" aria-selected="false">${iconSvg(t.icon)}${t.label}</button>`;
$("#tabs").innerHTML = TABS.map(tabBtn).join(""); $("#dock").innerHTML = TABS.map(tabBtn).join("");
function showTab(name) {
  if (!TABS.some((t) => t.id === name)) name = "power";
  $$("#tabs button, #dock button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  for (const t of TABS) $(`#tab-${t.id}`).hidden = t.id !== name;
  history.replaceState(null, "", "#" + name); scrollTo({ top: 0 }); closeMenu();
  if (name === "power") renderChart(); if (name === "settings" && S) { updateSettings(); updateLimits(); }
}
$$("#tabs button, #dock button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
showTab(location.hash.slice(1));

/* ================= render + data loop ================= */
function render() {
  for (const fn of [updateConn, updateRing, updateFlow, updateTiles, updateDevices, updateBanner, updateGrid, updateGridStrip, updateBattery, updateHome,updateRouter, updateZte, updateSettings, updateLimits, updateAuto, updateWeak, updateAutoSettings, updateAlertSettings, updateAgentCard]) {
    try { fn(); } catch (err) { console.error(err); } // one broken panel must never blank the rest
  }
  document.body.classList.remove("loading");
  if (!$("#chart svg")) renderChart();
}
async function tick(force = false) {
  if (!user || (document.hidden && !force && !devApi)) return;
  try {
    const d = await api("/api/state" + (force ? "?force=1" : "")), r = d.router || {};
    S = { ...d, router: { ...r, agentAt: r.receivedAt, agentStale: !r.receivedAt || Date.now() - r.receivedAt > 5 * 60e3 } };
  } catch (e) {
    if (e.message === "Not signed in") return gate("This Google account isn't allowed to use this dashboard.", true);
    $("#conn .dot").className = "dot bad"; $("#connText").textContent = "Can't reach the server"; return;
  }
  render();
}
async function loadHistory() {
  if (!user || (document.hidden && !devApi)) return;
  try { H[1] = await api("/api/history?hours=1"); if (range !== 1) H[range] = await api(`/api/history?hours=${range}`); renderChart(); if (S) updateDeviceValues(); } catch {}
}

/* ================= sign-in ================= */
function gate(msg, showOut) { $("#gate").hidden = false; $("#gateMsg").textContent = msg; $("#gateOut").hidden = !showOut; $("#signIn").hidden = Boolean(showOut); }
$("#signIn").addEventListener("click", async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") gate("Sign-in didn't complete. " + (e.code || e.message)); }
});
$("#gateOut").addEventListener("click", () => signOut(auth));
if (devApi) {
  $("#gate").hidden = true; tick(); loadHistory();
  window.__dev = { set(d, h) { S = d; if (h) H = h; render(); renderChart(); } }; // lets the design be checked without live devices
} else onAuthStateChanged(auth, (u) => {
  user = u; S = null;
  if (u) { $("#gate").hidden = true; tick(); loadHistory(); } else { document.body.classList.remove("loading"); gate("Sign in to view and control your home.", false); }
});

$("#range").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  range = Number(b.dataset.h); $$("#range button").forEach((x) => x.setAttribute("aria-pressed", x === b)); loadHistory();
});
new ResizeObserver(() => renderChart()).observe($("#chart")); new ResizeObserver(() => renderBattChart()).observe($("#batteryCard"));
setInterval(() => tick(), 5000); setInterval(loadHistory, 30000); setInterval(loadBattHistory, 60000); setTimeout(loadBattHistory, 1500);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); loadHistory(); } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
