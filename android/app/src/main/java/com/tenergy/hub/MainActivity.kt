package com.tenergy.hub

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.SpannableString
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/**
 * The app's screens: Camera (the tank reading and the home view), Plugs, Router, Automation (what the phone does if the Worker cannot be reached) and Settings.
 * Leave it open and it keeps the screen on at minimum brightness (an app on screen is the one thing Android never freezes); the service keeps working if you close it.
 * It can be set up from adb:  am start -n com.tenergy.hub/.MainActivity --es url https://... --es key ... --ei every 5 --ez start true [--es tab Plugs]
 */
class MainActivity : Activity() {
    private lateinit var cfg: Config
    private lateinit var ui: Ui
    private val handler = Handler(Looper.getMainLooper())
    private val screens = LinkedHashMap<String, View>()
    private val tabSetters = LinkedHashMap<String, (Boolean) -> Unit>()
    private val updaters = ArrayList<() -> Unit>()
    private var shownSnapAt = 0L
    private lateinit var headerChip: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cfg = Config(this); HubState.fileDir = getExternalFilesDir(null); ui = Ui(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Theme.bg
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN // the page glow runs up behind the status bar, as in the web app
        val statusBarPx = resources.getIdentifier("status_bar_height", "dimen", "android").let { if (it > 0) resources.getDimensionPixelSize(it) else ui.dp(24) }
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        applyExtras(intent)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = ui.pageBackground(); setPadding(0, statusBarPx, 0, 0) }
        headerChip = ui.chip("")
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(ui.dp(20), ui.dp(14), ui.dp(20), ui.dp(4))
            addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.hub_logo) }, LinearLayout.LayoutParams(ui.dp(38), ui.dp(38)))
            addView(ui.text("Tenergy Hub", 17f, Theme.text, ui.medium).apply { setPadding(ui.dp(12), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(headerChip)
        })
        val body = FrameLayout(this); root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))

        screens["Camera"] = cameraScreen(); screens["Plugs"] = plugsScreen(); screens["Router"] = routerScreen(); screens["Automation"] = autoScreen(); screens["Settings"] = settingsScreen()
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; background = ui.shape(Color.argb(235, 16, 20, 28), 24f, Theme.cardEdge); setPadding(ui.dp(6), 0, ui.dp(6), 0) }
        val icons = mapOf("Camera" to R.drawable.ic_tab_camera, "Plugs" to R.drawable.ic_tab_plug, "Router" to R.drawable.ic_tab_wifi, "Automation" to R.drawable.ic_tab_bolt, "Settings" to R.drawable.ic_tab_sliders)
        for ((name, v) in screens) {
            body.addView(v, FrameLayout.LayoutParams(-1, -1)); v.visibility = View.GONE
            val (item, setter) = ui.tabItem(icons.getValue(name), name) { show(name) }
            tabSetters[name] = setter; bar.addView(item, LinearLayout.LayoutParams(0, -2, 1f))
        }
        root.addView(bar, LinearLayout.LayoutParams(-1, -2).apply { setMargins(ui.dp(14), ui.dp(6), ui.dp(14), ui.dp(10)) })
        setContentView(root)
        show("Camera")

        val need = ArrayList<String>(); if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 1)
        applyDim()
        if (cfg.enabled && cfg.ready && !HubService.running) startHub()
        tick()
    }

    /** Settings sent from adb (or a link) while the app is already running are applied too. */
    override fun onNewIntent(i: Intent) { super.onNewIntent(i); setIntent(i); applyExtras(i) }

    private fun applyExtras(it: Intent) {
        cfg.importFrom(HubState.fileDir)
        if (it.hasExtra("failoverMin")) cfg.failoverMin = it.getIntExtra("failoverMin", 8)
        if (it.hasExtra("home")) cfg.homeOn = it.getBooleanExtra("home", false)
        it.getStringExtra("url")?.let { v -> cfg.url = v }; it.getStringExtra("key")?.let { v -> cfg.key = v }
        if (it.hasExtra("every")) cfg.everyMin = it.getIntExtra("every", 5)
        if (it.hasExtra("dim")) cfg.dim = it.getBooleanExtra("dim", true)
        if (it.getBooleanExtra("start", false)) cfg.enabled = true
        it.getStringExtra("tab")?.let { t -> if (screens.containsKey(t)) show(t) }
    }

    private fun show(name: String) {
        for ((n, v) in screens) v.visibility = if (n == name) View.VISIBLE else View.GONE
        for ((n, s) in tabSetters) s(n == name)
    }

    private fun ago(ms: Long): String { if (ms <= 0) return "never"; val s = (System.currentTimeMillis() - ms) / 1000; return if (s < 90) "${s} s ago" else if (s < 5400) "${s / 60} min ago" else "${s / 3600} h ago" }
    private fun fmt(o: JSONObject, k: String, digits: Int = 1): String = if (o.isNull(k)) "-" else String.format(java.util.Locale.US, "%.${digits}f", o.getDouble(k))

    /** A screen: a large title and then cards, in a scroll view. */
    private fun screen(title: String, content: LinearLayout.() -> Unit): Pair<ScrollView, LinearLayout> {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.dp(18), ui.dp(8), ui.dp(18), ui.dp(24)) }
        col.addView(ui.text(title, 30f, Theme.text, ui.medium).apply { setPadding(ui.dp(4), ui.dp(4), 0, ui.dp(16)) })
        col.content()
        return ScrollView(this).apply { isVerticalScrollBarEnabled = false; addView(col) } to col
    }

    /** A block of views that is rebuilt only when what it shows has changed. */
    private inner class Dynamic(val box: LinearLayout) {
        private var sig = ""
        fun set(newSig: String, build: LinearLayout.() -> Unit) { if (newSig == sig) return; sig = newSig; box.removeAllViews(); box.build() }
    }

    // ---------------------------------------------------------------- Camera
    private fun cameraScreen(): View {
        val big = ui.text("-", 64f, Theme.text, ui.light); val sub = ui.text("", 14f, Theme.muted)
        val tankChip = ui.chip(""); val bar = FrameLayout(this); val gridValue = ui.text("", 14f, Theme.text, ui.medium); val gridNote = ui.text("", 12f, Theme.faint)
        val pic = ImageView(this).apply { adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; setBackgroundColor(Color.BLACK); visibility = View.GONE }; ui.rounded(pic, 14f)
        val picNote = ui.text("No picture yet. Tap Look now.", 14f, Theme.muted)
        val activity = ui.text("", 11f, Theme.muted).apply { typeface = Typeface.MONOSPACE; setLineSpacing(0f, 1.25f) }
        val (sv, _) = screen("Camera") {
            addView(ui.card(ui.cardHeader("Tank battery", tankChip), big, ui.spacer(2), sub, bar, ui.spacer(8),
                LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, ui.dp(12), 0, 0)
                    addView(ui.text("Grid light", 14f, Theme.muted), LinearLayout.LayoutParams(0, -2, 1f)); addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.END; addView(gridValue); addView(gridNote) }) }))
            addView(ui.card(ui.cardHeader("Home view"), pic, picNote, ui.spacer(14),
                LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL
                    addView(ui.primary("Look now") { HubService.lookNow.set(true); if (!HubService.running) startHub() }, LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = ui.dp(5) })
                    addView(ui.secondary("Read tank now") { HubService.readNow.set(true); if (!HubService.running) startHub() }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = ui.dp(5) }) }))
            addView(ui.card(ui.cardHeader("Activity"), activity))
        }
        updaters.add {
            val pct = HubState.lastPct; val age = if (HubState.lastReadAt > 0) (System.currentTimeMillis() - HubState.lastReadAt) / 60000 else -1L
            val color = if (pct == null) Theme.faint else if (pct >= 50) Theme.ok else if (pct >= 20) Theme.warn else Theme.bad
            val txt = SpannableString(if (pct == null) "-" else "$pct%"); if (pct != null) txt.setSpan(RelativeSizeSpan(0.5f), txt.length - 1, txt.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); big.text = txt
            sub.text = if (age < 0) "Waiting for the first reading" else "Read ${ago(HubState.lastReadAt)}"
            val stale = age > 20
            ui.setChip(tankChip, if (pct == null) "Waiting" else if (stale) "Stale" else if (HubState.charging == true) "Charging" else "Live", if (pct == null) Theme.faint else if (stale) Theme.warn else if (HubState.charging == true) Theme.blue else Theme.ok)
            bar.removeAllViews(); bar.addView(ui.bar(pct ?: 0, color))
            val g = HubState.gridOn
            gridValue.text = if (g == null) "Not read yet" else if (g) "On" else "Off"; gridValue.setTextColor(if (g == true) Theme.ok else Theme.text)
            gridNote.text = if (g == null) "" else "score ${HubState.gridScore ?: 0}, ${ago(HubState.gridAt)}"
            val sn = HubState.lastSnap
            if (sn != null) { pic.visibility = View.VISIBLE; picNote.text = "Taken ${ago(HubState.lastSnapAt)}"; if (HubState.lastSnapAt != shownSnapAt) { shownSnapAt = HubState.lastSnapAt; pic.setImageBitmap(BitmapFactory.decodeByteArray(sn, 0, sn.size)) } }
            activity.text = HubState.text().lines().filter { it.isNotBlank() }.takeLast(6).joinToString("\n") { if (it.length > 78) it.take(76) + "…" else it }
            val f = HubState.failover; val running = HubService.running
            ui.setChip(headerChip, if (!running) "Stopped" else if (f?.active == true) "On its own" else "Running", if (!running) Theme.bad else if (f?.active == true) Theme.warn else Theme.ok)
        }
        return sv
    }

    // ---------------------------------------------------------------- Plugs
    private fun plugsScreen(): View {
        val dyn: Dynamic
        val (sv, col) = screen("Plugs") { }
        dyn = Dynamic(col.let { LinearLayout(this).also { b -> b.orientation = LinearLayout.VERTICAL; it.addView(b) } })
        updaters.add {
            val h = HubState.home
            if (h == null) dyn.set("off") { addView(ui.card(ui.cardHeader("Home side is off"), ui.text("Turn on “Plugs, router and rules on this phone” in Settings.", 14f, Theme.muted))) }
            else {
                val names = h.plugs.names(); val arr = h.plugs.snapshot(); val sig = arr.toString() + h.lastReportAt / 10000
                dyn.set(sig) {
                    if (arr.length() == 0) addView(ui.card(ui.cardHeader("Looking for plugs"), ui.text("None is answering yet. This can take a minute after the app starts.", 14f, Theme.muted)))
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i); val name = names[o.getString("id")] ?: o.getString("id")
                        if (o.optBoolean("unreachable")) { addView(ui.card(ui.cardHeader(name, ui.chip("Not answering", Theme.bad)), ui.text("Last seen ${ago(o.optLong("lastSeenAt"))}", 14f, Theme.muted))); continue }
                        val on = o.opt("on") == true
                        fun metric(v: String, unit: String) = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; addView(ui.text(v, 26f, Theme.text, ui.light)); addView(ui.text(unit, 12f, Theme.faint)) }
                        addView(ui.card(ui.cardHeader(name, ui.chip(if (on) "On" else "Off", if (on) Theme.ok else Theme.muted)),
                            LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL
                                addView(metric(fmt(o, "watts"), "watts"), LinearLayout.LayoutParams(0, -2, 1f)); addView(metric(fmt(o, "volts", 0), "volts"), LinearLayout.LayoutParams(0, -2, 1f)); addView(metric(fmt(o, "amps", 2), "amps"), LinearLayout.LayoutParams(0, -2, 1f)) },
                            ui.spacer(10), ui.row("Energy", "${fmt(o, "kwh", 2)} kWh")))
                    }
                    addView(ui.text("Reported to Tenergy ${ago(h.lastReportAt)}", 12f, Theme.faint).apply { setPadding(ui.dp(4), 0, 0, 0) })
                }
            }
        }
        return sv
    }

    // ---------------------------------------------------------------- Router
    private fun routerScreen(): View {
        val (sv, col) = screen("Router") { }
        val dyn = Dynamic(LinearLayout(this).also { it.orientation = LinearLayout.VERTICAL; col.addView(it) })
        updaters.add {
            val h = HubState.home; val r = h?.lastRouter
            if (h == null) dyn.set("off") { addView(ui.card(ui.cardHeader("Home side is off"), ui.text("Turn on “Plugs, router and rules on this phone” in Settings.", 14f, Theme.muted))) }
            else if (r == null) dyn.set("wait") { addView(ui.card(ui.cardHeader("Checking the router"), ui.text("The first check takes about half a minute.", 14f, Theme.muted))) }
            else dyn.set(r.toString()) {
                val status = r.opt("status"); val (word, color) = when (status) { 0 -> "Good" to Theme.ok; 1 -> "Slow" to Theme.warn; 2 -> "Internet down" to Theme.bad; 3 -> "Router down" to Theme.bad; else -> "Unknown" to Theme.muted }
                val ms = if (r.isNull("netMs")) "-" else r.get("netMs").toString()
                addView(ui.card(ui.cardHeader("Connection", ui.chip(word, color)),
                    LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM; addView(ui.text(ms, 52f, Theme.text, ui.light)); addView(ui.text(" ms", 18f, Theme.faint).apply { setPadding(0, 0, 0, ui.dp(8)) }) },
                    ui.text("to the internet", 13f, Theme.muted), ui.spacer(10),
                    ui.row("Router", (if (r.isNull("gwMs")) "-" else r.get("gwMs").toString()) + " ms", first = true), ui.row("Packets lost", "${r.opt("netLoss")}%"), ui.row("Up in the last 24 h", "${r.opt("uptime24")}%")))
                val z = r.optJSONObject("zte")
                if (z != null) {
                    val bars = z.optInt("bars", 0)
                    addView(ui.card(ui.cardHeader("Mobile network", ui.chip(z.optString("type", "-"), Theme.blue)),
                        LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                            addView(ui.text(z.optString("provider", "-"), 17f, Theme.text, ui.medium), LinearLayout.LayoutParams(0, -2, 1f)); addView(ui.signal(bars, if (bars >= 3) Theme.ok else if (bars == 2) Theme.warn else Theme.bad)) },
                        ui.spacer(8), ui.row("Signal (RSRP)", "${z.opt("rsrp")} dBm", first = true), ui.row("Quality (SINR)", "${z.opt("sinr")} dB"), ui.row("Band", z.optString("band", "-"))))
                    val devs = z.optJSONArray("devices")
                    if (devs != null && devs.length() > 0) {
                        var alive = 0; for (i in 0 until devs.length()) if (devs.getJSONObject(i).opt("alive") == true) alive++
                        val rows = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                        for (i in 0 until devs.length()) {
                            val d = devs.getJSONObject(i); val up = d.opt("alive") == true
                            rows.addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL
                                if (i > 0) addView(View(this@MainActivity).apply { setBackgroundColor(Theme.track) }, LinearLayout.LayoutParams(-1, ui.dp(1)))
                                addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, ui.dp(11), 0, ui.dp(11))
                                    addView(View(this@MainActivity).apply { background = ui.shape(if (up) Theme.ok else Theme.faint, 99f) }, LinearLayout.LayoutParams(ui.dp(9), ui.dp(9)).apply { rightMargin = ui.dp(12) })
                                    addView(ui.text(d.optString("name"), 14f, if (up) Theme.text else Theme.muted), LinearLayout.LayoutParams(0, -2, 1f)); addView(ui.text(d.optString("ip"), 12f, Theme.faint)) }) })
                        }
                        addView(ui.card(ui.cardHeader("Devices", ui.chip("$alive of ${devs.length()}", if (alive == devs.length()) Theme.ok else Theme.warn)), rows))
                    }
                }
                val out = r.optJSONArray("outages")
                if (out != null && out.length() > 0) {
                    val c = ui.card(ui.cardHeader("Recent outages"))
                    for (i in 0 until out.length()) { val o = out.getJSONObject(i); c.addView(ui.row(java.text.SimpleDateFormat("MMM d, HH:mm", java.util.Locale.US).format(java.util.Date(o.getLong("start"))), o.optString("kind") + if (o.isNull("end")) " · ongoing" else "", Theme.text, first = i == 0)) }
                    addView(c)
                }
            }
        }
        return sv
    }

    // ---------------------------------------------------------------- Automation
    private fun autoScreen(): View {
        val (sv, col) = screen("Automation") { }
        val dyn = Dynamic(LinearLayout(this).also { it.orientation = LinearLayout.VERTICAL; col.addView(it) })
        updaters.add {
            val h = HubState.home; val f = HubState.failover
            if (h == null || f == null) dyn.set("off") { addView(ui.card(ui.cardHeader("Home side is off"), ui.text("Turn on “Plugs, router and rules on this phone” in Settings.", 14f, Theme.muted))) }
            else dyn.set(f.active.toString() + f.planText() + f.recent.joinToString("|") + h.lastReportAt / 30000) {
                addView(ui.card(ui.cardHeader("Safety net", ui.chip(if (f.active) "Running" else "Standing by", if (f.active) Theme.warn else Theme.ok)),
                    ui.text(if (f.active) "Tenergy can't be reached, so this phone is looking after the fridge and the tank on its own." else "Tenergy is in charge. If it can't be reached for ${cfg.failoverMin} minutes, this phone takes over.", 14f, Theme.muted),
                    ui.spacer(10), ui.row("Last report to Tenergy", ago(h.lastReportAt), first = true)))
                val p = f.planFields()
                if (p != null) addView(ui.card(ui.cardHeader("Rules it would follow"), *p.mapIndexed { i, (k, v) -> ui.row(k, v, first = i == 0) }.toTypedArray()))
                if (f.recent.isNotEmpty()) addView(ui.card(ui.cardHeader("What it did on its own"), *f.recent.map { ui.text(it, 13f, Theme.muted).apply { setPadding(0, ui.dp(4), 0, ui.dp(4)) } as View }.toTypedArray()))
            }
        }
        return sv
    }

    // ---------------------------------------------------------------- Settings
    private fun settingsScreen(): View {
        val url = ui.field("https://…", cfg.url, InputType.TYPE_TEXT_VARIATION_URI)
        val key = ui.field("Shared key", if (cfg.key.isNotEmpty()) "••••••••" else "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val every = ui.field("5", cfg.everyMin.toString(), InputType.TYPE_CLASS_NUMBER)
        val fo = ui.field("8", cfg.failoverMin.toString(), InputType.TYPE_CLASS_NUMBER)
        var dimOn = cfg.dim; var homeOn = cfg.homeOn
        val (sv, _) = screen("Settings") {
            addView(ui.card(ui.cardHeader("Connection"), ui.fieldLabel("Tenergy address"), url, ui.fieldLabel("Shared key (kept on this phone only)"), key))
            addView(ui.card(ui.cardHeader("Behaviour"), ui.fieldLabel("Minutes between tank checks"), every, ui.fieldLabel("Minutes before the phone takes over"), fo, ui.spacer(10),
                ui.switchRow("Dim the screen while the app is open", dimOn) { dimOn = it }, ui.switchRow("Plugs, router and rules on this phone", homeOn) { homeOn = it }))
            addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL
                addView(ui.primary("Save and start") {
                    cfg.url = url.text.toString(); val k = key.text.toString(); if (!k.startsWith("•")) cfg.key = k
                    cfg.everyMin = every.text.toString().toIntOrNull() ?: 5; cfg.failoverMin = fo.text.toString().toIntOrNull() ?: 8
                    cfg.dim = dimOn; cfg.homeOn = homeOn; cfg.enabled = true; applyDim()
                    if (HubService.running) HubService.stop(this@MainActivity); handler.postDelayed({ startHub() }, 800)
                }, LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = ui.dp(5) })
                addView(ui.secondary("Stop") { cfg.enabled = false; HubService.stop(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = ui.dp(5) }) })
            addView(ui.text("Tenergy Hub 2.0 · build 4", 12f, Theme.faint).apply { gravity = Gravity.CENTER; setPadding(0, ui.dp(18), 0, 0) }, LinearLayout.LayoutParams(-1, -2))
        }
        return sv
    }

    private fun startHub() { if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) HubService.start(this) else HubState.log("camera permission needed first") }

    private fun applyDim() {
        val lp = window.attributes; lp.screenBrightness = if (cfg.dim) 0.01f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE; window.attributes = lp
    }

    private fun tick() {
        for (u in updaters) try { u() } catch (_: Exception) {}
        handler.postDelayed({ tick() }, 1000)
    }

    override fun onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy() }
}
