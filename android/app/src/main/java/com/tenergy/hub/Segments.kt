package com.tenergy.hub

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Reads the tank's percentage from a photo without any AI: finds the dark display panel (identified by its blue ring), finds the bright digits inside it, and checks which of
 * the seven bars of each digit are lit. A line-by-line port of agent/segments.js; the unit tests make sure the two give the same answers on the reference photos.
 * The picture must already be upright. A reading it is not sure about comes back as null, never as a guess.
 */
object Segments {
    private val SEG_ORDER = "abcdefg"
    private val SEGS = mapOf(
        'a' to doubleArrayOf(0.2, 0.8, 0.0, 0.17), 'b' to doubleArrayOf(0.7, 1.0, 0.08, 0.47), 'c' to doubleArrayOf(0.7, 1.0, 0.53, 0.92), 'd' to doubleArrayOf(0.2, 0.8, 0.83, 1.0),
        'e' to doubleArrayOf(0.0, 0.3, 0.53, 0.92), 'f' to doubleArrayOf(0.0, 0.3, 0.08, 0.47), 'g' to doubleArrayOf(0.2, 0.8, 0.41, 0.59),
    )
    private val DIGITS = listOf(0 to "abcdef", 1 to "bc", 2 to "abdeg", 3 to "abcdg", 4 to "bcfg", 5 to "acdfg", 6 to "acdefg", 7 to "abc", 8 to "abcdefg", 9 to "abcdfg")
    private val ALT = mapOf(6 to listOf("cdefg"), 7 to listOf("abcf"), 9 to listOf("abcfg")) // some displays draw 6, 7 and 9 slightly differently
    private const val WORK_W = 640
    const val GRID_LIGHT_THRESHOLD = 75

    class Region(var x0: Int, var y0: Int, var x1: Int, var y1: Int, var n: Int, val px: IntArrayList?)
    class IntArrayList { var a = IntArray(256); var size = 0; fun add(v: Int) { if (size == a.size) a = a.copyOf(size * 2); a[size++] = v } }
    class Panel(val x0: Int, val y0: Int, val x1: Int, val y1: Int, val score: Int, val lo: IntArray, val hi: IntArray, val ring: Boolean)
    class Shape(val x0: Int, val x1: Int, val y0: Int, val y1: Int, val h: Int, val slope: Double, val ymid: Double, val u0: Double, val u1: Double, val w: Int)
    class Cell(val s: Shape, var digit: Int?, val dist: Double, val margin: Double, val frac: Map<Char, Double>)
    class Where(val x0: Double, val y0: Double, val w: Double, val ring: Boolean)
    class DisplayRead(val value: Int?, val note: String, val blank: Boolean = false, val panel: Where? = null, val angle: Int = 0, val image: Img? = null, val digits: List<Cell> = emptyList(), val quarter: Int = 0)
    class GridRead(val score: Int, val on: Boolean)

    // connected regions of a mask (8-way)
    private fun regions(mask: ByteArray, W: Int, H: Int, keepPixels: Boolean = false): List<Region> {
        val seen = ByteArray(W * H); val out = ArrayList<Region>(); var stack = IntArray(1024)
        for (s in 0 until W * H) {
            if (mask[s].toInt() == 0 || seen[s].toInt() != 0) continue
            val r = Region(W, H, 0, 0, 0, if (keepPixels) IntArrayList() else null)
            var sp = 0; stack[sp++] = s; seen[s] = 1
            while (sp > 0) {
                val p = stack[--sp]; val x = p % W; val y = (p - x) / W
                r.n++; if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y; r.px?.add(p)
                for (dy in -1..1) for (dx in -1..1) {
                    val nx = x + dx; val ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
                    val q = ny * W + nx
                    if (mask[q].toInt() != 0 && seen[q].toInt() == 0) { seen[q] = 1; if (sp == stack.size) stack = stack.copyOf(sp * 2); stack[sp++] = q }
                }
            }
            out.add(r)
        }
        return out
    }

    private fun lumAt(p: Int): Double = 0.299 * ((p shr 16) and 255) + 0.587 * ((p shr 8) and 255) + 0.114 * (p and 255)

