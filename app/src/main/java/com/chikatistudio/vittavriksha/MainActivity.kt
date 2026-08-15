package com.chikatistudio.vittavriksha

import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var webAppInterface: WebAppInterface
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val screenOffReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_OFF) {
                if (::webView.isInitialized) {
                    webView.evaluateJavascript("window.onDeviceLocked && window.onDeviceLocked();", null)
                }
            }
        }
    }

    /*
     * Set when the app itself sends the user to another screen: the file picker, the share
     * sheet, system settings. Read by `onStop`, which locks the app unless this says the
     * trip was the app's own idea. Cleared on the way back in.
     */
    private var leftForAnotherApp = false

    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            val data: Intent? = result.data
            val results = if (data == null || data.data == null) {
                data?.clipData?.let { clip ->
                    Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
                }
            } else {
                arrayOf(data.data!!)
            }
            filePathCallback?.onReceiveValue(results)
        } else {
            filePathCallback?.onReceiveValue(null)
        }
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        /*
         * Keeps the app out of the app switcher's thumbnails.
         *
         * Locking on the way to the background is worth little if the switcher keeps a
         * picture of the screen as it was a moment before, balances and all. This blanks
         * that thumbnail and nothing else.
         *
         * Deliberately not FLAG_SECURE, which would do this and also refuse every
         * screenshot. Screenshots are how somebody shows a chart to their family or a bug
         * to us, and there is a "Hide amounts" setting for when the figures should not be
         * in one.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }

        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        registerReceiver(screenOffReceiver, filter)

        webView = WebView(this)
        setContentView(webView)

        // The web layer paints edge to edge and does its own insetting, so hand it the
        // system bar sizes and software keyboard (IME) insets as CSS custom properties.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val sysBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density
            val top = (sysBars.top / density).toInt()
            val sysBottom = (sysBars.bottom / density).toInt()
            val imeBottom = (ime.bottom / density).toInt()
            val isImeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())

            // Update CSS custom properties for system bars, software keyboard, and keyboard-open state.
            view.post {
                webView.evaluateJavascript(
                    """
                    (function() {
                      var doc = document.documentElement;
                      if (!doc) return;
                      doc.style.setProperty('--inset-top', '${top}px');
                      doc.style.setProperty('--inset-bottom', '${sysBottom}px');
                      doc.style.setProperty('--keyboard-inset', '${imeBottom}px');
                      if (${isImeVisible || imeBottom > 0}) {
                        doc.classList.add('keyboard-open');
                        window.dispatchEvent(new CustomEvent('keyboardshow', { detail: { height: $imeBottom } }));
                      } else {
                        doc.classList.remove('keyboard-open');
                        window.dispatchEvent(new CustomEvent('keyboardhide'));
                      }
                    })();
                    """.trimIndent(),
                    null,
                )
            }
            insets
        }

        val webSettings: WebSettings = webView.settings
        webSettings.javaScriptEnabled = true
        webSettings.domStorageEnabled = true
        WebView.setWebContentsDebuggingEnabled(true)
        
        // WebViewAssetLoader secures asset access
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webAppInterface = WebAppInterface(this, webView)
        webView.addJavascriptInterface(webAppInterface, "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                val scheme = url.scheme?.lowercase()
                if (scheme == "mailto" || scheme == "tel") {
                    return try {
                        leftForAnotherApp = true
                        val intent = Intent(Intent.ACTION_SENDTO, url).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(intent)
                        true
                    } catch (e: Exception) {
                        false
                    }
                }
                return false
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val response = assetLoader.shouldInterceptRequest(request.url) ?: return null
                return withCorrectedMimeType(request.url.path, response)
            }
        }

        // Handles file input for WebView
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // A callback left pending from an earlier chooser makes the WebView refuse
                // every later one with "unhandled error while opening file", so release it
                // before taking the new one.
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = fileChooserParams?.createIntent()
                if (intent == null) {
                    this@MainActivity.filePathCallback = null
                    return false
                }

                return try {
                    leftForAnotherApp = true
                    filePickerLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    leftForAnotherApp = false
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = null
                    false
                }
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                if (consoleMessage != null) {
                    val msg = "${consoleMessage.message()} [${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}]"
                    when (consoleMessage.messageLevel()) {
                        ConsoleMessage.MessageLevel.ERROR -> Log.e("VittaVrikshaJS", msg)
                        ConsoleMessage.MessageLevel.WARNING -> Log.w("VittaVrikshaJS", msg)
                        else -> Log.d("VittaVrikshaJS", msg)
                    }
                }
                return true
            }
        }

        // Loads via virtual domain
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        // Handles back press. The web layer handles closing sheets, dialogs, sub-pages,
        // and tab history before letting the back press exit the app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized) {
                    webView.evaluateJavascript(
                        "(window.onSystemBackPressed && window.onSystemBackPressed()) || false;"
                    ) { result ->
                        val handled = result?.trim()?.equals("true", ignoreCase = true) == true
                        if (!handled) {
                            isEnabled = false
                            onBackPressedDispatcher.onBackPressed()
                            isEnabled = true
                        }
                    }
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }

    /**
     * Corrects the content type of an asset before the WebView sees it.
     *
     * The asset loader guesses the type from the file extension and falls back to plain
     * text for anything it does not know, which includes the two extensions this app
     * depends on most. A module served as plain text is refused outright by the engine,
     * and WebAssembly served as plain text falls back to a slower compile path with a
     * warning. Neither is a guess worth leaving to chance.
     */
    private fun withCorrectedMimeType(
        path: String?,
        response: WebResourceResponse,
    ): WebResourceResponse {
        if (path == null || response.data == null) return response

        val mimeType = when {
            path.endsWith(".mjs") || path.endsWith(".js") -> "text/javascript"
            path.endsWith(".wasm") -> "application/wasm"
            path.endsWith(".json") -> "application/json"
            path.endsWith(".css") -> "text/css"
            path.endsWith(".woff2") -> "font/woff2"
            path.endsWith(".db") -> "application/octet-stream"
            else -> return response
        }

        return WebResourceResponse(mimeType, null, response.data).apply {
            responseHeaders = response.responseHeaders
        }
    }

    /**
     * Android answers a permission request here, long after the JavaScript that asked for
     * it has returned. Forward the answer so the UI can update itself instead of guessing
     * on a timer.
     */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        val name = WebAppInterface.nameForRequestCode(requestCode) ?: return
        val granted = grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }

        webAppInterface.reportPermissionResult(name, granted)
    }

    /**
     * Says that what happens next is the app sending the user somewhere, not the user
     * leaving, so the next `onStop` does not lock. Called before starting a share sheet.
     */
    fun leavingForAnotherApp() {
        leftForAnotherApp = true
    }

    /** Opens this app's page in system settings, for a permission the user has blocked. */
    fun openAppSettings() {
        leftForAnotherApp = true
        startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    /**
     * Permissions can also be changed from system settings while the app sits in the
     * background, so the web layer is told to re-read them on the way back in.
     */
    override fun onResume() {
        super.onResume()
        leftForAnotherApp = false
        if (::webView.isInitialized) {
            webView.evaluateJavascript("window.onAppResumed && window.onAppResumed();", null)
        }
    }

    /**
     * Locks the app on the way out of sight.
     *
     * `onStop` and not `onPause`, because `onPause` also fires for anything that merely
     * covers the app: a permission dialog, a system prompt. Locking on those would demand
     * the PIN again every time the app asked to read an SMS, which teaches people to type
     * it without looking at why.
     *
     * Not while we are the ones who sent the user away. Picking a statement file and
     * returning to a locked app would abandon the import halfway, and the file picker is
     * reached from inside the app by somebody who has already proved who they are. The
     * share sheet is the same. `leftForAnotherApp` marks those, and `onResume` clears it.
     */
    override fun onStop() {
        super.onStop()
        if (leftForAnotherApp) return
        if (::webView.isInitialized) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            val isScreenOff = powerManager?.isInteractive == false || keyguardManager?.isKeyguardLocked == true
            val isPhoneLocked = if (isScreenOff) "true" else "false"
            webView.evaluateJavascript("window.onAppBackgrounded && window.onAppBackgrounded($isPhoneLocked);", null)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(screenOffReceiver)
        } catch (_: Exception) {}
    }
}
