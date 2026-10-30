package com.tenergy.hub

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * The home side of the hub, doing what the Termux agent did: live plug readings and the phone battery to /api/readings, and the router and outdoor-unit health to /api/router.
 * It only makes outbound requests. Each job runs on its own thread, so a slow router never delays a plug reading.
 */
class HomeLink(private val ctx: Context, private val cfg: Config) {
    private val log = { s: String -> HubState.log(s) }
    val plugs = Plugs(cfg, log)
    private val zte = Zte(cfg.routerIp.ifEmpty { gateway() ?: "192.168.1.1" }, cfg.routerPassword)
    private val odu: Odu? = if (cfg.oduIp.isNotEmpty()) Odu(cfg.oduIp, cfg.oduPassword) else null
    private val monitor = RouterMonitor(ctx.filesDir) { cfg.routerIp.ifEmpty { gateway() } }
    private val seenAt = ConcurrentHashMap<String, Long>()
    @Volatile private var running = false
    @Volatile var liveSec = 10
    @Volatile var lastReportAt = 0L
    @Volatile var lastError = ""
    @Volatile var lastRouter: JSONObject? = null // what the Router screen shows
    private var lastSummary = ""
    private val handledCmds = java.util.TreeSet<Long>(); private val doneCmds = java.util.concurrent.CopyOnWriteArrayList<Long>()

    private fun gateway(): String? = try {
        val g = (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).dhcpInfo.gateway
        if (g == 0) null else "${g and 255}.${(g shr 8) and 255}.${(g shr 16) and 255}.${(g shr 24) and 255}"
    } catch (_: Exception) { null }

    private fun every(name: String, ms: () -> Long, job: () -> Unit) {
        Thread({
            while (running) {
                try { job() } catch (e: InterruptedException) { break } catch (e: Exception) { log("$name: ${e.message}") }
                try { Thread.sleep(ms()) } catch (e: InterruptedException) { break }
            }
        }, "home-$name").also { it.isDaemon = true }.start()
    }

    fun start() {
        running = true
        plugs.start()
        log("home side on: ${plugs.known().size} plug(s), router ${cfg.routerIp.ifEmpty { gateway() ?: "?" }}${if (odu != null) ", outdoor unit ${cfg.oduIp}" else ""}")
        var phoneSent = 0L
        every("live", { liveSec * 1000L }) {
            val body = JSONObject().put("devices", plugs.snapshot())
            if (doneCmds.isNotEmpty()) { body.put("acks", JSONArray(doneCmds.toList())) }
            val ph = phoneBattery(ctx); if (ph != null && ph.getLong("at") - phoneSent >= 55_000) { body.put("phone", ph); phoneSent = ph.getLong("at") }
            val r = JSONObject(Net.post(cfg, "/api/readings", body.toString(), 30_000))
            liveSec = r.optInt("liveSec", 10).coerceIn(3, 120)
            doneCmds.clear()
            applyCommands(r.optJSONArray("commands"))
            if (!r.isNull("batteryPct") && r.has("batteryPct")) HubState.baseline = r.optInt("batteryPct") // the jump guard compares with the number the app shows
            lastReportAt = System.currentTimeMillis(); lastError = ""
        }
        every("zte", { 20_000L }) { zte.poll() }
        if (odu != null) every("odu", { 30_000L }) { odu.poll() }
        every("probe", { 15_000L }) { monitor.probe() }
        every("router", { 30_000L }) {
            val z0 = JSONObject(zte.last.toString()); z0.remove("raw")
            var z = z0
            val o = odu?.last
            if (o != null && o.optBoolean("ok")) { val f = o.optJSONObject("fields"); if (f != null) for (k in f.keys()) z0.put(k, f.get(k)); z0.put("modem", "ok").put("connected", true).put("ok", true).put("configured", true).put("odu", true) }
            else if (o != null && o.optBoolean("configured")) z0.put("oduError", o.opt("error"))
            val devs = z.optJSONArray("devices")
            if (devs != null && devs.length() > 0) z.put("devices", probeDevices(devs))
            val sum = "router " + (if (zte.last.optBoolean("ok")) "ok" else "error: " + zte.last.optString("error")) + ", outdoor unit " + (if (odu == null) "not set" else if (odu.last.optBoolean("ok")) "ok" else "error: " + odu.last.optString("error"))
            if (sum != lastSummary) { lastSummary = sum; log(sum) }
            val body = monitor.snapshot(devs?.length()).put("zte", z); lastRouter = body
            Net.post(cfg, "/api/router", body.toString(), 30_000)
        }
    }

    /** Switch commands from the Worker, carried out straight over the home Wi-Fi: each fresh one once, then the result is reported at once. */
    @Synchronized fun applyCommands(cmds: JSONArray?) {
        if (cmds == null) return
        var did = false
        for (i in 0 until cmds.length()) {
            val c = cmds.getJSONObject(i); val at = c.getLong("at")
            if (System.currentTimeMillis() - at > 3 * 60_000L) continue
            if (!c.has("countdown") && !c.has("on")) { handledCmds.add(at); continue } // not something this build knows how to do
            if (at in handledCmds) { doneCmds.add(at); continue }
            val nm = plugs.names()[c.getString("id")] ?: c.getString("id")
            val ok = if (c.has("countdown")) plugs.setCountdown(c.getString("id"), c.getInt("countdown")) else plugs.switch(c.getString("id"), c.getBoolean("on"))
            if (c.has("countdown")) log("Worker asked: timer of ${c.getInt("countdown")} s for $nm: ${if (ok) "set over Wi-Fi" else "not set"}")
            else log("Worker asked: ${if (c.getBoolean("on")) "on" else "off"} for $nm: ${if (ok) "done over Wi-Fi" else "plug not connected, the cloud route will have to do it"}")
            if (ok) { handledCmds.add(at); doneCmds.add(at); did = true }
        }
        while (handledCmds.size > 40) handledCmds.remove(handledCmds.first())
        if (did) try { Net.post(cfg, "/api/readings", JSONObject().put("devices", plugs.snapshot()).put("acks", JSONArray(doneCmds.toList())).toString(), 20_000); doneCmds.clear() } catch (_: Exception) {}
    }

    /** The router's client table keeps a device after it has left, so each one is pinged from here and marked alive or not. */
    private fun probeDevices(devs: JSONArray): JSONArray {
        val out = arrayOfNulls<JSONObject>(devs.length())
        val threads = (0 until devs.length()).map { i -> Thread {
            val d = devs.getJSONObject(i); val ip = d.optString("ip"); val key = d.optString("mac").ifEmpty { ip }
            var alive: Boolean? = null
            if (ip.isNotEmpty()) { alive = monitor.pingOne(ip); if (!alive) alive = monitor.pingOne(ip) } // one more try: a sleeping phone can miss the first
            if (alive == true) seenAt[key] = System.currentTimeMillis()
            d.put("alive", alive ?: JSONObject.NULL).put("lastSeenAt", seenAt[key] ?: JSONObject.NULL); out[i] = d
        }.also { it.start() } }
        threads.forEach { it.join(6000) }
        return JSONArray().also { a -> out.forEachIndexed { i, o -> a.put(o ?: devs.getJSONObject(i)) } }
    }

    fun stop() { running = false; plugs.stop() }
}
