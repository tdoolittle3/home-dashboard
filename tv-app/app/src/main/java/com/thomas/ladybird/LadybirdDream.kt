package com.thomas.ladybird

import android.service.dreams.DreamService
import android.util.Log
import android.webkit.WebView

/**
 * The same /tv page as a screensaver, so an idle TV becomes the house display.
 * Select it with:
 *   adb shell settings put secure screensaver_components com.thomas.ladybird/.LadybirdDream
 */
class LadybirdDream : DreamService() {
    private var web: WebView? = null

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = false
        isFullscreen = true
        isScreenBright = true

        val view = DashboardWebView.create(this)
        setContentView(view)
        web = view

        val url = ConfigStore.load(this).tvUrl
        if (url == null) {
            Log.w(TAG, "dream started without dashboard_url - see tv-app/CONTRACT.md")
        } else {
            Log.i(TAG, "dream loading $url")
            view.loadUrl(url)
        }
    }

    override fun onDetachedFromWindow() {
        web?.let { DashboardWebView.destroy(it) }
        web = null
        super.onDetachedFromWindow()
    }
}
