package com.tenergy.hub

import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.ceil
import kotlin.math.max

/** The fridge rules, ported line for line from the Worker's auto.js, so the phone can carry on by itself if it cannot reach the Worker. A parity test checks both give the same answers. */
class Spec(val onMin: Double, val offMin: Double, val offFirst: Boolean)
class AutoCfg(
    val emergency: Double, val cutOn: Boolean, val cutAt: Double, val restoreAt: Double,
    val nightFrom: String, val nightTo: String, val night: Spec, val weak: Spec, val weakEndAt: Double, val day: Spec,
    val gridOnFridgeOn: Boolean, val overloadShed: Boolean, val staleMin: Double, val manualH: Double,
) {
    companion object {
        fun from(j: JSONObject): AutoCfg {
            val n = j.getJSONObject("night"); val w = j.getJSONObject("weak"); val d = j.getJSONObject("dayThrottle")
            return AutoCfg(j.getDouble("emergency"), j.getBoolean("cutOn"), j.getDouble("cutAt"), j.getDouble("restoreAt"),
                n.getString("from"), n.getString("to"), Spec(n.getDouble("onMin"), n.getDouble("offMin"), n.optBoolean("offFirst", true)),
                Spec(w.getDouble("onMin"), w.getDouble("offMin"), true), w.getDouble("endAt"), Spec(d.getDouble("onMin"), d.getDouble("offMin"), true),
                j.getBoolean("gridOnFridgeOn"), j.getBoolean("overloadShed"), j.getDouble("staleMin"), j.getDouble("manualH"))
        }
    }
}

class Plan(val action: String?, val reason: String, val urgent: Boolean, val src: String, val restMin: Int)
class Fridge(val on: Boolean?, val online: Boolean?)

object Auto {
    private val LAGOS = ZoneOffset.ofHours(1) // Lagos has no daylight saving
    private fun hm(s: String) = s.substring(0, 2).toInt() * 60 + s.substring(3, 5).toInt()
    private fun dayStart(date: String): Long = LocalDate.parse(date).atStartOfDay(LAGOS).toInstant().toEpochMilli()
    private fun shift(date: String, n: Int): String = LocalDate.parse(date).plusDays(n.toLong()).toString()
    fun todayAt(now: Long): String = java.time.Instant.ofEpochMilli(now).atOffset(LAGOS).toLocalDate().toString()

    /** Rhythm: on for onMin, off for offMin, over and over, counted from startedAt. With offFirst the rest comes first. Returns (on, minutes left). */
    fun cycleWant(spec: Spec, startedAt: Long, now: Long): Pair<Boolean, Int> {
        val on = (spec.onMin * 60e3).toLong(); val off = (spec.offMin * 60e3).toLong(); val tot = on + off
        val pos = (((now - startedAt) % tot) + tot) % tot
        fun left(x: Long) = ceil(x / 60e3).toInt()
        return if (spec.offFirst) { if (pos < off) false to left(off - pos) else true to left(tot - pos) } else { if (pos < on) true to left(on - pos) else false to left(tot - pos) }
    }

    /** The stretch of the clock containing `now` for a window like 17:30 to 08:00 (which crosses midnight): start and end in ms, or null. */
    fun windowAt(from: String, to: String, now: Long, today: String): Pair<Long, Long>? {
        val a = hm(from); val b = hm(to); val len = (if (b > a) b - a else b + 1440 - a) * 60_000L
        for (n in intArrayOf(-1, 0)) { val start = dayStart(shift(today, n)) + a * 60_000L; if (now >= start && now < start + len) return start to start + len }
        return null
    }