    // 1. the display panel: the dark, roughly square region with a blue ring around it
    private fun findPanel(d: IntArray, W: Int, H: Int): Panel? {
        val dark = ByteArray(W * H); val white = ByteArray(W * H); val blue = ByteArray(W * H)
        for (p in 0 until W * H) {
            val c = d[p]; val r = (c shr 16) and 255; val g = (c shr 8) and 255; val b = c and 255
            dark[p] = if (lumAt(c) < 50) 1 else 0; white[p] = if (min(r, min(g, b)) > 170) 1 else 0; blue[p] = if (b > 120 && b > r + 60 && b > g - 20) 1 else 0
        }
        var best: Panel? = null
        for (r in regions(dark, W, H, true)) {
            val w = r.x1 - r.x0 + 1; val h = r.y1 - r.y0 + 1
            if (r.n < W * H * 0.008 || w < W * 0.1 || h < W * 0.1 || w.toDouble() / h < 0.75 || w.toDouble() / h > 1.35) continue // the tank's panel is close to square
            val ix0 = jsRound(r.x0 + w * 0.1); val ix1 = jsRound(r.x1 - w * 0.1); val iy0 = jsRound(r.y0 + h * 0.1); val iy1 = jsRound(r.y1 - h * 0.1)
            var whiteN = 0; for (y in iy0..iy1) for (x in ix0..ix1) whiteN += white[y * W + x]
            val m = max(3, jsRound(w * 0.08))
            fun band(xa: Int, xb: Int, ya: Int, yb: Int): Int { var n = 0; for (y in max(0, ya)..min(H - 1, yb)) for (x in max(0, xa)..min(W - 1, xb)) n += blue[y * W + x]; return n }
            val sides = intArrayOf(band(r.x0, r.x1, r.y0 - m, r.y0 + 1), band(r.x0, r.x1, r.y1 - 1, r.y1 + m), band(r.x0 - m, r.x0 + 1, r.y0, r.y1), band(r.x1 - 1, r.x1 + m, r.y0, r.y1))
            val ring = if (sides.min() >= 6) sides.sum() else 0
            val score = if (ring > 0) 100000 + ring else if (whiteN > 25) whiteN else 0 // a ring always beats a mere pile of white pixels
            if (score != 0 && (best == null || score > best.score)) {
                val lo = IntArray(H) { W }; val hi = IntArray(H) { -1 }
                val pl = r.px!!; for (k in 0 until pl.size) { val p = pl.a[k]; val x = p % W; val y = (p - x) / W; if (x < lo[y]) lo[y] = x; if (x > hi[y]) hi[y] = x }
                best = Panel(ix0, iy0, ix1, iy1, score, lo, hi, ring > 0)
            }
        }
        return best
    }

    class DigitsFound(val digits: List<Shape>, val all: List<Shape>, val mask: ByteArray, val pw: Int, val ph: Int)

    // 2. the digits, read at full resolution
    private fun findDigits(full: Img, panel: Panel, scale: Double, thrFrac: Double = 0.7): DigitsFound {
        fun inside(x: Int, y: Int): Boolean {
            val wy = floor(y / scale).toInt(); val wx = x / scale
            if (wy < 0 || wy >= panel.lo.size) return false
            return wx > panel.lo[wy] + 4 && wx < panel.hi[wy] - 4 && panel.hi[wy] >= 0
        }
        val FW = full.w; val d = full.px
        val x0 = floor(panel.x0 * scale).toInt(); val x1 = ceil(panel.x1 * scale).toInt(); val y0 = floor(panel.y0 * scale).toInt(); val y1 = ceil(panel.y1 * scale).toInt()
        val pw = x1 - x0 + 1; val ph = y1 - y0 + 1
        var peak = 0.0; for (y in y0..y1) for (x in x0..x1) peak = max(peak, lumAt(d[y * FW + x]))
        val thr = max(150.0, peak * thrFrac); val mask = ByteArray(pw * ph)
        for (y in 0 until ph) for (x in 0 until pw) if (inside(x0 + x, y0 + y) && lumAt(d[(y0 + y) * FW + x0 + x]) > thr) mask[y * pw + x] = 1
        // the digits are the biggest cluster of lit pixels (grown a little so each digit's bars hold together)
        val grown = ByteArray(pw * ph); val R = 4
        for (y in 0 until ph) for (x in 0 until pw) if (mask[y * pw + x].toInt() != 0) for (dy in -R..R) for (dx in -R..R) { val nx = x + dx; val ny = y + dy; if (nx >= 0 && ny >= 0 && nx < pw && ny < ph) grown[ny * pw + nx] = 1 }
        var main: Region? = null; var mainN = -1
        for (r in regions(grown, pw, ph)) { var n = 0; for (y in r.y0..r.y1) for (x in r.x0..r.x1) n += mask[y * pw + x]; if (main == null || n > mainN) { main = r; mainN = n } }
        if (main == null) return DigitsFound(emptyList(), emptyList(), mask, pw, ph)
        val hh = main.y1 - main.y0; val padT = jsRound(hh * 0.1); val padB = jsRound(hh * 0.4); val col = IntArray(pw)
        for (y in 0 until ph) for (x in 0 until pw) { if (y < main.y0 - padT || y > main.y1 + padB) mask[y * pw + x] = 0 else if (mask[y * pw + x].toInt() != 0) col[x]++ }
        val groups = ArrayList<IntArray>(); var start = -1
        for (x in 0..pw) {
            val on = x < pw && col[x] > 1
            if (on && start < 0) start = x else if (!on && start >= 0) { groups.add(intArrayOf(start, x - 1)); start = -1 }
        }
        val shapes = ArrayList<Shape>()
        for ((a, b) in groups.map { it[0] to it[1] }) {
            var ya = ph; var yb = 0
            for (y in 0 until ph) for (x in a..b) if (mask[y * pw + x].toInt() != 0) { if (y < ya) ya = y; if (y > yb) yb = y }
            val h = yb - ya + 1; val slope = 0.0; val ymid = (ya + yb) / 2.0
            var da = Double.POSITIVE_INFINITY; var db = Double.NEGATIVE_INFINITY
            for (y in ya..yb) for (x in a..b) if (mask[y * pw + x].toInt() != 0) { val u = x - slope * (ymid - y); if (u < da) da = u; if (u > db) db = u }
            if (h > 0) shapes.add(Shape(a, b, ya, yb, h, slope, ymid, da, db, (db - da + 1).toInt()))
        }
        val tallest = shapes.maxOfOrNull { it.h } ?: 0
        return DigitsFound(shapes.filter { it.h >= tallest * 0.7 && it.h >= ph * 0.12 }, shapes, mask, pw, ph)
    }

