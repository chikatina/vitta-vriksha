package org.chikatistudio.vittavriksha

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The only surface JavaScript can reach, and it is deliberately small.
 *
 * Everything that decides something now runs in the WebView: the schema, the queries, the
 * arithmetic, the statement parser, the encryption. What is left here is the handful of
 * things a web page genuinely cannot do on its own, which is durable storage, the
 * fingerprint prompt, the permission dialogs, an alarm that outlives the process, and the
 * share sheet.
 */
class WebAppInterface(private val mContext: Context, private val webView: WebView) {

    private val biometricHelper: BiometricHelper? =
        if (mContext is AppCompatActivity) BiometricHelper(mContext) else null

    companion object {
        /** The one file everything lives in. Unchanged from the previous layer. */
        const val DATABASE_NAME = "vittavriksha.db"

        /**
         * How many past messages one catch-up will read. A busy inbox over two years can
         * run to thousands, and every one of them crosses the bridge as text; a few
         * hundred is more than anyone reviews in a sitting.
         */
        const val MAX_INBOX_MESSAGES = 25000

        // Request codes are per permission so the result can be reported back by name.
        const val REQUEST_SMS = 101
        const val REQUEST_NOTIFICATIONS = 102

        fun requestCodeFor(name: String) = when (name) {
            "SMS" -> REQUEST_SMS
            "NOTIFICATIONS" -> REQUEST_NOTIFICATIONS
            else -> 0
        }

        fun nameForRequestCode(code: Int) = when (code) {
            REQUEST_SMS -> "SMS"
            REQUEST_NOTIFICATIONS -> "NOTIFICATIONS"
            else -> null
        }

        /**
         * Reading bank alerts needs both: one to be woken by an incoming message, one to
         * read its body.
         */
        fun androidPermissionsFor(name: String): Array<String> = when (name) {
            "SMS" -> arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
            "NOTIFICATIONS" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    // Granted at install time before Android 13, so there is nothing to ask for.
                    emptyArray()
                }
            else -> emptyArray()
        }
    }

    // ----------------------------------------------------------------- storage

    /**
     * The database file, base64 encoded, or an empty string when there is not one yet.
     *
     * The file is app-private, excluded from backup, and never leaves the device except
     * through an export the user asks for and supplies a password to.
     */
    @JavascriptInterface
    fun readDatabase(): String {
        val file = File(mContext.filesDir, DATABASE_NAME)
        if (!file.exists() || file.length() == 0L) return ""
        return Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    }

    /**
     * Writes the database file.
     *
     * The bytes go to a temporary file which is then renamed over the real one, so a
     * write interrupted half way leaves the previous file intact rather than a truncated
     * one. Losing the last few edits is recoverable; losing the file is not.
     */
    @JavascriptInterface
    fun writeDatabase(encoded: String): Boolean {
        return try {
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            val target = File(mContext.filesDir, DATABASE_NAME)
            val temporary = File(mContext.filesDir, "$DATABASE_NAME.tmp")
            temporary.writeBytes(bytes)
            // Some filesystems refuse to rename over a file that already exists, so the
            // straightforward rename is tried first and the destructive one only if it
            // fails. The window where neither file is in place is a single syscall wide.
            if (temporary.renameTo(target)) return true
            target.delete()
            temporary.renameTo(target)
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    /** Removes the file. The factory reset clears the tables first; this is the last step. */
    @JavascriptInterface
    fun deleteDatabase(): Boolean {
        val file = File(mContext.filesDir, DATABASE_NAME)
        return !file.exists() || file.delete()
    }

    // ------------------------------------------------------------- permissions

    @JavascriptInterface
    fun checkPermission(permission: String): Boolean {
        val required = androidPermissionsFor(permission)
        if (required.isEmpty()) return true

        return required.all {
            ContextCompat.checkSelfPermission(mContext, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    @JavascriptInterface
    fun requestPermission(permission: String) {
        if (mContext !is AppCompatActivity) return

        val required = androidPermissionsFor(permission)
        if (required.isEmpty()) {
            reportPermissionResult(permission, true)
            return
        }

        ActivityCompat.requestPermissions(mContext, required, requestCodeFor(permission))
    }

    /**
     * True when the user has ticked "don't ask again", or when the system will not show
     * the dialog for some other reason. The UI uses this to point at app settings instead
     * of asking again pointlessly.
     */
    @JavascriptInterface
    fun permissionIsBlocked(permission: String): Boolean {
        if (mContext !is AppCompatActivity) return false
        val required = androidPermissionsFor(permission)
        if (required.isEmpty()) return false

        return required.any {
            ContextCompat.checkSelfPermission(mContext, it) != PackageManager.PERMISSION_GRANTED &&
                !ActivityCompat.shouldShowRequestPermissionRationale(mContext, it)
        }
    }

    @JavascriptInterface
    fun openAppSettings() {
        if (mContext is MainActivity) mContext.openAppSettings()
    }

    @JavascriptInterface
    fun openEmail(email: String, subject: String, body: String): Boolean {
        return try {
            val mailtoUri = Uri.parse("mailto:${Uri.encode(email)}?subject=${Uri.encode(subject)}&body=${Uri.encode(body)}")
            val intent = Intent(Intent.ACTION_SENDTO, mailtoUri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            (mContext as? MainActivity)?.leavingForAnotherApp()
            mContext.startActivity(intent)
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    /** Called by MainActivity once Android has an answer. */
    fun reportPermissionResult(permission: String, granted: Boolean) {
        webView.post {
            webView.evaluateJavascript(
                "window.onPermissionResult && window.onPermissionResult('$permission', $granted);",
                null,
            )
        }
    }

    // -------------------------------------------------------------- biometrics

    @JavascriptInterface
    fun authenticateBiometric() {
        if (mContext is AppCompatActivity && biometricHelper != null) {
            mContext.runOnUiThread {
                biometricHelper.authenticate(
                    onSuccess = { reportBiometricResult(true, null) },
                    onError = { message -> reportBiometricResult(false, message) },
                )
            }
        } else {
            reportBiometricResult(false, "Biometrics are not available on this device.")
        }
    }

    private fun reportBiometricResult(success: Boolean, message: String?) {
        // The message reaches JavaScript inside a string literal, so quotes and newlines
        // in a system supplied error would otherwise break the call.
        val escaped = message
            ?.replace("\\", "\\\\")
            ?.replace("'", "\\'")
            ?.replace("\n", " ")
            ?.let { "'$it'" }
            ?: "null"

        webView.post {
            webView.evaluateJavascript(
                "window.onBiometricAuthResult && window.onBiometricAuthResult($success, $escaped);",
                null,
            )
        }
    }

    @JavascriptInterface
    fun isBiometricAvailable(): Boolean = biometricHelper?.isBiometricAvailable() ?: false

    // --------------------------------------------------------------- reminders

    /**
     * Raises a notification at a given moment.
     *
     * Which reminders exist and when they are due is worked out in JavaScript; only the
     * alarm itself has to belong to the platform, because it has to fire whether or not
     * the app is running. Scheduling the same identifier again replaces the previous one.
     */
    @JavascriptInterface
    fun scheduleReminder(id: String, whenMillis: Double, title: String, body: String): Boolean {
        return try {
            val manager = mContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            manager.set(AlarmManager.RTC_WAKEUP, whenMillis.toLong(), reminderIntent(id, title, body))
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    @JavascriptInterface
    fun cancelReminder(id: String): Boolean {
        return try {
            val manager = mContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            manager.cancel(reminderIntent(id, "", ""))
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Whether the system lets this app raise a notification at an exact time. */
    @JavascriptInterface
    fun canScheduleExactAlarms(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val manager = mContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return manager.canScheduleExactAlarms()
    }

    private fun reminderIntent(id: String, title: String, body: String): PendingIntent {
        val intent = Intent(mContext, ReminderReceiver::class.java).apply {
            action = "${mContext.packageName}.REMINDER"
            putExtra(ReminderReceiver.EXTRA_ID, id)
            putExtra(ReminderReceiver.EXTRA_TITLE, title)
            putExtra(ReminderReceiver.EXTRA_BODY, body)
        }
        return PendingIntent.getBroadcast(
            mContext,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // ------------------------------------------------------------- bank alerts

    /**
     * Bank alerts caught while the app was closed.
     *
     * A broadcast receiver has no WebView to classify a message in, so it queues the text
     * and the app drains the queue on the way in. Returns a JSON array and empties the
     * queue, so nothing is classified twice.
     */
    @JavascriptInterface
    fun takePendingAlerts(): String = AlertQueue(mContext).drain()

    /**
     * The bank alerts already in the inbox. Pass days > 0 for a specific window, or 0 / -1 to scan all history.
     */
    @JavascriptInterface
    fun readSmsInbox(days: Int): String {
        if (!checkPermission("SMS")) return "[]"

        val hasLimit = days in 1..36500
        val selection = if (hasLimit) "${Telephony.Sms.DATE} >= ?" else null
        val selectionArgs = if (hasLimit) {
            val since = System.currentTimeMillis() - days.toLong() * 86_400_000L
            arrayOf(since.toString())
        } else null
        val messages = JSONArray()

        try {
            mContext.contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                selection,
                selectionArgs,
                "${Telephony.Sms.DATE} DESC",
            )?.use { cursor ->
                val addressColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val bodyColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val dateColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)

                while (cursor.moveToNext() && messages.length() < MAX_INBOX_MESSAGES) {
                    val body = cursor.getString(bodyColumn) ?: continue
                    if (!SmsReceiver.looksFinancial(body)) continue
                    messages.put(
                        JSONObject()
                            .put("sender", cursor.getString(addressColumn) ?: "")
                            .put("body", body)
                            .put("received_at", cursor.getLong(dateColumn))
                            .put("source", "inbox"),
                    )
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            return "[]"
        }
        return messages.toString()
    }

    // ------------------------------------------------------------------- files

    /**
     * Hands a file to the share sheet, which is how an encrypted export leaves the app.
     *
     * The file goes to the cache under a provider path, so the receiving app gets a
     * one-time grant rather than access to anything else.
     */
    @JavascriptInterface
    fun shareFile(name: String, mimeType: String, encoded: String): Boolean {
        return try {
            val directory = File(mContext.cacheDir, "shared").apply { mkdirs() }
            val file = File(directory, name)
            file.writeBytes(Base64.decode(encoded, Base64.DEFAULT))

            val uri = FileProvider.getUriForFile(
                mContext, "${mContext.packageName}.fileprovider", file,
            )
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // The share sheet takes the app out of sight, and the auto-lock reads this to
            // know the trip was the app's own doing rather than the user leaving.
            (mContext as? MainActivity)?.leavingForAnotherApp()
            mContext.startActivity(Intent.createChooser(intent, name).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }
}