    /** What the fridge switch should be doing right now; null when the fridge plug can't be switched. */
    fun plan(cfg: AutoCfg, now: Long, today: String, fr: Fridge?, tankW: Double?, limit: Double, pct: Int?, gridOn: Boolean?, emOff: Boolean, weak: Boolean, anchor: Long, dayThrottle: Boolean, anchorAt: Long = anchor): Plan? {
        if (fr == null || fr.online == false || fr.on == null) return null
        fun out(want: Boolean, reason: String, urgent: Boolean = false, src: String = "auto", restMin: Int = 0) = Plan(if (want == fr.on) null else if (want) "on" else "off", reason, urgent, src, restMin)
        if (cfg.overloadShed && gridOn != true && tankW != null && tankW > limit) return out(false, "The tank is at ${jsRound(tankW)} W, over its ${fmt(limit)} W limit", urgent = true)
        if (gridOn == true) return if (cfg.gridOnFridgeOn) out(true, "The grid is on") else Plan(null, "The grid is on", false, "auto", 0)
        val unk = if (gridOn == null) " (grid unknown)" else ""
        if (emOff) return out(false, "Battery at ${pct?.toString() ?: "?"}%, at or below ${fmt(cfg.emergency)}%: the fridge stays off until it recovers", urgent = true)
        val w = windowAt(cfg.nightFrom, cfg.nightTo, now, today)
        if (w != null) {
            val c = cycleWant(if (weak) cfg.weak else cfg.night, if (anchorAt >= w.first) anchor else w.first, now)
            return out(c.first, "${if (weak) "Weak night" else "Night"} rhythm$unk: fridge ${if (c.first) "on" else "off"} for another ${c.second} min", src = "cycle", restMin = if (c.first) 0 else c.second)
        }
        if (dayThrottle) {
            val morning = dayStart(today) + hm(cfg.nightTo) * 60_000L; val c = cycleWant(cfg.day, if (anchorAt >= morning) anchor else morning, now)
            return out(c.first, "Day throttle$unk: fridge ${if (c.first) "on" else "off"} for another ${c.second} min", src = "cycle", restMin = if (c.first) 0 else c.second)
        }
        return out(true, "Daytime$unk: the fridge stays on")
    }

    /** Where the rhythm should be counted from when an event restarts it (the grid going off, Weak night ending): from where the fridge really is. On for a full on-phase or more: rest first. On for less: carry on
     *  the on-phase for what is left. Off for a full rest or more: on-phase now. Off for less: carry on resting. Same as `phaseAnchor` in the Worker's auto.js. */
    fun phaseAnchor(spec: Spec, on: Boolean?, since: Long?, now: Long): Long {
        val onMs = (spec.onMin * 60e3).toLong(); val offMs = (spec.offMin * 60e3).toLong()
        if (on == null || since == null || since > now) return now
        val run = now - since
        return if (on) (if (run >= onMs) now else now - (offMs + run)) else (if (run >= offMs) now - offMs else now - run)
    }

    /** The rhythm that applies right now (null in plain daytime). */
    fun rhythmNow(cfg: AutoCfg, weak: Boolean, dayThrottle: Boolean, now: Long, today: String): Spec? = if (weak) cfg.weak else if (windowAt(cfg.nightFrom, cfg.nightTo, now, today) != null) cfg.night else if (dayThrottle) cfg.day else null

    /** Seconds until the tank plug's own timer should bring the output back after a cut (same rule as `tankBackSecs` in the Worker): at the set time next morning, or a set delay later if the cut is in the daytime. */
    fun tankBackSecs(backAt: String, dayMin: Int, now: Long): Int {
        val tgt = hm(backAt); val m = (((now + 3600_000L) / 60_000L) % 1440L).toInt()
        // the plug's timer was measured to run about 9 % slow, so it is set a little shorter to land on time
        if (m >= tgt && m < 15 * 60) return Math.round(dayMin * 60 / 1.08).toInt()
        var d = tgt - m; if (d <= 0) d += 1440
        return Math.round(Math.min(86400, Math.max(d * 60, dayMin * 60)) / 1.08).toInt()
    }

    private fun fmt(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString() // a JavaScript number prints without ".0"
}
