package com.tenergy.hub

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** The plugs, read directly over the home Wi-Fi: one connection per plug, polled every few seconds, kept open. The latest values are held in memory and reported to the Worker. */
class Plugs(private val cfg: Config, private val log: (String) -> Unit) {
    class Dev(val id: String, val name: String, val key: String)
    private val devs = ArrayList<Dev>()
    private val live = ConcurrentHashMap<String, Pair<Map<String, Any>, Long>>()
    private val seen = ConcurrentHashMap<String, Pair<Long, Double?>>()
    private val conns = ConcurrentHashMap<String, TuyaDevice>()
    private val ips = ConcurrentHashMap<String, String>()
    private val startedAt = System.currentTimeMillis()
    private val scanLock = Any()
    @Volatile var running = false
    private var scanAt = 0L
    private var scanHosts: List<String> = emptyList()

    fun start() {
        running = true
        val a = JSONArray(cfg.plugs)
        for (i in 0 until a.length()) {
            val o = a.getJSONObject(i)
            if (o.optString("key").isNotEmpty()) devs.add(Dev(o.getString("id"), o.optString("name", o.getString("id")).trim(), o.getString("key")))
            if (o.optString("ip").isNotEmpty()) ips[o.getString("id")] = o.getString("ip")
        }
        try { val c = JSONObject(cfg.plugIps); for (k in c.keys()) ips.putIfAbsent(k, c.getString(k)) } catch (_: Exception) {}
        for (d in devs) Thread({ run(d) }, "plug-${d.name}").also { it.isDaemon = true }.start()
    }

    fun stop() { running = false; conns.values.forEach { it.close() } }

    private fun rememberIps() { val o = JSONObject(); for ((k, v) in ips) o.put(k, v); cfg.plugIps = o.toString() }

    /** One search at a time: these plugs take only a couple of connections, and a probe with the wrong key can knock a live one off. */
    private fun locate(d: Dev): String? = synchronized(scanLock) {
        val taken = ips.filterKeys { it != d.id }.values.toSet()
        if (System.currentTimeMillis() - scanAt > 30_000) { scanHosts = Lan.openHosts(); scanAt = System.currentTimeMillis() }
        Lan.find(d.id, d.key, scanHosts, taken)
    }

    private fun run(d: Dev) {
        var delay = 2000L
        while (running) {
            var c: TuyaDevice? = null
            try {
                var ip = ips[d.id]
                if (ip == null) { ip = locate(d) ?: throw IllegalStateException("not found on the local network"); ips[d.id] = ip; rememberIps(); log("${d.name}: found at $ip") }
                c = TuyaDevice(d.id, d.key, ip); conns[d.id] = c
                c.connect(8000)
                log("${d.name}: connected locally"); delay = 2000
                val sessionStart = System.currentTimeMillis()
                while (running && System.currentTimeMillis() - sessionStart < 3 * 60_000L) { // a fresh connection every 3 minutes: a session that has silently gone stale (it happened twice) cannot keep reporting old values for long
                    val dps = synchronized(c) { c.query() }
                    val merged = HashMap(live[d.id]?.first ?: emptyMap()); merged.putAll(dps)
                    live[d.id] = merged to System.currentTimeMillis()
                    seen[d.id] = System.currentTimeMillis() to merged["19"]?.toString()?.toDoubleOrNull()?.div(10)
                    Thread.sleep(cfg.plugPollSec * 1000L)
                }
            } catch (e: InterruptedException) { return }
            catch (e: Exception) {
                log("${d.name}: ${e.message}")
                if (e.message?.contains("not found") == true || e is java.net.ConnectException || e is java.net.SocketTimeoutException || e is java.net.NoRouteToHostException) ips.remove(d.id) // it may have a new address: search again
            } finally { c?.close(); conns.remove(d.id) }
            live.remove(d.id)
            try { Thread.sleep(delay) } catch (_: InterruptedException) { return }
            delay = Math.min(delay * 2, 60_000)
        }
    }

    /** Latest reading per plug, only if it is fresh; a plug that has gone quiet is reported as unreachable at once instead of waiting for Tuya's cloud. */
    fun snapshot(maxAgeMs: Long = 30_000): JSONArray {
        val out = JSONArray()
        for (d in devs) {
            val l = live[d.id]
            if (l == null || System.currentTimeMillis() - l.second > maxAgeMs) {
                val s = seen[d.id]
                if (System.currentTimeMillis() - startedAt > 45_000 && System.currentTimeMillis() - (s?.first ?: startedAt) > 25_000)
                    out.put(JSONObject().put("id", d.id).put("unreachable", true).put("lastSeenAt", s?.first ?: JSONObject.NULL).put("lastWatts", s?.second ?: JSONObject.NULL))
                continue
            }
            val m = l.first
            fun num(k: String, div: Double): Any = m[k]?.toString()?.toDoubleOrNull()?.div(div) ?: JSONObject.NULL
            out.put(JSONObject().put("id", d.id).put("timer", m["9"]?.toString()?.toDoubleOrNull() ?: JSONObject.NULL).put("on", (m["1"] as? Boolean) ?: JSONObject.NULL).put("watts", num("19", 10.0)).put("volts", num("20", 10.0)).put("amps", num("18", 1000.0)).put("kwh", num("17", 1000.0)))
        }
        return out
    }

