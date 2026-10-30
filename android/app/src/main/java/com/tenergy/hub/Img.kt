package com.tenergy.hub

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/** JavaScript's Math.round (halves round up), which Kotlin's own round() does not do. */
fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

/** A picture as packed ARGB pixels, with just the operations the reader needs. Pure Kotlin, so the same code runs on the phone and in tests on a PC. */
class Img(val w: Int, val h: Int, val px: IntArray) {
    fun lum(i: Int): Double { val p = px[i]; return 0.299 * ((p shr 16) and 255) + 0.587 * ((p shr 8) and 255) + 0.114 * (p and 255) }

    /** Turn clockwise by a multiple of 90 degrees. */
    fun rotateCW(deg: Int): Img {
        val k = ((deg % 360) + 360) % 360
        return when (k) {
            0 -> this
            90 -> { val o = IntArray(w * h); for (y in 0 until h) for (x in 0 until w) o[x * h + (h - 1 - y)] = px[y * w + x]; Img(h, w, o) }
            180 -> { val o = IntArray(w * h); for (i in 0 until w * h) o[w * h - 1 - i] = px[i]; Img(w, h, o) }
            270 -> { val o = IntArray(w * h); for (y in 0 until h) for (x in 0 until w) o[(w - 1 - x) * h + y] = px[y * w + x]; Img(h, w, o) }
            else -> throw IllegalArgumentException("not a quarter turn: $deg")
        }
    }

    /** A small tilt (any angle), the canvas grows to hold the whole picture and the corners are black. Bilinear, like the counter-tilt search in the JS reader. */
    fun rotateAny(deg: Double): Img {
        val a = Math.toRadians(deg); val c = cos(a); val s = sin(a)
        val nw = ceil(abs(w * c) + abs(h * s)).toInt(); val nh = ceil(abs(w * s) + abs(h * c)).toInt()
        val o = IntArray(nw * nh); val cx = (w - 1) / 2.0; val cy = (h - 1) / 2.0; val ncx = (nw - 1) / 2.0; val ncy = (nh - 1) / 2.0
        for (y in 0 until nh) for (x in 0 until nw) {
            val dx = x - ncx; val dy = y - ncy
            val sx = c * dx + s * dy + cx; val sy = -s * dx + c * dy + cy
            if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue
            val x0 = floor(sx).toInt(); val y0 = floor(sy).toInt(); val x1 = minOf(x0 + 1, w - 1); val y1 = minOf(y0 + 1, h - 1); val fx = sx - x0; val fy = sy - y0
            fun ch(shift: Int): Int {
                val p00 = (px[y0 * w + x0] shr shift) and 255; val p10 = (px[y0 * w + x1] shr shift) and 255
                val p01 = (px[y1 * w + x0] shr shift) and 255; val p11 = (px[y1 * w + x1] shr shift) and 255
                return jsRound((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy)
            }
            o[y * nw + x] = (255 shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
        }
        return Img(nw, nh, o)
    }

    /** Shrink to a width, keeping the shape (area average, which is what a downscale should do). */
    /** Tilt by any angle, keeping the picture's size. What the turn leaves empty at the corners is filled with the nearest edge pixel, never black: a black wedge looks like a huge dark display to the reader. */
    fun tilt(deg: Double): Img {
        val a = Math.toRadians(deg); val c = cos(a); val s = sin(a); val cx = (w - 1) / 2.0; val cy = (h - 1) / 2.0; val o = IntArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            val dx = x - cx; val dy = y - cy
            val sx = (c * dx + s * dy + cx).coerceIn(0.0, (w - 1).toDouble()); val sy = (-s * dx + c * dy + cy).coerceIn(0.0, (h - 1).toDouble())
            val x0 = floor(sx).toInt(); val y0 = floor(sy).toInt(); val x1 = minOf(x0 + 1, w - 1); val y1 = minOf(y0 + 1, h - 1); val fx = sx - x0; val fy = sy - y0
            fun ch(shift: Int): Int {
                val p00 = (px[y0 * w + x0] shr shift) and 255; val p10 = (px[y0 * w + x1] shr shift) and 255; val p01 = (px[y1 * w + x0] shr shift) and 255; val p11 = (px[y1 * w + x1] shr shift) and 255
                return ((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy + 0.5).toInt()
            }
            o[y * w + x] = (255 shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
        }
        return Img(w, h, o)
    }

    /** A rectangle of the picture (clipped to its edges). */
    fun crop(x: Int, y: Int, cw: Int, ch: Int): Img {
        val x0 = x.coerceIn(0, w - 1); val y0 = y.coerceIn(0, h - 1); val x1 = (x + cw).coerceIn(x0 + 1, w); val y1 = (y + ch).coerceIn(y0 + 1, h)
        val nw = x1 - x0; val nh = y1 - y0; val o = IntArray(nw * nh)
        for (yy in 0 until nh) System.arraycopy(px, (y0 + yy) * w + x0, o, yy * nw, nw)
        return Img(nw, nh, o)
    }

    fun resizeWidth(nw: Int): Img {
        if (nw >= w) return this
        val nh = maxOf(1, jsRound(h.toDouble() * nw / w)); val o = IntArray(nw * nh); val fx = w.toDouble() / nw; val fy = h.toDouble() / nh
        for (y in 0 until nh) {
            val ys = floor(y * fy).toInt(); val ye = minOf(h, maxOf(ys + 1, ceil((y + 1) * fy).toInt()))
            for (x in 0 until nw) {
                val xs = floor(x * fx).toInt(); val xe = minOf(w, maxOf(xs + 1, ceil((x + 1) * fx).toInt()))
                var r = 0L; var g = 0L; var b = 0L; var n = 0
                for (yy in ys until ye) for (xx in xs until xe) { val p = px[yy * w + xx]; r += (p shr 16) and 255; g += (p shr 8) and 255; b += p and 255; n++ }
                o[y * nw + x] = (255 shl 24) or ((r / n).toInt() shl 16) or ((g / n).toInt() shl 8) or (b / n).toInt()
            }
        }
        return Img(nw, nh, o)
    }

    /** A 32x24 grey copy: enough to tell "same scene" from "something changed". */
    fun signature(): IntArray {
        val small = Img(w, h, px).let { src ->
            val o = IntArray(32 * 24); val fx = src.w / 32.0; val fy = src.h / 24.0
            for (y in 0 until 24) for (x in 0 until 32) {
                val xs = floor(x * fx).toInt(); val xe = minOf(src.w, maxOf(xs + 1, ceil((x + 1) * fx).toInt())); val ys = floor(y * fy).toInt(); val ye = minOf(src.h, maxOf(ys + 1, ceil((y + 1) * fy).toInt()))
                var sum = 0.0; var n = 0
                for (yy in ys until ye step maxOf(1, (ye - ys) / 4)) for (xx in xs until xe step maxOf(1, (xe - xs) / 4)) { sum += src.lum(yy * src.w + xx); n++ }
                o[y * 32 + x] = if (n == 0) 0 else jsRound(sum / n)
            }
            o
        }
        return small
    }
}

fun meanDiff(a: IntArray?, b: IntArray?): Double = if (a == null || b == null) 255.0 else a.indices.sumOf { abs(a[it] - b[it]).toDouble() } / a.size
