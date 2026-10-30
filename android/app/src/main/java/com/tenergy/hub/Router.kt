package com.tenergy.hub

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object Http {
    class Res(val code: Int, val text: String, val cookies: List<String>)
    fun call(method: String, url: String, headers: Map<String, String> = emptyMap(), body: ByteArray? = null, timeoutMs: Int = 8000): Res {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method; c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body) } }
            val code = c.responseCode
            val text = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.readText() ?: ""
            return Res(code, text, c.headerFields["Set-Cookie"] ?: emptyList())
        } finally { c.disconnect() }
    }
}

/** The outdoor unit answers with an unusual status line that HttpURLConnection refuses, so it is spoken to with a plain socket. */
fun rawHttp(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Int = 8000): Http.Res {
    val u = URL(url); val port = if (u.port < 0) 80 else u.port
    val crlf = "\r\n"
    java.net.Socket().use { s ->
        s.connect(java.net.InetSocketAddress(u.host, port), timeoutMs); s.soTimeout = timeoutMs
        val req = StringBuilder("$method ${u.file} HTTP/1.1" + crlf + "Host: ${u.host}" + crlf + "Connection: close" + crlf + "Accept: */*" + crlf)
        for ((k, v) in headers) req.append("$k: $v" + crlf)
        if (body != null) req.append("Content-Length: ${body.size}" + crlf)
        req.append(crlf); s.getOutputStream().write(req.toString().toByteArray()); if (body != null) s.getOutputStream().write(body); s.getOutputStream().flush()
        val all = s.getInputStream().readBytes(); val text = String(all, Charsets.ISO_8859_1)
        val split = text.indexOf(crlf + crlf); if (split < 0) throw IllegalStateException("no answer")
        val head = text.substring(0, split); var rest = all.copyOfRange(split + 4, all.size)
        if (head.contains("transfer-encoding: chunked", ignoreCase = true)) {
            val o = java.io.ByteArrayOutputStream(); var i = 0
            while (i < rest.size) {
                var j = i
                while (j < rest.size - 1 && !(rest[j] == 13.toByte() && rest[j + 1] == 10.toByte())) j++
                val n = String(rest, i, j - i, Charsets.ISO_8859_1).trim().substringBefore(";").toIntOrNull(16) ?: break
                if (n == 0) break
                o.write(rest, j + 2, n); i = j + 2 + n + 2
            }
            rest = o.toByteArray()
        }
        val lines = head.split(crlf)
        val code = lines.first().split(" ").getOrNull(1)?.toIntOrNull() ?: 0
        val cookies = lines.filter { it.startsWith("Set-Cookie:", ignoreCase = true) }.map { it.substringAfter(":").trim() }
        return Http.Res(code, String(rest, Charsets.UTF_8), cookies)
    }
}