    /** Runs something on a brand-new connection to the plug. The long-lived connection used for the regular readings can go stale (it has answered with old values, and ignored commands), so anything that
     *  changes a plug is done on a fresh one and checked there. */
    private fun <T> onFreshConnection(id: String, body: (TuyaDevice) -> T): T {
        val dev = devs.firstOrNull { it.id == id } ?: throw IllegalStateException("unknown plug")
        val ip = ips[id] ?: throw IllegalStateException("address not known yet")
        val d = TuyaDevice(id, dev.key, ip)
        try { d.connect(5000); return body(d) } finally { d.close() }
    }

    private fun publish(id: String, dps: Map<String, Any>) { val merged = HashMap(live[id]?.first ?: emptyMap()); merged.putAll(dps); live[id] = merged to System.currentTimeMillis() }

    /** Switch a plug directly, on a fresh connection, and read it back there. Returns whether the plug really did what it was told. */
    fun switch(id: String, on: Boolean): Boolean {
        if (conns[id] == null && ips[id] == null) return false
        return try {
            var v: Boolean? = null
            onFreshConnection(id) { d ->
                d.set(mapOf("1" to on))
                for (i in 0 until 4) { Thread.sleep(600); val dps = d.query(); publish(id, dps); v = dps["1"] as? Boolean; if (v == on) break }
            }
            val worked = v == on
            if (!worked) { log("${names()[id] ?: id}: asked to switch ${if (on) "on" else "off"} but it still says otherwise"); try { conns[id]?.close() } catch (_: Exception) {} } // drop the regular connection too, so it is re-made
            worked
        } catch (e: Exception) { log("switch failed: ${e.message}"); try { conns[id]?.close() } catch (_: Exception) {}; false }
    }

    /** Set a plug's own timer (data point 9, seconds): it switches the plug by itself when it runs out, with no Wi-Fi needed. Done on a fresh connection and read back there. A timer is never put on a plug that is
     *  ON (it would switch it OFF later): that is refused, and reported as handled so it is not retried. Clearing a timer (0 seconds) is always allowed. */
    fun setCountdown(id: String, seconds: Int): Boolean {
        if (conns[id] == null && ips[id] == null) return false
        return try {
            onFreshConnection(id) { d ->
                val before = d.query(); publish(id, before)
                if (seconds > 0 && before["1"] == true) { log("${names()[id] ?: id}: refused a timer of $seconds s because the plug is on"); return@onFreshConnection true }
                d.set(mapOf("9" to seconds)); var v: Double? = null
                for (i in 0 until 6) { Thread.sleep(700); val dps = d.query(); publish(id, dps); v = dps["9"]?.toString()?.toDoubleOrNull(); if (if (seconds == 0) (v == null || v == 0.0) else (v != null && v > 0)) break }
                val ok = if (seconds == 0) (v == null || v == 0.0) else (v != null && v > 0)
                if (!ok) log("${names()[id] ?: id}: timer of $seconds s was not taken (plug says ${v ?: "nothing"})")
                ok
            }
        } catch (e: Exception) { log("timer failed: ${e.message}"); false }
    }

    /** The fresh state of one plug: (on, watts), or null when it is not answering right now. */
    fun reading(id: String, maxAgeMs: Long = 30_000): Pair<Boolean?, Double?>? {
        val l = live[id] ?: return null
        if (System.currentTimeMillis() - l.second > maxAgeMs) return null
        return (l.first["1"] as? Boolean) to l.first["19"]?.toString()?.toDoubleOrNull()?.div(10)
    }

    fun names(): Map<String, String> = devs.associate { it.id to it.name }

    fun known(): List<String> = devs.map { it.id }
}

/** The phone's own battery, for the app's warning before it runs flat. Same field names the Termux agent sent. */
fun phoneBattery(ctx: Context): JSONObject? {
    val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
    val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
    if (level < 0) return null
    val status = when (i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) { BatteryManager.BATTERY_STATUS_CHARGING -> "CHARGING"; BatteryManager.BATTERY_STATUS_FULL -> "FULL"; BatteryManager.BATTERY_STATUS_DISCHARGING -> "DISCHARGING"; BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "NOT_CHARGING"; else -> "UNKNOWN" }
    val plugged = when (i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)) { BatteryManager.BATTERY_PLUGGED_AC -> "PLUGGED_AC"; BatteryManager.BATTERY_PLUGGED_USB -> "PLUGGED_USB"; BatteryManager.BATTERY_PLUGGED_WIRELESS -> "PLUGGED_WIRELESS"; else -> "UNPLUGGED" }
    val health = when (i.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) { BatteryManager.BATTERY_HEALTH_GOOD -> "GOOD"; BatteryManager.BATTERY_HEALTH_OVERHEAT -> "OVERHEAT"; BatteryManager.BATTERY_HEALTH_DEAD -> "DEAD"; BatteryManager.BATTERY_HEALTH_COLD -> "COLD"; else -> "UNKNOWN" }
    return JSONObject().put("percent", Math.round(level * 100.0 / scale).toInt()).put("status", status).put("plugged", plugged).put("temp", i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0).put("health", health).put("at", System.currentTimeMillis())
}
