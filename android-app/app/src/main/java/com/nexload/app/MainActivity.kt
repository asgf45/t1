package com.nexload.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var currentUrl: String = "http://10.0.2.2:3000"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        setupWebView()

        showUrlInputDialog()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val webSettings: WebSettings = webView.settings
        webSettings.javaScriptEnabled = true
        webSettings.domStorageEnabled = true
        webSettings.databaseEnabled = true
        webSettings.allowFileAccess = true
        webSettings.allowContentAccess = true

        webView.addJavascriptInterface(WebAppInterface(this), "Android")
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        // Handle downloads
        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
            if (checkStoragePermission()) {
                downloadFile(url, userAgent, contentDisposition, mimetype)
            } else {
                requestStoragePermission()
                // The user will have to click again after granting permission for now
            }
        }
    }

    private fun showUrlInputDialog() {
        val builder = AlertDialog.Builder(this)
        builder.setTitle("Connect to NexLoad Server")
        builder.setMessage("Enter server URL (e.g., http://192.168.1.100:3000)")

        val input = EditText(this)
        input.setText(currentUrl)
        builder.setView(input)

        builder.setPositiveButton("Connect") { _, _ ->
            var url = input.text.toString().trim()
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://$url"
            }
            currentUrl = url
            webView.loadUrl(currentUrl)
        }
        builder.setNegativeButton("Use Default") { _, _ ->
            webView.loadUrl(currentUrl)
        }

        builder.show()
    }

    private fun downloadFile(url: String, userAgent: String, contentDisposition: String, mimetype: String) {
        val request = DownloadManager.Request(Uri.parse(url))
        val filename = URLUtil.guessFileName(url, contentDisposition, mimetype)

        request.setMimeType(mimetype)
        val cookies = CookieManager.getInstance().getCookie(url)
        request.addRequestHeader("cookie", cookies)
        request.addRequestHeader("User-Agent", userAgent)
        request.setDescription("Downloading file...")
        request.setTitle(filename)
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)

        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.enqueue(request)
        Toast.makeText(this, "Download Started: $filename", Toast.LENGTH_LONG).show()
    }

    private fun checkStoragePermission(): Boolean {
        return if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        } else {
            true // Scoped storage on Android 10+
        }
    }

    private fun requestStoragePermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
        }
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
    }
}