fun sha256Upper(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02X".format(it) }
private fun numOrNull(v: Any?): Double? { val s = v?.toString() ?: return null; if (s.isEmpty() || s == "null") return null; return s.toDoubleOrNull() }
private fun JSONObject.putNum(k: String, v: Double?): JSONObject = put(k, if (v == null) JSONObject.NULL else if (v == Math.floor(v) && Math.abs(v) < 1e15) v.toLong() else v)

/** The ZTE router's own admin page (Airtel MF296A and similar): login is SHA256(SHA256(password) + LD). Read-only. */
class Zte(private val ip: String, private val password: String) {
    private val base = "http://$ip"
    private var cookie = ""; private var blockedUntil = 0L
    @Volatile var last: JSONObject = JSONObject().put("configured", password.isNotEmpty()).put("ok", false).put("error", JSONObject.NULL).put("at", JSONObject.NULL)

    private fun headers() = HashMap<String, String>().apply { put("Referer", "$base/index.html"); if (cookie.isNotEmpty()) put("Cookie", cookie) }

    private fun get(cmds: String, multi: Boolean = true): JSONObject {
        val q = "isTest=false&${if (multi) "multi_data=1&" else ""}cmd=$cmds"
        return JSONObject(Http.call("GET", "$base/goform/goform_get_cmd_process?$q", headers()).text)
    }

    private fun login() {
        val ld = get("LD", false).getString("LD")
        val form = "isTest=false&goformId=LOGIN&password=" + sha256Upper(sha256Upper(password) + ld)
        val r = Http.call("POST", "$base/goform/goform_set_cmd_process", headers() + ("Content-Type" to "application/x-www-form-urlencoded"), form.toByteArray())
        val res = JSONObject(r.text).optString("result")
        if (res != "0" && res != "4") { blockedUntil = System.currentTimeMillis() + if (res == "3") 30 * 60_000L else 60_000L; throw IllegalStateException(if (res == "3") "Router rejected the password" else "Router login failed ($res)") }
        cookie = r.cookies.joinToString("; ") { it.substringBefore(";") }
    }

    private val cmds = listOf("network_type", "signalbar", "network_provider", "ppp_status", "wan_ipaddr", "modem_main_state", "lte_rsrp", "lte_rsrq", "lte_snr", "Z5g_rsrp", "Z5g_rsrq", "Z5g_snr", "wan_active_band", "nr5g_action_band",
        "realtime_tx_bytes", "realtime_rx_bytes", "realtime_time", "monthly_tx_bytes", "monthly_rx_bytes", "monthly_time", "loginfo", "cr_version", "wa_inner_version", "wifi_access_sta_num", "sta_count", "battery_pers").joinToString(",")

    private fun stations(v: Any?): JSONArray = when (v) { is JSONArray -> v; is String -> try { JSONArray(v) } catch (_: Exception) { JSONArray() }; else -> JSONArray() }

    fun poll(): JSONObject {
        if (password.isEmpty()) { last = JSONObject().put("configured", false).put("ok", false).put("error", JSONObject.NULL).put("at", System.currentTimeMillis()); return last }
        if (System.currentTimeMillis() < blockedUntil) return last
        try {
            var s = get(cmds)
            if (s.optString("loginfo") != "ok") { login(); s = get(cmds) }
            if (s.optString("loginfo") != "ok") throw IllegalStateException("Not logged in")
            val devs = JSONArray()
            for (cmd in listOf("station_list", "lan_station_list")) {
                try { val a = stations(get(cmd, false).opt(cmd)); for (i in 0 until a.length()) { val d = a.optJSONObject(i) ?: continue
                    devs.put(JSONObject().put("name", d.optString("hostname").ifEmpty { d.optString("host_name").ifEmpty { d.optString("name").ifEmpty { "Unknown" } } })
                        .put("ip", d.optString("ip_addr").ifEmpty { d.optString("ip") }.ifEmpty { null } ?: JSONObject.NULL).put("mac", d.optString("mac_addr").ifEmpty { d.optString("mac") }.ifEmpty { null } ?: JSONObject.NULL)) } } catch (_: Exception) {}
            }
            val nt = s.optString("network_type"); val five = nt.isNotEmpty() && Regex("5G|NR", RegexOption.IGNORE_CASE).containsMatchIn(nt)
            val rsrp = numOrNull(if (five && s.optString("Z5g_rsrp").isNotEmpty()) s.opt("Z5g_rsrp") else s.opt("lte_rsrp"))
            val sinr = numOrNull(if (five && s.optString("Z5g_snr").isNotEmpty()) s.opt("Z5g_snr") else s.opt("lte_snr"))
            fun str(k: String): Any = s.optString(k).ifEmpty { null } ?: JSONObject.NULL
            last = JSONObject().put("configured", true).put("ok", true).put("error", JSONObject.NULL).put("at", System.currentTimeMillis())
                .put("modem", str("modem_main_state")).put("type", str("network_type")).putNum("bars", numOrNull(s.opt("signalbar"))).put("provider", str("network_provider"))
                .put("connected", s.optString("ppp_status") == "ppp_connected").put("wanIp", str("wan_ipaddr"))
                .put("band", s.optString("wan_active_band").ifEmpty { s.optString("nr5g_action_band") }.ifEmpty { null } ?: JSONObject.NULL)
                .putNum("rsrp", rsrp).putNum("sinr", sinr).putNum("rsrq", numOrNull(s.opt("lte_rsrq")))
                .putNum("tx", numOrNull(s.opt("realtime_tx_bytes"))).putNum("rx", numOrNull(s.opt("realtime_rx_bytes"))).putNum("uptimeS", numOrNull(s.opt("realtime_time")))
                .putNum("monthTx", numOrNull(s.opt("monthly_tx_bytes"))).putNum("monthRx", numOrNull(s.opt("monthly_rx_bytes")))
                .put("firmware", s.optString("wa_inner_version").ifEmpty { s.optString("cr_version") }.ifEmpty { null } ?: JSONObject.NULL).put("devices", devs)
        } catch (e: Exception) {
            cookie = ""; last = JSONObject().put("configured", true).put("ok", false).put("error", e.message ?: "failed").put("at", System.currentTimeMillis())
        }
        return last
    }
}

/** The ZTE outdoor unit behind the router (the newer ubus/JSON-RPC page): signal and data usage. It first checks the unit's own count of remaining login attempts, so it can never lock it. */
class Odu(private val ip: String, private val password: String) {
    private val base = "http://$ip"; private val nosess = "00000000000000000000000000000000"
    private var session: String? = null; private var blockedUntil = 0L
    @Volatile var last: JSONObject = JSONObject().put("configured", password.isNotEmpty()).put("ok", false).put("error", JSONObject.NULL).put("at", JSONObject.NULL)

    private fun rpc(sess: String, obj: String, method: String, params: JSONObject = JSONObject()): JSONArray? {
        val body = JSONArray().put(JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", "call").put("params", JSONArray().put(sess).put(obj).put(method).put(params))).toString()
        val r = rawHttp("POST", "$base/ubus/?t=${System.currentTimeMillis()}", mapOf("Content-Type" to "application/json", "Z-Mode" to (if (sess == nosess) "0" else "1"), "Z-Tag" to method, "Origin" to base, "Referer" to "$base/"), body.toByteArray())
        val j = JSONArray(r.text).optJSONObject(0)
        if (j?.optJSONObject("error")?.optInt("code") == -32002) { session = null; throw IllegalStateException("session expired") }
        return j?.optJSONArray("result")
    }

    private fun login() {
        val info = rpc(nosess, "zwrt_web", "web_login_info")?.optJSONObject(1) ?: JSONObject()
        val left = info.optString("login_fail_num", "5").toIntOrNull() ?: 5; val lock = info.optString("login_fail_lock_lefttime", "0").toIntOrNull() ?: 0
        if (lock > 0) { blockedUntil = System.currentTimeMillis() + lock * 1000L; throw IllegalStateException("The unit has locked logins for $lock s") }
        if (left <= 2) { blockedUntil = System.currentTimeMillis() + 30 * 60_000L; throw IllegalStateException("Only $left login attempts left on the unit, so not trying") }
        val res = rpc(nosess, "zwrt_web", "web_login", JSONObject().put("password", sha256Upper(sha256Upper(password) + info.optString("zte_web_sault"))))?.optJSONObject(1)
        if (res?.optString("result") != "0") { blockedUntil = System.currentTimeMillis() + 30 * 60_000L; throw IllegalStateException("The unit rejected the password") }
        session = res.optString("ubus_rpc_session")
    }

    fun poll(): JSONObject {
        if (password.isEmpty()) { last = JSONObject().put("configured", false).put("ok", false).put("error", JSONObject.NULL).put("at", System.currentTimeMillis()); return last }
        if (System.currentTimeMillis() < blockedUntil) return last
        try {
            if (session == null) login()
            val s = session!!
            val net = rpc(s, "zte_nwinfo_api", "nwinfo_get_netinfo")?.optJSONObject(1) ?: throw IllegalStateException("No signal data")
            val month = rpc(s, "zwrt_data", "get_wwandst", JSONObject().put("source_module", "web").put("cid", 1).put("type", 2))?.optJSONObject(1) ?: JSONObject()
            val now = rpc(s, "zwrt_data", "get_wwandst", JSONObject().put("source_module", "web").put("cid", 1).put("type", 1))?.optJSONObject(1) ?: JSONObject()
            val dev = rpc(s, "zwrt_mc.device.manager", "get_device_info")?.optJSONObject(1) ?: JSONObject()
            val nt = net.optString("network_type"); val nr = Regex("5G|NR", RegexOption.IGNORE_CASE).containsMatchIn(nt)
            fun pick(a: String, b: String) = numOrNull(if (nr && net.optString(a).isNotEmpty()) net.opt(a) else net.opt(b))
            val f = JSONObject().put("type", nt.ifEmpty { null } ?: JSONObject.NULL).putNum("bars", numOrNull(net.opt("signalbar")))
                .put("provider", net.optString("network_provider_fullname").ifEmpty { net.optString("network_provider") }.ifEmpty { null } ?: JSONObject.NULL)
                .put("band", net.optString("wan_active_band").ifEmpty { null } ?: JSONObject.NULL)
                .putNum("rsrp", pick("nr5g_rsrp", "lte_rsrp")).putNum("rsrq", pick("nr5g_rsrq", "lte_rsrq")).putNum("sinr", pick("nr5g_snr", "lte_snr"))
                .putNum("tx", numOrNull(now.opt("real_tx_bytes"))).putNum("rx", numOrNull(now.opt("real_rx_bytes"))).putNum("monthTx", numOrNull(month.opt("month_tx_bytes"))).putNum("monthRx", numOrNull(month.opt("month_rx_bytes"))).putNum("uptimeS", numOrNull(dev.opt("device_uptime")))
            last = JSONObject().put("configured", true).put("ok", true).put("error", JSONObject.NULL).put("at", System.currentTimeMillis()).put("fields", f)
        } catch (e: Exception) {
            session = null; last = JSONObject().put("configured", true).put("ok", false).put("error", e.message ?: "failed").put("at", System.currentTimeMillis())
        }
        return last
    }
}

/** Router health from the phone: pings the gateway and the internet every 15 s, keeps a 24-hour strip and a list of outages (saved to a file, so a restart keeps them). */
class RouterMonitor(private val dir: File, private val gatewayGuess: () -> String?) {
    private class Probe(val t: Long, val s: Int)
    private val keepMs = 24 * 3600_000L
    private val probes = ArrayList<Probe>(); private val outages = ArrayList<JSONObject>(); private var open: JSONObject? = null
    private var last = JSONObject(); private var gateway: String? = null; private var savedAt = 0L

    init {
        try { val a = JSONArray(File(dir, "probes.json").readText()); for (i in 0 until a.length()) { val o = a.getJSONObject(i); if (o.getLong("t") > System.currentTimeMillis() - keepMs) probes.add(Probe(o.getLong("t"), o.getInt("s"))) } } catch (_: Exception) {}
        try { val a = JSONArray(File(dir, "outages.json").readText()); for (i in 0 until a.length()) outages.add(a.getJSONObject(i)) } catch (_: Exception) {}
    }

    private fun ping(host: String, count: Int = 3): Pair<Int, Int?> {
        return try {
            val p = ProcessBuilder("ping", "-c", count.toString(), "-W", "1", host).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText(); p.waitFor()
            val loss = Regex("(\\d+)% (?:packet )?loss").find(out)?.groupValues?.get(1)?.toInt() ?: 100
            val avg = Regex("= [\\d.]+/([\\d.]+)/").find(out)?.groupValues?.get(1)?.toDouble()
            loss to (if (avg != null && loss < 100) Math.round(avg).toInt() else null)
        } catch (_: Exception) { 100 to null }
    }

    fun probe() {
        try {
            if (gateway == null) gateway = gatewayGuess()
            val gw = gateway ?: throw IllegalStateException("no gateway found")
            val a = ping(gw); val n1 = ping("1.1.1.1"); val n2 = ping("8.8.8.8"); val nets = listOf(n1, n2)
            val netUp = nets.any { it.first < 100 }; val ms = nets.mapNotNull { it.second }
            val netLoss = Math.round(nets.sumOf { it.first } / nets.size.toDouble()).toInt(); val netMs = ms.minOrNull()
            val s = if (a.first == 100) 3 else if (!netUp) 2 else if (netLoss > 0 || a.first > 0 || (netMs ?: 0) > 150) 1 else 0
            val now = System.currentTimeMillis()
            synchronized(probes) { probes.add(Probe(now, s)); while (probes.isNotEmpty() && probes[0].t < now - keepMs) probes.removeAt(0) }
            if (s >= 2 && open == null) { open = JSONObject().put("start", now).put("end", JSONObject.NULL).put("kind", if (s == 3) "router" else "internet"); outages.add(0, open!!) }
            else if (s < 2 && open != null) { open!!.put("end", now); open = null }
            while (outages.size > 30) outages.removeAt(outages.size - 1)
            last = JSONObject().put("gateway", gw).put("gwMs", a.second ?: JSONObject.NULL).put("gwLoss", a.first).put("netMs", netMs ?: JSONObject.NULL).put("netLoss", netLoss).put("status", s).put("at", now)
            if (now - savedAt > 60_000) { savedAt = now; save() }
        } catch (e: Exception) { last = JSONObject(last.toString()).put("status", JSONObject.NULL).put("error", e.message ?: "failed").put("at", System.currentTimeMillis()) }
    }

    private fun save() {
        try {
            File(dir, "probes.json").writeText(JSONArray().also { a -> synchronized(probes) { probes.forEach { a.put(JSONObject().put("t", it.t).put("s", it.s)) } } }.toString())
            File(dir, "outages.json").writeText(JSONArray(outages).toString())
        } catch (_: Exception) {}
    }

    /** The same shape the Router tab already reads: the last probe plus the 24-hour uptime, the 48-slot strip and recent outages. */
    fun snapshot(deviceCount: Int?): JSONObject {
        val now = System.currentTimeMillis(); val buckets = 48; val size = keepMs / buckets
        val strip = arrayOfNulls<Int>(buckets); var up = 0; var n = 0; var first = now
        synchronized(probes) { for (p in probes) { val i = Math.min(buckets - 1, ((p.t - (now - keepMs)) / size).toInt()); if (i >= 0) strip[i] = Math.max(strip[i] ?: 0, p.s); n++; if (p.s < 2) up++ }; if (probes.isNotEmpty()) first = probes[0].t }
        val o = JSONObject(last.toString())
        if (deviceCount != null) o.put("devices", deviceCount)
        o.put("uptime24", if (n > 0) Math.round(up.toDouble() / n * 1000) / 10.0 else JSONObject.NULL).put("coverageMin", if (n > 0) (now - first) / 60000 else 0)
        o.put("strip", JSONArray().also { a -> strip.forEach { a.put(it ?: JSONObject.NULL) } }).put("outages", JSONArray().also { a -> outages.take(5).forEach { a.put(it) } })
        return o
    }

    fun pingOne(ip: String): Boolean = ping(ip, 1).first < 100
}
