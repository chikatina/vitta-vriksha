# Chaquopy runtime is reached reflectively from native code.
-keep class com.chaquo.python.** { *; }
-dontwarn com.chaquo.python.**

# WebAppInterface methods are called from JavaScript by name.
-keepclassmembers class com.chikatistudio.vittavriksha.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Services and receivers declared in the manifest.
-keep class com.chikatistudio.vittavriksha.SmsReceiver { *; }
-keep class com.chikatistudio.vittavriksha.TransactionNotificationListener { *; }

# Keep line numbers for readable crash reports, hide the source file name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
