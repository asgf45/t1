package com.nexload.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)

        val webSettings: WebSettings = webView.settings
        webSettings.javaScriptEnabled = true
        webSettings.domStorageEnabled = true
        webSettings.databaseEnabled = true
        webSettings.allowFileAccess = true
        webSettings.allowContentAccess = true

        // Add JS Interface for communication
        webView.addJavascriptInterface(WebAppInterface(this), "Android")

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        // Load the local server address
        // Assuming the node server runs on 127.0.0.1:3000
        // Use 10.0.2.2 to access the host machine's localhost from the Android emulator
        webView.loadUrl("http://10.0.2.2:3000")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    class WebAppInterface(private val mContext: Context) {
        @JavascriptInterface
        fun showToast(toast: String) {
            Toast.makeText(mContext, toast, Toast.LENGTH_SHORT).show()
        }

        // Add more methods to handle native downloads if needed
    }
}
