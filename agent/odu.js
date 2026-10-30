// Reads the signal and data usage from a ZTE outdoor unit's admin page (the newer ubus/JSON-RPC web UI, e.g. the Airtel ODU at 192.168.254.1).
// Login: password = SHA256( SHA256(password) + sault ), hex upper-case, as the web page does. Read-only: only "get" calls are ever made.
// It will not risk locking the unit: it checks the unit's own count of remaining login attempts first, and waits after any failure.
import crypto from "node:crypto";

const NOSESS = "00000000000000000000000000000000";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").toUpperCase();
const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export function createOdu({ ip, password }) {
  const base = `http://${ip}`;
  let session = null, blockedUntil = 0, last = { configured: Boolean(password), ok: false, error: null, at: null };

  async function rpc(sess, obj, method, params = {}) {
    const r = await fetch(`${base}/ubus/?t=${Date.now()}`, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", "Z-Mode": sess === NOSESS ? "0" : "1", "Z-Tag": method, Origin: base, Referer: base + "/" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "call", params: [sess, obj, method, params] }]),
    });
    const j = (await r.json())[0];
    if (j?.error?.code === -32002) { session = null; throw new Error("session expired"); }
    return j?.result;
  }

  async function login() {
    const info = (await rpc(NOSESS, "zwrt_web", "web_login_info"))?.[1] ?? {};
    const left = Number(info.login_fail_num ?? 5), lock = Number(info.login_fail_lock_lefttime ?? 0);
    if (lock > 0) { blockedUntil = Date.now() + lock * 1000; throw new Error(`The unit has locked logins for ${lock} s`); }
    if (left <= 2) { blockedUntil = Date.now() + 30 * 60e3; throw new Error(`Only ${left} login attempts left on the unit, so not trying (open its page in a browser to reset the count)`); }
    const res = await rpc(NOSESS, "zwrt_web", "web_login", { password: sha(sha(password) + info.zte_web_sault) });
    if (res?.[1]?.result !== 0 && res?.[1]?.result !== "0") { blockedUntil = Date.now() + 30 * 60e3; throw new Error("The unit rejected the password"); }
    session = res[1].ubus_rpc_session;
  }

  async function poll() {
    if (!password) return (last = { configured: false, ok: false, error: null, at: Date.now() });
    if (Date.now() < blockedUntil) return last;
    try {
      if (!session) await login();
      const net = (await rpc(session, "zte_nwinfo_api", "nwinfo_get_netinfo"))?.[1];
      if (!net) throw new Error("No signal data");
      const month = (await rpc(session, "zwrt_data", "get_wwandst", { source_module: "web", cid: 1, type: 2 }))?.[1] ?? {};
      const now = (await rpc(session, "zwrt_data", "get_wwandst", { source_module: "web", cid: 1, type: 1 }))?.[1] ?? {};
      const dev = (await rpc(session, "zwrt_mc.device.manager", "get_device_info"))?.[1] ?? {};
      const nr = net.network_type && /5G|NR/i.test(net.network_type);
      last = {
        configured: true, ok: true, error: null, at: Date.now(),
        fields: {
          type: net.network_type || null, bars: num(net.signalbar), provider: net.network_provider_fullname || net.network_provider || null,
          band: net.wan_active_band || null, rsrp: num(nr && net.nr5g_rsrp ? net.nr5g_rsrp : net.lte_rsrp), rsrq: num(nr && net.nr5g_rsrq ? net.nr5g_rsrq : net.lte_rsrq), sinr: num(nr && net.nr5g_snr ? net.nr5g_snr : net.lte_snr),
          tx: num(now.real_tx_bytes), rx: num(now.real_rx_bytes), monthTx: num(month.month_tx_bytes), monthRx: num(month.month_rx_bytes), uptimeS: num(dev.device_uptime),
        },
      };
    } catch (e) {
      session = null; // log in again next time (the guard above stops this from hammering a unit that rejects us)
      last = { configured: true, ok: false, error: e.message, at: Date.now() };
    }
    return last;
  }

  return { poll, snapshot: () => last };
}
