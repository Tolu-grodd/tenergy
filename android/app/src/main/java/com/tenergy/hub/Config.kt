package com.tenergy.hub

import android.content.Context

/** Settings kept on the phone. The Worker address and the shared key are typed in once (or sent by adb when the app is set up); nothing secret lives in the source. */
class Config(private val ctx: Context) {
    private val p = ctx.getSharedPreferences("hub", Context.MODE_PRIVATE)
    var url: String get() = p.getString("url", "") ?: ""; set(v) = p.edit().putString("url", v.trim().trimEnd('/')).apply()
    var key: String get() = p.getString("key", "") ?: ""; set(v) = p.edit().putString("key", v.trim()).apply()
    var everyMin: Int get() = p.getInt("everyMin", 5); set(v) = p.edit().putInt("everyMin", v.coerceIn(1, 240)).apply()
    var enabled: Boolean get() = p.getBoolean("enabled", false); set(v) = p.edit().putBoolean("enabled", v).apply()
    var dim: Boolean get() = p.getBoolean("dim", true); set(v) = p.edit().putBoolean("dim", v).apply()
    val camera: String get() = p.getString("camera", "0") ?: "0"
    val snapCamera: String get() = p.getString("snapCamera", "1") ?: "1" // the front camera, for the home view
    val rotate: Int get() = p.getInt("rotate", 270)   // the same number as CAMERA_ROTATE in the Termux agent
    val votes: Int get() = p.getInt("votes", 3)
    val maxShots: Int get() = p.getInt("maxShots", 8)
    // the home side (plugs, router, outdoor unit): off until set up, so the Termux agent can keep doing it meanwhile
    var homeOn: Boolean get() = p.getBoolean("homeOn", false); set(v) = p.edit().putBoolean("homeOn", v).apply()
    var plugs: String get() = p.getString("plugs", "[]") ?: "[]"; set(v) = p.edit().putString("plugs", v).apply()      // [{id, name, key, ip?}]
    var plugIps: String get() = p.getString("plugIps", "{}") ?: "{}"; set(v) = p.edit().putString("plugIps", v).apply() // id -> last address found
    var routerIp: String get() = p.getString("routerIp", "") ?: ""; set(v) = p.edit().putString("routerIp", v.trim()).apply()
    var routerPassword: String get() = p.getString("routerPassword", "") ?: ""; set(v) = p.edit().putString("routerPassword", v).apply()
    var oduIp: String get() = p.getString("oduIp", "") ?: ""; set(v) = p.edit().putString("oduIp", v.trim()).apply()
    var oduPassword: String get() = p.getString("oduPassword", "") ?: ""; set(v) = p.edit().putString("oduPassword", v).apply()
    var plan: String get() = p.getString("plan", "") ?: ""; set(v) = p.edit().putString("plan", v).apply() // the Worker's last settings, for the phone-side fallback
    var failoverMin: Int get() = p.getInt("failoverMin", 8); set(v) = p.edit().putInt("failoverMin", v.coerceIn(1, 120)).apply() // minutes without the Worker before the phone takes over
    val plugPollSec: Int get() = p.getInt("plugPollSec", 5)

    /** Secrets for the home side arrive as a file (put there with adb), are stored here, and the file is deleted straight away. */
    fun importFrom(dir: java.io.File?): Boolean {
        val f = java.io.File(dir ?: return false, "import.json"); if (!f.exists()) return false
        return try {
            val j = org.json.JSONObject(f.readText())
            if (j.has("url")) url = j.getString("url")
            if (j.has("key")) key = j.getString("key")
            if (j.has("devices")) plugs = j.getJSONArray("devices").toString()
            if (j.has("routerIp")) routerIp = j.getString("routerIp")
            if (j.has("routerPassword")) routerPassword = j.getString("routerPassword")
            if (j.has("oduIp")) oduIp = j.getString("oduIp")
            if (j.has("oduPassword")) oduPassword = j.getString("oduPassword")
            if (j.has("homeOn")) homeOn = j.getBoolean("homeOn")
            f.delete(); true
        } catch (e: Exception) { HubState.log("import failed: ${e.message}"); false }
    }
    val ready: Boolean get() = url.startsWith("https://") && key.length > 8
}
