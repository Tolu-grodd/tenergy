package com.tenergy.hub

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView

/** The same palette as the Tenergy web app's dark theme, so the two read as one product. */
object Theme {
    val bg = Color.parseColor("#06080D")
    val text = Color.parseColor("#F4F6FB")
    val muted = Color.parseColor("#9AA5B8")
    val faint = Color.parseColor("#5C677B")
    val blue = Color.parseColor("#3DA0FF")
    val ok = Color.parseColor("#32D74B")
    val warn = Color.parseColor("#FFB020")
    val bad = Color.parseColor("#FF6159")
    val card = Color.argb(14, 255, 255, 255)
    val cardEdge = Color.argb(26, 255, 255, 255)
    val track = Color.argb(24, 255, 255, 255)
    val soft = Color.argb(16, 255, 255, 255)
    fun soft(c: Int) = Color.argb(38, Color.red(c), Color.green(c), Color.blue(c))
}

/** Small building blocks for the screens: cards, chips, big numbers, rows, buttons, fields. Everything is drawn in code, so there is nothing to keep in step with a layout file. */
class Ui(private val ctx: Context) {
    private val density = ctx.resources.displayMetrics.density
    fun dp(n: Number): Int = (n.toFloat() * density + 0.5f).toInt()
    private fun face(name: String) = Typeface.create(name, Typeface.NORMAL)
    val regular: Typeface = face("sans-serif"); val medium: Typeface = face("sans-serif-medium"); val light: Typeface = face("sans-serif-light")

    fun shape(fill: Int, radius: Float, edge: Int = 0, edgeDp: Float = 1f): GradientDrawable = GradientDrawable().apply { setColor(fill); cornerRadius = radius * density; if (edge != 0) setStroke(dp(edgeDp), edge) }

    /** The page background: near-black with the soft blue and purple glows of the web app. */
    fun pageBackground(): LayerDrawable {
        fun glow(cx: Float, cy: Float, c: Int, r: Float) = GradientDrawable().apply { gradientType = GradientDrawable.RADIAL_GRADIENT; gradientRadius = dp(r).toFloat(); setGradientCenter(cx, cy); colors = intArrayOf(c, Color.TRANSPARENT) }
        return LayerDrawable(arrayOf(GradientDrawable().apply { setColor(Theme.bg) }, glow(0.08f, 0.02f, Color.argb(60, 10, 132, 255), 380f), glow(0.98f, 0.1f, Color.argb(42, 191, 90, 242), 320f)))
    }

    fun text(t: String = "", size: Float = 15f, color: Int = Theme.text, face: Typeface = regular, spacing: Float = 0f): TextView =
        TextView(ctx).apply { text = t; textSize = size; setTextColor(color); typeface = face; if (spacing != 0f) letterSpacing = spacing; includeFontPadding = false }

