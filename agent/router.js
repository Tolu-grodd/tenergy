// Home-router health from the machine that runs the dashboard.
// Works with any router: pings the gateway and the internet, counts devices from the ARP table,
// and records outages. Needs nothing from the router itself.
import fs from "node:fs";
import { execFile } from "node:child_process";

const WIN = process.platform === "win32";
const INTERNET_HOSTS = ["1.1.1.1", "8.8.8.8"];
const PROBE_S = 15;
const KEEP_MS = 24 * 3600e3;
const SLOW_MS = 150;

const run = (cmd, args, timeout = 10000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true }, (_e, out) => resolve(String(out ?? ""))));

async function ping(host) {
  const out = await run("ping", WIN ? ["-n", "3", "-w", "1000", host] : ["-c", "3", "-W", "1", host]);
  const loss = Number(/(\d+)% (?:packet )?loss/.exec(out)?.[1] ?? 100);
  const avg = /Average = (\d+)ms/.exec(out)?.[1] ?? /= [\d.]+\/([\d.]+)\//.exec(out)?.[1];
  return { loss, ms: avg != null && loss < 100 ? Math.round(Number(avg)) : null };
}

export async function findGateway() {
  if (process.env.ROUTER_IP) return process.env.ROUTER_IP;
  if (WIN) {
    const out = await run("route", ["print", "-4", "0.0.0.0"]);
    const rows = [...out.matchAll(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+\d+\.\d+\.\d+\.\d+\s+(\d+)/g)];
    rows.sort((a, b) => Number(a[2]) - Number(b[2]));
    return rows[0]?.[1] ?? null;
  }
  const out = await run("ip", ["route", "show", "default"]);
  return /default via (\S+)/.exec(out)?.[1] ?? null;
}

async function countDevices(gateway) {
  const prefix = gateway.split(".").slice(0, 3).join(".") + ".";
  const out = await run("arp", ["-a"]);
  const ips = new Set();
  for (const m of out.matchAll(/(\d+\.\d+\.\d+\.\d+)/g)) {
    const ip = m[1];
    const last = Number(ip.split(".")[3]);
    if (ip.startsWith(prefix) && last !== 255 && last !== 0) ips.add(ip);
  }
  return ips.size;
}

export function startRouterMonitor(dataDir) {
  const outageFile = `${dataDir}/outages.json`;
  let outages = [];
  try { outages = JSON.parse(fs.readFileSync(outageFile, "utf8")); } catch {}
  // {t, s}  s: 0 ok, 1 slow/lossy, 2 internet down, 3 router unreachable. Saved to disk, so the 24-hour bar survives an agent restart.
  const probeFile = `${dataDir}/probes.json`;
  const probes = (() => { try { return JSON.parse(fs.readFileSync(probeFile, "utf8")).filter((p) => p.t > Date.now() - KEEP_MS); } catch { return []; } })();
  const saveProbes = () => { try { fs.writeFileSync(probeFile, JSON.stringify(probes)); } catch {} };
  setInterval(saveProbes, 60_000);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveProbes(); process.exit(0); });
  let gateway = null;
  let last = null;
  let openOutage = null;

  async function probe() {
    try {
      gateway ??= await findGateway();
      if (!gateway) throw new Error("no gateway found");
      const [gw, ...nets] = await Promise.all([ping(gateway), ...INTERNET_HOSTS.map(ping)]);
      const netUp = nets.some((n) => n.loss < 100);
      const netMs = nets.map((n) => n.ms).filter((x) => x != null);
      const net = { loss: Math.round(nets.reduce((a, n) => a + n.loss, 0) / nets.length), ms: netMs.length ? Math.min(...netMs) : null };
      let s = 0;
      if (gw.loss === 100) s = 3;
      else if (!netUp) s = 2;
      else if (net.loss > 0 || gw.loss > 0 || (net.ms ?? 0) > SLOW_MS) s = 1;

      const now = Date.now();
      probes.push({ t: now, s });
      while (probes.length && probes[0].t < now - KEEP_MS) probes.shift();

      if (s >= 2 && !openOutage) {
        openOutage = { start: now, end: null, kind: s === 3 ? "router" : "internet" };
        outages.unshift(openOutage);
      } else if (s < 2 && openOutage) {
        openOutage.end = now;
        openOutage = null;
      }
      outages = outages.slice(0, 30);
      fs.writeFileSync(outageFile, JSON.stringify(outages));

      last = { gateway, gwMs: gw.ms, gwLoss: gw.loss, netMs: net.ms, netLoss: net.loss, status: s, devices: await countDevices(gateway), at: now };
    } catch (e) {
      last = { ...(last ?? {}), status: null, error: e.message, at: Date.now() };
    }
  }

  probe();
  setInterval(probe, PROBE_S * 1000);

  return function snapshot() {
    const now = Date.now();
    const buckets = 48;
    const size = KEEP_MS / buckets;
    const strip = Array(buckets).fill(null);
    for (const p of probes) {
      const i = Math.min(buckets - 1, Math.floor((p.t - (now - KEEP_MS)) / size));
      if (i >= 0) strip[i] = Math.max(strip[i] ?? 0, p.s);
    }
    const up = probes.filter((p) => p.s < 2).length;
    return {
      ...last,
      uptime24: probes.length ? Math.round((up / probes.length) * 1000) / 10 : null,
      coverageMin: probes.length ? Math.round((now - probes[0].t) / 60000) : 0, // how much time the percentage is really based on
      strip,
      outages: outages.slice(0, 5),
    };
  };
}
