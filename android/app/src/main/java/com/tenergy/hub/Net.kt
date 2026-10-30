package com.tenergy.hub

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** What the screen shows, and a small log kept in memory and in a file (adb pull) so nothing needs a terminal to be understood. */
object HubState {
    private val lines = ArrayDeque<String>()
    @Volatile var lastPct: Int? = null
    @Volatile var lastReadAt = 0L
    @Volatile var status = "Stopped"
    @Volatile var cameraOk = true
    @Volatile var gridOn: Boolean? = null // the last grid-light reading and when it was taken, for the phone's own rules
    @Volatile var gridAt = 0L
    @Volatile var charging: Boolean? = null
    @Volatile var ev = 0 // the camera exposure setting that last read the display
    @Volatile var gridScore: Int? = null
    @Volatile var home: HomeLink? = null // for the app's screens
    @Volatile var failover: Failover? = null
    @Volatile var lastSnap: ByteArray? = null // the last home-view picture
    @Volatile var lastSnapAt = 0L
    @Volatile var baseline: Int? = null // the battery number the app shows, sent back by the Worker with every report
    @Volatile var fileDir: File? = null
    private val fmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)

    fun log(msg: String) {
        val line = fmt.format(java.util.Date()) + " " + msg
        Log.i("TenergyHub", line)
        synchronized(this) {
            lines.addLast(line); while (lines.size > 300) lines.removeFirst()
            try { fileDir?.let { d -> val f = File(d, "hub.log"); if (f.length() > 400_000) f.writeText(""); f.appendText(line + "\n") } } catch (_: Exception) {}
        }
    }

    fun text(): String = synchronized(this) { lines.toList().takeLast(60).joinToString("\n") }
}

/** The same shared-key requests the Termux agent makes to the Worker. */
object Net {
    fun post(cfg: Config, path: String, body: String, timeoutMs: Int = 30_000): String {
        val c = URL(cfg.url + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.connectTimeout = 15_000; c.readTimeout = timeoutMs; c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json"); c.setRequestProperty("x-ingest-key", cfg.key)
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode; val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            if (code >= 400) throw IllegalStateException("$path -> $code $text".take(200))
            return text
        } finally { c.disconnect() }
    }

    fun get(cfg: Config, path: String, timeoutMs: Int = 20_000): String {
        val c = URL(cfg.url + path).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15_000; c.readTimeout = timeoutMs; c.setRequestProperty("x-ingest-key", cfg.key)
            val code = c.responseCode; val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            if (code >= 400) throw IllegalStateException("$path -> $code".take(200))
            return text
        } finally { c.disconnect() }
    }

    /** Kept open by the Worker for up to ~20 s; answers the moment "Read now" is pressed in the app. */
    fun waitForRequest(cfg: Config, snap: Long, photo: Long, cmd: Long = 0): String {
        val c = URL(cfg.url + "/api/agent/wait?snap=$snap&photo=$photo&cmd=$cmd").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15_000; c.readTimeout = 35_000; c.setRequestProperty("x-ingest-key", cfg.key)
            if (c.responseCode >= 400) throw IllegalStateException("wait -> ${c.responseCode}")
            return c.inputStream.bufferedReader().readText()
        } finally { c.disconnect() }
    }
}