    fun card(vararg children: View): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL; background = shape(Theme.card, 22f, Theme.cardEdge); setPadding(dp(18), dp(18), dp(18), dp(18))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) }; children.forEach { addView(it) }
    }

    fun spacer(h: Int) = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(1, dp(h)) }

    /** Title row of a card: a heading on the left, an optional status chip on the right. */
    fun cardHeader(title: String, chip: TextView? = null): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        addView(text(title, 15f, Theme.text, medium), LinearLayout.LayoutParams(0, -2, 1f)); if (chip != null) addView(chip)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) }
    }

    fun chip(t: String = "", color: Int = Theme.muted): TextView = text(t, 11f, color, medium, 0.06f).apply { setChip(this, t, color) }
    fun setChip(v: TextView, t: String, color: Int) { v.text = t.uppercase(); v.setTextColor(color); v.background = shape(Theme.soft(color), 99f); v.setPadding(dp(10), dp(5), dp(10), dp(5)) }

    /** A label on the left and a value on the right, with a hairline above it (except the first). */
    fun row(label: String, value: String, valueColor: Int = Theme.text, first: Boolean = false): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        if (!first) addView(View(ctx).apply { setBackgroundColor(Theme.track) }, LinearLayout.LayoutParams(-1, dp(1)))
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(12), 0, dp(12))
            addView(text(label, 14f, Theme.muted), LinearLayout.LayoutParams(0, -2, 1f)); addView(text(value, 14f, valueColor, medium))
        })
    }

    /** A progress bar in the web app's style: a faint track and a coloured fill. */
    fun bar(percent: Int, color: Int): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; background = shape(Theme.track, 99f); layoutParams = LinearLayout.LayoutParams(-1, dp(8)).apply { topMargin = dp(14) }
        val p = percent.coerceIn(0, 100)
        addView(View(ctx).apply { background = shape(color, 99f) }, LinearLayout.LayoutParams(0, -1, p.toFloat()))
        addView(View(ctx), LinearLayout.LayoutParams(0, -1, (100 - p).toFloat().coerceAtLeast(0.001f)))
    }

    /** Cell-signal style bars, 0 to 4 lit. */
    fun signal(bars: Int, color: Int): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
        for (i in 1..4) addView(View(ctx).apply { background = shape(if (i <= bars) color else Theme.track, 2f) }, LinearLayout.LayoutParams(dp(7), dp(5 + i * 5)).apply { rightMargin = dp(3) })
    }

    fun primary(t: String, onClick: () -> Unit): Button = Button(ctx).apply {
        text = t; isAllCaps = false; textSize = 15f; typeface = medium; setTextColor(Color.WHITE); stateListAnimator = null
        background = shape(Theme.blue, 14f); setPadding(dp(18), 0, dp(18), 0); minHeight = 0; minimumHeight = dp(48); setOnClickListener { onClick() }
    }

    fun secondary(t: String, onClick: () -> Unit): Button = Button(ctx).apply {
        text = t; isAllCaps = false; textSize = 15f; typeface = medium; setTextColor(Theme.text); stateListAnimator = null
        background = shape(Theme.soft, 14f, Theme.cardEdge); setPadding(dp(18), 0, dp(18), 0); minHeight = 0; minimumHeight = dp(48); setOnClickListener { onClick() }
    }

    fun field(hint: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText = EditText(ctx).apply {
        this.hint = hint; setText(value); setTextColor(Theme.text); setHintTextColor(Theme.faint); textSize = 15f; typeface = regular; inputType = type
        background = shape(Theme.soft, 12f, Theme.cardEdge); setPadding(dp(14), dp(13), dp(14), dp(13)); isSingleLine = true
    }

    fun switchRow(label: String, on: Boolean, onChange: (Boolean) -> Unit): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8), 0, dp(8))
        addView(text(label, 14f, Theme.text), LinearLayout.LayoutParams(0, -2, 1f))
        addView(Switch(ctx).apply {
            isChecked = on; setOnCheckedChangeListener { _, v -> onChange(v) }
            val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
            thumbTintList = ColorStateList(states, intArrayOf(Color.WHITE, Color.parseColor("#C9D1DD")))
            trackTintList = ColorStateList(states, intArrayOf(Theme.ok, Theme.track))
        })
    }

    fun fieldLabel(t: String) = text(t, 12f, Theme.muted, medium).apply { setPadding(dp(4), dp(14), 0, dp(6)) }

    /** Round the corners of a picture. */
    fun rounded(v: View, radiusDp: Float) { v.clipToOutline = true; v.outlineProvider = object : ViewOutlineProvider() { override fun getOutline(view: View, o: Outline) { o.setRoundRect(0, 0, view.width, view.height, radiusDp * density) } } }

    fun tabItem(icon: Int, label: String, onClick: () -> Unit): Pair<LinearLayout, (Boolean) -> Unit> {
        val img = ImageView(ctx).apply { setImageResource(icon) }; val lab = text(label, 10.5f, Theme.faint, medium)
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(10), 0, dp(9)); setOnClickListener { onClick() }
            addView(img, LinearLayout.LayoutParams(dp(24), dp(24))); addView(lab, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(4) })
        }
        return box to { on: Boolean -> val c = if (on) Theme.blue else Theme.faint; img.setColorFilter(c); lab.setTextColor(c) }
    }

    fun frame(vararg v: View) = FrameLayout(ctx).apply { v.forEach { addView(it) } }
}