    // 3. one digit: how much of each of its seven bars is lit, and which number that matches best
    private fun classify(mask: ByteArray, pw: Int, ph: Int, g: Shape, cellW: Int): Cell {
        val frac = LinkedHashMap<Char, Double>(); val u0 = g.u1 - cellW + 1; val w = cellW.toDouble(); val h = g.h.toDouble()
        for (k in SEG_ORDER) {
            val sg = SEGS[k]!!; var lit = 0; var tot = 0
            var y = floor(g.y0 + sg[2] * h).toInt(); val yEnd = ceil(g.y0 + sg[3] * h - 1).toInt()
            while (y <= yEnd) {
                var u = floor(u0 + sg[0] * w).toInt(); val uEnd = ceil(u0 + sg[1] * w - 1).toInt()
                while (u <= uEnd) {
                    val x = jsRound(u + g.slope * (g.ymid - y)); tot++
                    if (x >= 0 && x < pw && y >= 0 && y < ph && mask[y * pw + x].toInt() != 0) lit++
                    u++
                }
                y++
            }
            frac[k] = if (tot != 0) lit.toDouble() / tot else 0.0
        }
        val top = max(frac.values.max(), 0.01); for (k in SEG_ORDER) frac[k] = min(1.0, frac[k]!! / top) // judge each bar against the brightest bar of the same digit
        val dist = DIGITS.map { (n, set) -> n to ((listOf(set) + (ALT[n] ?: emptyList())).minOf { t -> SEG_ORDER.sumOf { k -> abs(frac[k]!! - (if (t.contains(k)) 1.0 else 0.0)) } }) }.sortedBy { it.second }
        val best = dist[0]; val second = dist[1]; val ok = best.second < 1.7 && second.second - best.second > 0.3
        return Cell(g, if (ok) best.first else null, best.second, second.second - best.second, frac)
    }

    /** img: an upright picture. */
    /** When the camera is further away the glow around the bright digits can join two of them. Counting only the very brightest pixels separates them again, so a read that fails
     *  with "run together" or "digit unclear" is retried with a stricter cut. (Same as the JavaScript reader.) */
    fun readDisplay(img: Img): DisplayRead {
        var r = readDisplayAt(img, 0.7)
        for (frac in doubleArrayOf(0.8, 0.88, 0.94, 0.97)) {
            if (r.value != null || !(r.note.contains("run together") || r.note.contains("digit unclear"))) return r
            r = readDisplayAt(img, frac)
        }
        return r
    }

