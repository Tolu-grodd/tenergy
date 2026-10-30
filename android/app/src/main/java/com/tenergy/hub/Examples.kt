package com.tenergy.hub

import java.io.File

/**
 * Close-ups of the tank's display, each named with the number the reader agreed on (or "unread" when it could not). They stay on the phone, in the app's own folder, and are the
 * labelled examples a learned reader would be trained on. The oldest are removed beyond a few thousand, so the folder never grows without limit.
 */
object Examples {
    private const val KEEP = 4000
    fun save(root: File?, label: Int?, crop: Img?) {
        if (root == null || crop == null) return
        val dir = File(root, "examples"); dir.mkdirs()
        val name = (if (label != null) "v$label" else "unread") + "_" + java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US).format(java.util.Date()) + ".jpg"
        File(dir, name).writeBytes(encodeJpeg(crop, 82))
        val files = dir.listFiles() ?: return
        if (files.size > KEEP) files.sortedBy { it.name.substringAfter('_') }.take(files.size - KEEP).forEach { it.delete() }
    }
}
