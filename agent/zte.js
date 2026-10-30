// Reads status from a ZTE CPE / ODU admin page (Airtel MF296A and similar).
// Login: password = SHA256( SHA256(password) + LD ), all hex upper-case, as the web UI does.
// Swap routers later (e.g. Fibrex) by changing ROUTER_IP / ROUTER_PASSWORD, or replace this file.
import crypto from "node:crypto";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").toUpperCase();

const STATUS_CMDS = [
  "network_type", "signalbar", "network_provider", "ppp_status", "wan_ipaddr", "modem_main_state",
  "lte_rsrp", "lte_rsrq", "lte_snr", "Z5g_rsrp", "Z5g_rsrq", "Z5g_snr", "wan_active_band", "nr5g_action_band",
  "realtime_tx_bytes", "realtime_rx_bytes", "realtime_time", "monthly_tx_bytes", "monthly_rx_bytes", "monthly_time",
  "loginfo", "cr_version", "wa_inner_version", "wifi_access_sta_num", "sta_count", "battery_pers",
];

export function createZte({ ip, password }) {
  const base = `http://${ip}`;
  let cookie = "", blockedUntil = 0; // after a failed login, wait before trying again: repeated wrong passwords can lock the router
  let last = { configured: Boolean(password), ok: false, error: null, at: null };

  const headers = () => ({ Referer: `${base}/index.html`, ...(cookie ? { Cookie: cookie } : {}) });

  async function get(cmds, multi = true) {
    const q = `isTest=false&${multi ? "multi_data=1&" : ""}cmd=${cmds}`;
    const r = await fetch(`${base}/goform/goform_get_cmd_process?${q}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
    return r.json();
  }

  async function login() {
    const { LD } = await get("LD", false);
    const body = new URLSearchParams({ isTest: "false", goformId: "LOGIN", password: sha(sha(password) + LD) });
    const r = await fetch(`${base}/goform/goform_set_cmd_process`, {
      method: "POST", headers: { ...headers(), "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.result !== "0" && j.result !== "4") blockedUntil = Date.now() + (j.result === "3" ? 30 * 60e3 : 60e3);
    if (j.result !== "0" && j.result !== "4") throw new Error(j.result === "3" ? "Router rejected the password" : `Router login failed (${j.result})`);
    cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  }

  const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

  function parseStations(v) {
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return []; }
  }

  async function poll() {
    if (!password) return (last = { configured: false, ok: false, error: null, at: Date.now() });
    if (Date.now() < blockedUntil) return last; // still waiting after a failed login
    try {
      let s = await get(STATUS_CMDS.join(","));
      if (s.loginfo !== "ok") { await login(); s = await get(STATUS_CMDS.join(",")); }
      if (s.loginfo !== "ok") throw new Error("Not logged in");

      // Device lists come back as arrays, so ask separately and tolerate either name.
      let stations = [];
      for (const cmd of ["station_list", "lan_station_list"]) {
        try { stations = stations.concat(parseStations((await get(cmd, false))[cmd])); } catch {}
      }
      const fiveG = s.network_type && /5G|NR/i.test(s.network_type);
      const rsrp = num(fiveG && s.Z5g_rsrp ? s.Z5g_rsrp : s.lte_rsrp);
      const sinr = num(fiveG && s.Z5g_snr ? s.Z5g_snr : s.lte_snr);
      last = {
        configured: true, ok: true, error: null, at: Date.now(),
        modem: s.modem_main_state || null, type: s.network_type || null, bars: num(s.signalbar), provider: s.network_provider || null,
        connected: s.ppp_status === "ppp_connected", wanIp: s.wan_ipaddr || null,
        band: s.wan_active_band || s.nr5g_action_band || null,
        rsrp, sinr, rsrq: num(s.lte_rsrq),
        tx: num(s.realtime_tx_bytes), rx: num(s.realtime_rx_bytes), uptimeS: num(s.realtime_time),
        monthTx: num(s.monthly_tx_bytes), monthRx: num(s.monthly_rx_bytes),
        firmware: s.wa_inner_version || s.cr_version || null,
        devices: stations.map((d) => ({ name: d.hostname || d.host_name || d.name || "Unknown", ip: d.ip_addr || d.ip || null, mac: d.mac_addr || d.mac || null })),
        raw: s,
      };
    } catch (e) {
      cookie = "";
      last = { configured: true, ok: false, error: e.message, at: Date.now() };
    }
    return last;
  }

  return { poll, snapshot: () => last };
}
