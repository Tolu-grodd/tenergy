package com.tenergy.hub

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The always-on piece: a foreground service that checks the tank every few minutes (and the moment "Read now" is pressed in the app) and reports to the Worker exactly as the
 * Termux agent's camera job does: the grid light, the battery reading and, when it changed, the picture.
 */
class HubService : Service() {
    companion object {
        val readNow = AtomicBoolean(false)
        val lookNow = AtomicBoolean(false)
        @Volatile var running = false
        fun start(ctx: Context) { val i = Intent(ctx, HubService::class.java); if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, HubService::class.java)) }
    }

    private lateinit var cfg: Config
    private var wake: PowerManager.WakeLock? = null
    private val checkLock = Any()
    private var nextAt = 0L
    private var lastBatt: Int? = null; private var pendingBatt: Int? = null; private var readFails = 0
    private var lastSig: IntArray? = null; private var lastUploadAt = 0L; private var lastUploadedVal: Int? = null
    private var home: HomeLink? = null
    private var lastGridSent: Boolean? = null; private var pendingGrid: Boolean? = null
    private var failover: Failover? = null
    private var shotAt = 0L; private var failStreak = 0; private var lastStatusAt = 0L; private var lastNote = ""

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        cfg = Config(this); HubState.fileDir = getExternalFilesDir(null); cfg.importFrom(HubState.fileDir)
        val n = notification("Starting")
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) else startForeground(1, n)
        if (!running) {
            running = true
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tenergy:hub").also { it.acquire() }
            HubState.log("service started, a check every ${cfg.everyMin} min")
            Thread({ mainLoop() }, "hub-main").also { it.isDaemon = true }.start()
            Thread({ waitLoop() }, "hub-wait").also { it.isDaemon = true }.start()
            if (cfg.homeOn) { try { home = HomeLink(this, cfg).also { it.start(); HubState.home = it; failover = Failover(cfg, it) { m -> HubState.log(m) }.also { f -> f.start(); HubState.failover = f } } } catch (e: Exception) { HubState.log("home side did not start: ${e.message}") } }
        }
        return START_STICKY
    }

    override fun onDestroy() { running = false; try { failover?.stop(); home?.stop(); HubState.home = null; HubState.failover = null } catch (_: Exception) {}; HubState.status = "Stopped"; try { wake?.release() } catch (_: Exception) {}; HubState.log("service stopped"); super.onDestroy() }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel("hub", "Tenergy Hub", NotificationManager.IMPORTANCE_LOW))
        val open = android.app.PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), android.app.PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "hub").setContentTitle("Tenergy Hub").setContentText(text).setSmallIcon(android.R.drawable.ic_menu_camera).setOngoing(true).setContentIntent(open).build()
    }

    private fun setStatus(text: String) { HubState.status = text; try { getSystemService(NotificationManager::class.java).notify(1, notification(text)) } catch (_: Exception) {} }

    private fun mainLoop() {
        while (running) {
            try {
                cfg = Config(this)
                val now = System.currentTimeMillis()
                if (!cfg.ready) { setStatus("Not set up: needs the Worker address and key"); Thread.sleep(5000); continue }
                if (lookNow.getAndSet(false)) snap() else if (readNow.getAndSet(false)) check(force = true) else if (now >= nextAt) check(force = false)
                if (now - lastStatusAt > 60_000) { postStatus(); lastStatusAt = now }
            } catch (e: Exception) { HubState.log("loop: ${e.message}") }
            try { Thread.sleep(1000) } catch (_: InterruptedException) {}
        }
    }

    private fun postStatus() {
        try {
            val ok = failStreak < 3
            Net.post(cfg, "/api/hub/status", JSONObject().put("ok", ok).put("torch", true).put("shotAt", shotAt).put("note", lastNote.take(160)).put("version", "2.0 · build 4").put("failover", HubState.failover?.active == true).toString(), 20_000)
        } catch (e: Exception) { HubState.log("status not sent: ${e.message}") }
    }

    /** "Read now" and "Look now" in the app: the Worker answers the long request the moment one is pressed. */
    private fun waitLoop() {
        var photoDone = -1L; var snapDone = -1L; var cmdDone = 0L
        while (running) {
            try {
                cfg = Config(this); if (!cfg.ready) { Thread.sleep(5000); continue }
                val j = JSONObject(Net.waitForRequest(cfg, if (snapDone < 0) 0 else snapDone, if (photoDone < 0) 0 else photoDone, cmdDone))
                val p = j.optLong("photoNowAt", 0); val sn = j.optLong("snapNowAt", 0)
                val cmds = j.optJSONArray("commands")
                if (cmds != null && cmds.length() > 0) { for (i in 0 until cmds.length()) cmdDone = Math.max(cmdDone, cmds.getJSONObject(i).getLong("at")); home?.applyCommands(cmds) } // a switch command: done straight away
                if (photoDone < 0) { photoDone = p; snapDone = sn; continue } // the first answer only says where the counters stand
                if (j.optBoolean("changed")) {
                    if (p > photoDone) { photoDone = p; HubState.log("Read now pressed"); readNow.set(true) }
                    if (sn > snapDone) { snapDone = sn; HubState.log("Look now pressed"); lookNow.set(true) }
                }
            } catch (e: Exception) { try { Thread.sleep(5000) } catch (_: InterruptedException) {} }
        }
    }

    /** Home view: one picture from the front camera, upright and brightened if the room is dim, sent to the Worker. */
    private fun snap() = synchronized(checkLock) {
        try {
            val id = cfg.snapCamera
            val turn = (getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager).getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            var jpeg: ByteArray? = null
            val sum = CameraSession(this, id) { HubState.log(it) }.run(torch = false, warmupMs = 1500, afTimeoutMs = 1500, gapMs = 0) { b, _ -> jpeg = b; false }
            var img = decodeJpeg(jpeg ?: throw IllegalStateException("no picture")).rotateCW(turn).resizeWidth(1280)
            var mean = 0.0; val step = 7; var n = 0; var i = 0
            while (i < img.px.size) { mean += img.lum(i); n++; i += step }
            mean /= n
            if (mean < 100) {
                val k = Math.min(3.0, 110.0 / Math.max(mean, 8.0))
                for (q in img.px.indices) {
                    val c = img.px[q]
                    val r = Math.min(255, (((c shr 16) and 255) * k).toInt()); val g = Math.min(255, (((c shr 8) and 255) * k).toInt()); val bl = Math.min(255, ((c and 255) * k).toInt())
                    img.px[q] = (0xFF shl 24) or (r shl 16) or (g shl 8) or bl
                }
            }
            val jpg = encodeJpeg(img, 72); HubState.lastSnap = jpg; HubState.lastSnapAt = System.currentTimeMillis()
            val b64 = android.util.Base64.encodeToString(jpg, android.util.Base64.NO_WRAP)
            Net.post(cfg, "/api/view/snap", JSONObject().put("b64", b64).toString(), 30_000)
            HubState.log("home view picture uploaded (${b64.length * 3 / 4 / 1024} KB, brightness ${mean.toInt()}) | camera $id ${sum.totalMs / 1000.0}s")
        } catch (e: Exception) { HubState.log("home view failed: ${e.message}") }
    }

    private fun check(force: Boolean) = synchronized(checkLock) {
        val now = System.currentTimeMillis()
        nextAt = now + cfg.everyMin * 60_000L
        try {
            val ps = Checker.takePhotoSet(this, cfg) { HubState.log(it) }
            shotAt = System.currentTimeMillis(); failStreak = 0; HubState.cameraOk = true
            report(ps, force)
        } catch (e: Exception) {
            failStreak++; HubState.cameraOk = failStreak < 3; lastNote = "camera: ${e.message}"
            HubState.log("check failed ($failStreak): ${e.message}")
            nextAt = System.currentTimeMillis() + 60_000 // try again in a minute
            setStatus("Camera problem: ${e.message}".take(80))
        }
    }

    /** The same decisions as the Termux agent's photo(): grid light, battery reading (with the jump guard) and the picture when it changed. */
    private fun report(p: PhotoSet, force: Boolean) {
        val readable = p.photos.filter { !it.blank }; val vals = readable.mapNotNull { it.value }
        val tally = vals.groupingBy { it }.eachCount(); val top = tally.entries.maxByOrNull { it.value }; val topVal = top?.key; val topN = top?.value ?: 0
        val agreed = topVal != null && topN >= 2 && topN > readable.size / 2.0 // at least two readable frames must agree
        val scores = p.photos.mapNotNull { it.grid?.score }.sorted()
        if (scores.size >= 2) {
            val score = scores[scores.size / 2]; val on = score >= Segments.GRID_LIGHT_THRESHOLD
            HubState.gridOn = on; HubState.gridAt = System.currentTimeMillis(); HubState.gridScore = score
            // A change that is only just over (or under) the line is held back until the next check says the same: the light once read "on" for a moment while the phone was being handled.
            val marginal = if (on) score < Segments.GRID_LIGHT_THRESHOLD + 30 else score > Segments.GRID_LIGHT_THRESHOLD - 30
            if (lastGridSent != null && on != lastGridSent && marginal && pendingGrid != on) { pendingGrid = on; HubState.log("grid light looks ${if (on) "ON" else "OFF"} (score $score) but only just: waiting for the next check") }
            else {
                try { Net.post(cfg, "/api/grid/light", JSONObject().put("on", on).put("score", score).put("count", scores.size).toString()); lastGridSent = on; pendingGrid = null; HubState.log("grid light: ${if (on) "ON" else "OFF"} (score $score)") } catch (e: Exception) { HubState.log("grid light not sent: ${e.message}") }
            }
        }
        if (agreed) {
            val v = topVal!!
            val ref = HubState.baseline ?: lastBatt
            if (ref != null && Math.abs(v - ref) > 10 && !(pendingBatt != null && Math.abs(v - pendingBatt!!) <= 2)) {
                pendingBatt = v; HubState.log("battery $v% looks like a jump from $ref%, waiting for the next check to confirm")
            } else try {
                HubState.lastPct = v; HubState.lastReadAt = System.currentTimeMillis(); HubState.charging = p.charging // known on the phone even when the Worker cannot be reached, for the phone's own rules
                Net.post(cfg, "/api/battery/reading", JSONObject().put("percent", v).put("count", topN).put("total", readable.size).apply { if (p.charging == true) put("charging", true) }.toString())
                lastBatt = v; pendingBatt = null
                HubState.log("battery $v% ($topN of ${readable.size} readable frames agree${if (p.charging == true) ", charging" else ""}) | ${p.timing}")
                setStatus("Battery $v%"); lastNote = "read $v%"
            } catch (e: Exception) { HubState.log("battery not sent: ${e.message}") }
            readFails = 0
        } else {
            HubState.log("battery: could not read it (${p.photos.joinToString(" / ") { it.value?.toString() ?: if (it.blank) "blank" else it.note }}) | ${p.timing}")
            lastNote = "unreadable: ${p.photos.lastOrNull()?.note ?: "no frames"}"
            if (++readFails <= 3) nextAt = System.currentTimeMillis() + 30_000 // try again in 30 seconds, up to 3 times, instead of waiting a whole cycle
        }
        // a close-up of the display, labelled with what it was read as, kept on the phone as examples for a future learned reader
        try { Examples.save(HubState.fileDir, if (agreed) topVal else null, if (agreed) p.crops.lastOrNull { it.first == topVal }?.second else p.crops.lastOrNull()?.second) } catch (_: Exception) {}
        val diff = meanDiff(p.sig, lastSig); val stale = System.currentTimeMillis() - lastUploadAt > 60 * 60_000L
        val newValue = agreed && topVal != lastUploadedVal
        val failed = !agreed // a failed check always sends its last frame, so there is a picture to look at
        if (!(force || failed || newValue || diff > 6 || stale)) { HubState.log("photo: unchanged (difference ${"%.1f".format(diff)}), not uploaded"); return }
        val mid = (if (failed) p.last?.resizeWidth(1280) else null) ?: p.mid ?: return
        try {
            val b64 = android.util.Base64.encodeToString(encodeJpeg(mid, 68), android.util.Base64.NO_WRAP)
            val reading = JSONObject().put("percent", if (agreed) topVal else JSONObject.NULL).put("count", topN).put("total", readable.size)
                .put("note", p.photos.joinToString(" / ") { it.value?.toString() ?: if (it.blank) "blank" else it.note })
            Net.post(cfg, "/api/battery/photo", JSONObject().put("photos", JSONArray().put(b64)).put("force", force).put("reading", reading).toString())
            lastSig = p.sig; lastUploadAt = System.currentTimeMillis(); if (agreed) lastUploadedVal = topVal
            HubState.log("photo uploaded (${b64.length * 3 / 4 / 1024} KB)")
        } catch (e: Exception) { HubState.log("photo not sent: ${e.message}") }
    }
}
