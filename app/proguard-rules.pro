# WebAppInterface methods are called from JavaScript by name.
-keepclassmembers class com.chikatistudio.vittavriksha.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Services, receivers and activities declared in the manifest.
-keep class com.chikatistudio.vittavriksha.MainActivity { *; }
-keep class com.chikatistudio.vittavriksha.SmsReceiver { *; }
-keep class com.chikatistudio.vittavriksha.ReminderReceiver { *; }
-keep class com.chikatistudio.vittavriksha.TransactionNotificationListener { *; }

# Keep line numbers for readable crash reports, hide the source file name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