    private fun readDisplayAt(img: Img, thrFrac: Double): DisplayRead {
        val s = if (img.w > WORK_W) img.resizeWidth(WORK_W) else img; val scale = img.w.toDouble() / s.w
        val panel = findPanel(s.px, s.w, s.h) ?: return DisplayRead(null, "display not found")
        val where = Where(panel.x0 * scale, panel.y0 * scale, (panel.x1 - panel.x0) * scale, panel.ring)
        val found = findDigits(img, panel, scale, thrFrac); val all = found.all; val mask = found.mask; val pw = found.pw; val ph = found.ph
        fun fail(note: String) = DisplayRead(null, note, panel = where)
        // the % sign is the lit shape at the far right of the display
        val pctShape = all.filter { it.x1 / where.w >= 0.64 && it.x0 / where.w >= 0.575 }.maxByOrNull { it.x1 }
        val digits = found.digits.filter { it !== pctShape && (pctShape == null || it.x1 < pctShape.x0) }
        if (digits.isEmpty()) return DisplayRead(null, if (pctShape != null) "display blank (the tank blinks the number while it charges)" else "display blank", blank = true, panel = where)
        if (digits.any { it.w / where.w > 0.12 || (it.x0 / where.w < 0.372 && it.w / where.w > 0.05) }) return fail("digits run together (a shape is too wide to be one digit)")
        if (digits.any { it.w > it.h * 0.95 }) return fail("digits run together (display tilted?)")
        if (pctShape == null) return fail("no % sign found")
        run { val hMax = digits.maxOf { it.h }; val ys = digits.map { it.y1 }
            if (ys.max() - ys.min() > hMax * 0.15 || abs(pctShape.y1 - digits.last().y1) > hMax * 0.25) return fail("digits not level (display tilted?)") }
        run { val pctX = pctShape.x0 / where.w; val lastX1 = digits.last().x1 / where.w
            if (pctX < 0.59 || pctX > 0.633 || lastX1 < 0.57 || lastX1 > 0.632) return fail("layout is off (phone tilted or moved?)") }
        if (digits.size > 3) return fail("${digits.size} shapes, expected 1-3")
        val wide = digits.filter { it.w >= it.h * 0.4 }; val cellW = if (wide.isNotEmpty()) wide.maxOf { it.w } else jsRound(digits[0].h * 0.55)
        if (pctShape.x0 - digits.last().x1 > cellW * 0.5) return fail("a digit is missing next to the % sign")
        fun narrow(g: Shape) = g.w < g.h * 0.4
        val cells = digits.map { classify(mask, pw, ph, it, if (narrow(it)) cellW else it.w) }
        for (c in cells) if (narrow(c.s)) { val f = c.frac; val one = f['b']!! > 0.4 && f['c']!! > 0.4 && f['e']!! < 0.25 && f['f']!! < 0.25 && f['g']!! < 0.35; c.digit = if (one) 1 else null }
        if (cells.any { it.digit == null }) return DisplayRead(null, "digit unclear", panel = where, digits = cells)
        val value = cells.joinToString("") { it.digit.toString() }.toInt()
        if (value !in 0..100) return DisplayRead(null, "implausible $value", panel = where, digits = cells)
        return DisplayRead(value, "", panel = where, digits = cells)
    }

    /** The red light on the wall socket above the tank (lit while the grid supplies it). */
    fun readGridLight(img: Img, panel: Where?): GridRead? {
        if (panel == null) return null
        val W = img.w; val H = img.h; val d = img.px; val x0 = panel.x0; val y0 = panel.y0; val w = panel.w
        val xa = max(0, floor(x0 - 1.6 * w).toInt()); val xb = min(W - 1, floor(x0 + 3.6 * w).toInt()); val ya = max(0, floor(y0 - 4.2 * w).toInt()); val yb = min(H - 1, floor(y0 - 0.8 * w).toInt())
        if (xb <= xa || yb <= ya) return GridRead(0, false)
        val integ = DoubleArray((W + 1) * (H + 1))
        for (y in 0 until H) { var row = 0.0; for (x in 0 until W) { row += lumAt(d[y * W + x]); integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row } }
        val R = jsRound(0.4 * w)
        fun mean(x: Int, y: Int): Double {
            val x1 = max(0, x - R); val y1 = max(0, y - R); val x2 = min(W, x + R + 1); val y2 = min(H, y + R + 1)
            return (integ[y2 * (W + 1) + x2] - integ[y1 * (W + 1) + x2] - integ[y2 * (W + 1) + x1] + integ[y1 * (W + 1) + x1]) / ((x2 - x1) * (y2 - y1))
        }
        var peak = 0.0
        for (y in ya..yb) for (x in xa..xb) {
            val c = d[y * W + x]; val r = (c shr 16) and 255; val g = (c shr 8) and 255; val b = c and 255
            val sc = r - (g + b) / 2.0
            if (sc < 40 || r < 90 || sc <= peak) continue
            if (mean(x, y) >= 60) peak = sc // a red point in a fairly bright surrounding, not in the dark glass of the meter box
        }
        return GridRead(jsRound(peak), peak >= GRID_LIGHT_THRESHOLD)
    }

