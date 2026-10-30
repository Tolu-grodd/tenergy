package com.tenergy.hub

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import kotlin.math.ceil

fun decodeJpeg(bytes: ByteArray): Img {
    val b = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IllegalStateException("could not decode the picture")
    val px = IntArray(b.width * b.height); b.getPixels(px, 0, b.width, 0, 0, b.width, b.height); val img = Img(b.width, b.height, px); b.recycle(); return img
}

fun encodeJpeg(img: Img, quality: Int): ByteArray {
    val b = Bitmap.createBitmap(img.px, img.w, img.h, Bitmap.Config.ARGB_8888)
    val out = ByteArrayOutputStream(); b.compress(Bitmap.CompressFormat.JPEG, quality, out); b.recycle(); return out.toByteArray()
}

class PhotoRead(val value: Int?, val note: String, val blank: Boolean, val grid: Segments.GridRead?)

/** What one check of the tank found. Same rules as the Termux agent's takePhotoSet: enough READABLE frames must agree, blank frames mean the tank is charging, the grid light is read from every frame. */
class PhotoSet(val photos: List<PhotoRead>, val sig: IntArray?, val mid: Img?, val charging: Boolean?, val timing: String, val summary: CameraSession.Summary, val last: Img?, val crops: List<Pair<Int?, Img>> = emptyList())

object Checker {
    fun takePhotoSet(ctx: android.content.Context, cfg: Config, log: (String) -> Unit): PhotoSet {
        val votes = cfg.votes; var limit = cfg.maxShots
        val photos = ArrayList<PhotoRead>(); var readable = 0; var blanks = 0; var mid: Img? = null; var sig: IntArray? = null; var last: Img? = null
        val cam = CameraSession(ctx, cfg.camera, log); cam.ev = HubState.ev // start with the exposure that worked last time
        var tried = 0; val crops = ArrayList<Pair<Int?, Img>>() // a close-up of the display from each frame, with what the reader made of it
        val summary = cam.run(torch = true, warmupMs = 700, afTimeoutMs = 3000, gapMs = 400) { bytes, i ->
            var img = decodeJpeg(bytes)
            img = img.rotateCW(360 - cfg.rotate) // the same quarter turn the JavaScript agent applies with CAMERA_ROTATE (its 270 is this direction)
            var read: Segments.DisplayRead = Segments.DisplayRead(null, "reader failed")
            try { read = Segments.readDisplayAuto(img, System.currentTimeMillis(), HubState.lastPct) } catch (e: Exception) { read = Segments.DisplayRead(null, e.message ?: "reader failed") }
            var grid: Segments.GridRead? = null
            if (read.panel?.ring == true) { try { grid = Segments.readGridLight(read.image ?: img, read.panel) } catch (_: Exception) {} }
            photos.add(PhotoRead(read.value, read.note, read.blank, grid))
            read.panel?.let { w -> try { val im = read.image ?: img; crops.add(read.value to im.crop((w.x0 - 0.12 * w.w).toInt(), (w.y0 - 0.12 * w.w).toInt(), (1.3 * w.w).toInt(), (0.9 * w.w).toInt()).resizeWidth(320)) } catch (_: Exception) {} }
            if (read.blank) blanks++ else if (read.value != null) {
                readable++
                if (readable == ceil(votes / 2.0).toInt()) { mid = (if (read.quarter != 0 && read.image != null) read.image!! else img).resizeWidth(1280); sig = mid!!.signature() }
            }
            last = img
            // While charging, the tank blinks its number, and at times it stays off for half a minute or more. If the first frames are all blank, keep looking for much longer: the number comes back.
            // A display that is found but cannot be read (digits glowing into each other, a bar too dim) is usually glare: take the next frames darker, then brighter, and remember what worked.
            if (read.value != null) HubState.ev = cam.ev
            else if (!read.blank && Regex("run together|digit unclear|layout is off|no % sign|not level|missing").containsMatchIn(read.note)) {
                val ladder = intArrayOf(0, -2, -4, -6, 2, -8)
                tried++; val next = ladder[tried % ladder.size].coerceIn(cam.evMin, cam.evMax)
                if (next != cam.ev) { log("display found but not readable (${read.note}): trying exposure $next"); cam.ev = next }
            }
            if (i == 5 && readable == 0 && blanks >= 4) { limit = 24; log("all blank so far: the tank is blinking, looking for longer") }
            i < limit && readable < votes
        }
        if (mid == null && last != null) { mid = last!!.resizeWidth(1280); sig = mid!!.signature() } // nothing readable: keep the last frame, so there is a picture to look at
        val charging = if (blanks > 0 && readable > 0) true else null // a number that blinks = charging; a steady number proves nothing
        val timing = "${photos.size} frames ($readable readable, $blanks blank) in ${summary.totalMs / 1000.0}s, focus ${summary.afResult} in ${summary.afMs}ms"
        return PhotoSet(photos, sig, mid, charging, timing, summary, last, crops)
    }
}
