package com.thomas.ladybird

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebView

/**
 * A fullscreen WebView on <dashboard_url>/tv?room=<room>, kept awake while
 * visible. Provisioning rides the launch intent's extras (CONTRACT.md);
 * launchMode=singleTask routes a re-provisioning `am start` to onNewIntent.
 */
class MainActivity : Activity() {
    private var web: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val config = ConfigStore.absorb(this, intent)

        // For the dashboard's push-to-talk later; a TV remote can't answer a
        // dialog mid-use, so ask once at launch.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 0)
        }

        NtfyService.start(this)

        val view = DashboardWebView.create(this)
        setContentView(view)
        web = view
        load(config)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // New extras overwrite, missing ones keep their stored values; the
        // service restarts so the stream picks the new config up too.
        load(ConfigStore.absorb(this, intent))
        NtfyService.start(this)
    }

    private fun load(config: Config) {
        val url = config.tvUrl
        if (url == null) {
            Log.w(TAG, "no dashboard_url provisioned - see tv-app/CONTRACT.md")
            web?.loadData(
                "<body style=\"background:#000;color:#9aa3b4;font:28px sans-serif;display:grid;place-items:center\">" +
                    "No dashboard_url provisioned &#8212; see tv-app/CONTRACT.md</body>",
                "text/html",
                "utf-8",
            )
        } else {
            Log.i(TAG, "loading $url")
            web?.loadUrl(url)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }
    }

    /** Back is "leave the dashboard", never web history. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finish()
    }

    override fun onDestroy() {
        web?.let { DashboardWebView.destroy(it) }
        web = null
        super.onDestroy()
    }
}
