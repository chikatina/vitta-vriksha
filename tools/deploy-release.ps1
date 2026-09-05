<#
.SYNOPSIS
    Builds, installs, deploys and follows logs for the release version of Vitta Vriksha.

.DESCRIPTION
    1. Validates connected Android device / emulator.
    2. Runs style linter and test suite (unless -SkipTests).
    3. Builds signed release APK using Gradle.
    4. Copies APK to release/ directory.
    5. Installs release APK on the connected device.
    6. Launches the application and follows logcat.

.EXAMPLE
    .\tools\deploy-release.ps1
    .\tools\deploy-release.ps1 -SkipTests
    .\tools\deploy-release.ps1 -NoLogs
    .\tools\deploy-release.ps1 -DeviceId "192.168.1.16:46153"
#>

param (
    [string]$DeviceId = "",
    [switch]$SkipTests,
    [switch]$NoLogs
)

$ErrorActionPreference = "Stop"

$javaHomeCandidates = @(
    "D:\Program Files\Android Studio\jbr",
    "C:\Program Files\Android Studio\jbr",
    "C:\Program Files\Android\Android Studio\jbr",
    "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
)

$javaHome = $env:JAVA_HOME
if (-not $javaHome -or -not (Test-Path "$javaHome\bin\java.exe")) {
    foreach ($cand in $javaHomeCandidates) {
        if (Test-Path "$cand\bin\java.exe") {
            $javaHome = $cand
            break
        }
    }
}

$sdkCandidates = @(
    "C:\Users\sagar\AppData\Local\Android\Sdk",
    "$env:LOCALAPPDATA\Android\Sdk",
    "$env:ANDROID_HOME",
    "$env:ANDROID_SDK_ROOT"
)

$sdk = ""
foreach ($cand in $sdkCandidates) {
    if ($cand -and (Test-Path "$cand\platform-tools\adb.exe")) {
        $sdk = $cand
        break
    }
}

if ($javaHome) {
    $env:JAVA_HOME = $javaHome
    $env:PATH = "$javaHome\bin;$env:PATH"
}
if ($sdk) {
    $env:PATH = "$sdk\platform-tools;$env:PATH"
}

$adb = Get-Command adb.exe -ErrorAction SilentlyContinue
if (-not $adb) {
    Write-Error "adb.exe not found. Please connect your Android SDK platform-tools."
}

# 1. Device check & resolution
$rawDevices = & adb.exe devices
$deviceList = @($rawDevices | Where-Object { $_ -match '\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })

if ($deviceList.Count -eq 0) {
    Write-Error "No Android device or emulator connected with USB/wireless debugging enabled. Run 'adb devices' to check."
}

if (-not $DeviceId) {
    if ($deviceList.Count -eq 1) {
        $DeviceId = $deviceList[0]
    } else {
        $DeviceId = $deviceList[0]
        Write-Host "Multiple devices detected. Using first device: $DeviceId" -ForegroundColor Yellow
    }
}

function Invoke-Adb {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$AdbArgs
    )
    if ($DeviceId) {
        & adb.exe -s $DeviceId @AdbArgs
    } else {
        & adb.exe @AdbArgs
    }
}

$deviceModel = (Invoke-Adb shell getprop ro.product.model 2>$null)
if ($deviceModel) {
    $deviceModel = $deviceModel.Trim()
} else {
    $deviceModel = $DeviceId
}
Write-Host "Target Device: $DeviceId ($deviceModel)" -ForegroundColor Green

# 2. Run Style Linter and Tests
if (-not $SkipTests) {
    Write-Host "`n=== 1. Verifying Coding & Styling Guidelines (AGENTS.md) ===" -ForegroundColor Cyan
    node tools/check-style-guidelines.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Style guideline check failed! Fix deviations before deploying."
    }

    Write-Host "`n=== 2. Validating Automated Test Suite ===" -ForegroundColor Cyan
    node --test test/*.test.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tests failed! Fix tests or run with -SkipTests to bypass."
    }
}

# 3. Assemble Release APK
Write-Host "`n=== 3. Building Signed Release APK ===" -ForegroundColor Cyan
.\gradlew.bat assembleRelease
if ($LASTEXITCODE -ne 0) {
    Write-Error "Gradle release build failed."
}

$apk = "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) {
    Write-Error "Release APK not found at $apk"
}

# Parse version name from build.gradle
$gradleContent = Get-Content -Path "app\build.gradle" -Raw
$versionName = "latest"
if ($gradleContent -match 'versionName\s*=?\s*"([^"]+)"') {
    $versionName = $matches[1]
}

New-Item -ItemType Directory -Force -Path "release" | Out-Null
Copy-Item $apk -Destination "release\vittavriksha-v$versionName-release.apk" -Force

$appId = "com.chikatistudio.vittavriksha"

# 4. Install
Write-Host "`n=== 4. Installing Release APK on $DeviceId ===" -ForegroundColor Cyan
$installOutput = Invoke-Adb install -r -d $apk 2>&1 | Out-String
if ($installOutput -match "INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match") {
    Write-Host "Existing app has conflicting signature. Performing clean reinstall..." -ForegroundColor Yellow
    Invoke-Adb uninstall $appId | Out-Null
    $installOutput = Invoke-Adb install -r $apk 2>&1 | Out-String
}

if ($installOutput -notmatch "Success") {
    Write-Host $installOutput -ForegroundColor Red
    Write-Error "Failed to install release APK on device."
}
Write-Host "Installed $appId (v$versionName) successfully." -ForegroundColor Green

# 5. Launch & Follow Logs
Write-Host "`n=== 5. Launching Release App ===" -ForegroundColor Cyan
Invoke-Adb shell am start -n "$appId/com.chikatistudio.vittavriksha.MainActivity" | Out-Null
Write-Host "App launched on $deviceModel." -ForegroundColor Green

if (-not $NoLogs) {
    Write-Host "`n=== 6. Following App Logs (Ctrl+C to exit) ===" -ForegroundColor Yellow
    Start-Sleep -Milliseconds 600
    $pidStr = (Invoke-Adb shell pidof -s $appId 2>$null) | Out-String
    $cleanPid = if ($pidStr) { $pidStr.Trim() } else { "" }
    if ($cleanPid -match '^\d+$') {
        Invoke-Adb logcat --pid=$cleanPid
    } else {
        Invoke-Adb logcat -s "VittaVriksha:*" "Chromium:*" "AndroidRuntime:*" "*:E"
    }
}
