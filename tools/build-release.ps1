$ErrorActionPreference = "Stop"

$javaHome = "D:\Program Files\Android Studio\jbr"
$sdk = "C:\Users\sagar\AppData\Local\Android\Sdk"

$env:JAVA_HOME = $javaHome
$env:PATH = "$javaHome\bin;$sdk\platform-tools;$env:PATH"

Write-Host "=== 1. Validating Node Tests ===" -ForegroundColor Cyan
node --test tests/run-all.mjs

Write-Host "`n=== 2. Building Release App Bundle (.aab) & Release APK (.apk) ===" -ForegroundColor Cyan
.\gradlew.bat bundleRelease assembleRelease

# Parse version name from build.gradle
$gradleContent = Get-Content -Path "app\build.gradle" -Raw
$versionName = "latest"
if ($gradleContent -match 'versionName\s+"([^"]+)"') {
    $versionName = $matches[1]
}

Write-Host "`n=== 3. Copying & Outputting Release Files (v$versionName) ===" -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "release" | Out-Null
Copy-Item "app\build\outputs\bundle\release\app-release.aab" -Destination "release\vittavriksha-v$versionName-release.aab" -Force
Copy-Item "app\build\outputs\apk\release\app-release.apk" -Destination "release\vittavriksha-v$versionName-release.apk" -Force

Get-ChildItem -Path "release\vittavriksha-v$versionName-*" | Select-Object Name, Length, LastWriteTime