    // Reads the display even if the phone has been knocked a little: if the normal read fails, try small counter-tilts and remember the one that worked.
    private var lastAngle = 0; private var lastSearchAt = 0L
    fun resetAutoSearch() { lastAngle = 0; lastQuarter = 0; lastSearchAt = 0 }
    /** How promising a picture looks as a display picture: the display's framed panel found, with its ring, at a plausible size. 0 when there is none. Cheap: only the small working copy is searched. */
    fun displayScore(img: Img): Int {
        val s = if (img.w > WORK_W) img.resizeWidth(WORK_W) else img
        val p = findPanel(s.px, s.w, s.h) ?: return 0
        val pw = p.x1 - p.x0 + 1; val ph = p.y1 - p.y0 + 1
        if (!p.ring || pw < s.w * 0.05 || pw > s.w * 0.6 || ph > pw * 1.2 || ph < pw * 0.35) return 0
        return 1 + p.score
    }

    /** The orientation that worked last time: extra quarter turns (0, 90, 180, 270) and a small tilt in degrees. A phone that was knocked or turned is found again at once on the next check. */
    var lastQuarter = 0

    /**
     * Reads the display even if the phone has been knocked, tilted or turned. The orientation that worked last time is tried first, then straight, and when that fails (at most every
     * 5 minutes, because it is the slow part) a wider search: small tilts, large tilts up to 30 degrees, and each quarter turn with the same tilts. The search runs on a smaller copy of
     * the picture so that it stays quick; the first orientation that reads becomes the starting point for the next check.
     */
    fun readDisplayAuto(img: Img, now: Long = System.currentTimeMillis(), expected: Int? = null): DisplayRead {
        val canSearch = now - lastSearchAt > 5 * 60_000
        var first: DisplayRead? = null
        fun attempt(src: Img, q: Int, a: Int): DisplayRead {
            var im = if (q != 0) src.rotateCW(q) else src; if (a != 0) im = im.tilt(a.toDouble())
            val r = readDisplay(im); if (first == null) first = r
            return DisplayRead(r.value, r.note, r.blank, r.panel, a, im, r.digits, q)
        }
        // a reading found by searching has to be convincing: every digit matches its shape well (a narrow "1" is judged by its two bars, as always), and it is close to the last reading
        fun convincing(r: DisplayRead) = r.value != null && r.digits.isNotEmpty() && r.digits.all { it.s.w < it.s.h * 0.4 || (it.dist < 1.2 && it.margin > 0.3) } && (expected == null || Math.abs(r.value - expected) <= 15)

        // 1. the fast path on the full picture: the orientation that worked last time, then straight
        val fast = ArrayList<Pair<Int, Int>>(); fast.add(lastQuarter to lastAngle); if (lastQuarter != 0 || lastAngle != 0) fast.add(0 to 0)
        for ((q, a) in fast) { val r = attempt(img, q, a); if (r.value != null) { lastQuarter = q; lastAngle = a; return r } }
        if (!canSearch) return finish(first!!, img)
        lastSearchAt = now
        // 2. the wide search. First a cheap look on a small copy at every quarter turn and every tilt in 3-degree steps up to 36: where does a display-shaped panel appear?
        val tiny = img.resizeWidth(WORK_W)
        val seen = ArrayList<Triple<Int, Int, Int>>() // quarter, tilt, score
        for (q in intArrayOf(0, 90, 180, 270)) { val base = if (q != 0) tiny.rotateCW(q) else tiny
            for (a in -36..36 step 3) { val sc = displayScore(if (a != 0) base.tilt(a.toDouble()) else base); if (sc > 0) seen.add(Triple(q, a, sc)) } }
        // 2b. then read the few best candidates properly on a mid-size copy, with a finer look around each tilt
        val mid = if (img.w > 1280) img.resizeWidth(1280) else img
        for ((q, a, _) in seen.sortedByDescending { it.third }.take(5)) for (d in intArrayOf(0, 1, -1, 2, -2)) {
            val r = attempt(mid, q, a + d)
            if (convincing(r)) { lastQuarter = q; lastAngle = a + d; return r }
        }
        return finish(first!!, img)
    }

    private fun finish(f: DisplayRead, img: Img) = DisplayRead(f.value, f.note, f.blank, f.panel, 0, img, f.digits, 0)
}
