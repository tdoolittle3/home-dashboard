package com.thomas.ladybird

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * One WebView recipe for both surfaces (MainActivity and LadybirdDream):
 * JS + DOM storage on, media autoplays, and getUserMedia capture requests are
 * granted - the dashboard's push-to-talk needs the mic without a prompt no
 * remote can answer.
 */
object DashboardWebView {
    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context): WebView = WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        setBackgroundColor(Color.BLACK)
        webViewClient = WebViewClient()
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val capture = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }
                if (capture.isEmpty()) {
                    request.deny()
                } else {
                    request.grant(capture.toTypedArray())
                }
                Log.i(TAG, "webview permission request ${request.resources.joinToString()} -> granted ${capture.joinToString()}")
            }
        }
    }

    /** Full teardown; a leaked WebView is exactly the slow death this TV cannot afford. */
    fun destroy(view: WebView) {
        (view.parent as? ViewGroup)?.removeView(view)
        view.loadUrl("about:blank")
        view.stopLoading()
        view.destroy()
    }
}
