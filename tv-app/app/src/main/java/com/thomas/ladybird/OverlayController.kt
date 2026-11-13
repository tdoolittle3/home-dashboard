package com.thomas.ladybird

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Banners over whatever is on screen - YouTube, Sling, the dashboard itself -
 * via one TYPE_APPLICATION_OVERLAY container pinned to the top-right. It never
 * takes focus or touches, so the remote keeps driving the app underneath.
 *
 * Dismissal by ntfy priority: 1-3 after 5s, 4 after 10s, 5 is drawn red and
 * stays until a newer message lands (or 60s). At most three banners stack,
 * newest on top; the oldest falls off.
 */
object OverlayController {
    private const val MAX_STACK = 3
    private const val WIDTH_FRACTION = 0.30
    private const val MARGIN_PX = 24

    private val main = Handler(Looper.getMainLooper())
    /** Attachment fetches happen here, never on the main thread the banners draw on. */
    private val fetcher = Executors.newSingleThreadExecutor()

    private var container: LinearLayout? = null

    fun show(context: Context, client: OkHttpClient, message: NtfyMessage) {
        val app = context.applicationContext
        if (!Settings.canDrawOverlays(app)) {
            Log.w(
                TAG,
                "overlay permission missing - banner dropped. Grant it once with: " +
                    "adb shell appops set com.thomas.ladybird SYSTEM_ALERT_WINDOW allow",
            )
            return
        }

        if (message.attachmentUrl == null) {
            main.post { addBanner(app, message, null) }
            return
        }
        fetcher.execute {
            val bitmap = fetchBitmap(client, message.attachmentUrl)
            main.post { addBanner(app, message, bitmap) }
        }
    }

    /** Downsampled to roughly banner width; a 4K Frigate snapshot must not become a 50 MB bitmap. */
    private fun fetchBitmap(client: OkHttpClient, url: String): Bitmap? = try {
        client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("attachment answered ${response.code}")
            val bytes = response.body?.bytes() ?: ByteArray(0)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = 1
                while (bounds.outWidth / (inSampleSize * 2) >= 640) inSampleSize *= 2
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }
    } catch (cause: Exception) {
        Log.w(TAG, "attachment fetch failed (${cause.message}) - banner shows without the image")
        null
    }

    private fun ensureContainer(app: Context): LinearLayout {
        container?.let { return it }
        val windowManager = app.getSystemService(WindowManager::class.java)
        val width = (app.resources.displayMetrics.widthPixels * WIDTH_FRACTION).toInt()
        val column = LinearLayout(app).apply { orientation = LinearLayout.VERTICAL }
        val params = WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = MARGIN_PX
            y = MARGIN_PX
        }
        windowManager.addView(column, params)
        container = column
        return column
    }

    private fun addBanner(app: Context, message: NtfyMessage, bitmap: Bitmap?) {
        val column = ensureContainer(app)

        // "Until a newer message arrives": a new banner retires any sticky red one.
        column.children().filter { it.getTag(URGENT_TAG) == true }.forEach { remove(app, it) }

        val banner = buildBanner(app, message, bitmap)
        column.addView(banner, 0)
        while (column.childCount > MAX_STACK) {
            remove(app, column.getChildAt(column.childCount - 1))
        }

        val lifeMs = when {
            message.priority >= 5 -> 60_000L
            message.priority == 4 -> 10_000L
            else -> 5_000L
        }
        main.postDelayed({ remove(app, banner) }, lifeMs)
    }

    private fun remove(app: Context, banner: View) {
        val column = container ?: return
        if (banner.parent !== column) return
        column.removeView(banner)
        if (column.childCount == 0) {
            // Nothing drawn, nothing resident: the empty window leaves too.
            app.getSystemService(WindowManager::class.java).removeView(column)
            container = null
        }
    }

    private const val URGENT_TAG = 0x4C414459 // "LADY"

    private fun buildBanner(app: Context, message: NtfyMessage, bitmap: Bitmap?): View {
        val urgent = message.priority >= 5
        val banner = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 22, 28, 24)
            background = GradientDrawable().apply {
                cornerRadius = 20f
                setColor(if (urgent) 0xF2601018.toInt() else 0xF2171A22.toInt())
                setStroke(if (urgent) 4 else 2, if (urgent) 0xFFE5646E.toInt() else 0xFF363C4B.toInt())
            }
            setTag(URGENT_TAG, urgent)
        }

        if (message.title.isNotBlank()) {
            banner.addView(TextView(app).apply {
                text = message.title
                setTextColor(Color.WHITE)
                textSize = 22f
                typeface = Typeface.DEFAULT_BOLD
            })
        }
        if (message.message.isNotBlank()) {
            banner.addView(TextView(app).apply {
                text = message.message
                setTextColor(if (urgent) 0xFFF3D3D6.toInt() else 0xFFB9C1D1.toInt())
                textSize = 19f
            })
        }
        if (bitmap != null) {
            banner.addView(
                ImageView(app).apply {
                    setImageBitmap(bitmap)
                    adjustViewBounds = true
                    scaleType = ImageView.ScaleType.FIT_CENTER
                },
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = 16 },
            )
        }

        banner.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = 16 }
        return banner
    }

    private fun LinearLayout.children(): List<View> = (0 until childCount).map { getChildAt(it) }
}
