param(
    [string]$Flow = ".maestro/run_all_tests.yaml",
    [switch]$SkipBuild = $false
)

$ErrorActionPreference = "Stop"

$sdk = "C:\Users\sagar\AppData\Local\Android\Sdk"
$adbExe = Join-Path $sdk "platform-tools\adb.exe"
$javaHome = "D:\Program Files\Android Studio\jbr"
$maestroBin = "D:\Software\maestro\bin"
$maestroBat = Join-Path $maestroBin "maestro.bat"

$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $javaHome
$env:PATH = "$maestroBin;$javaHome\bin;$sdk\platform-tools;$env:PATH"

# Ensure device is connected
Write-Host "=== 1. Checking Connected Android Device / Emulator ===" -ForegroundColor Cyan
$devices = & $adbExe devices | Where-Object { $_ -match "\b(device)\b" -and $_ -notmatch "List of" }
if (-not $devices) {
    Write-Error "No connected Android device or emulator found. Please start an emulator or connect a device with USB debugging enabled."
    exit 1
}
Write-Host "Found device(s):" -ForegroundColor Green
$devices | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }

# Target package
$debugAppId = "com.chikatistudio.vittavriksha.debug"
$mainActivity = "com.chikatistudio.vittavriksha.MainActivity"

if (-not $SkipBuild) {
    Write-Host "`n=== 2. Building Debug APK for E2E Testing (assembleDebug) ===" -ForegroundColor Cyan
    & .\gradlew.bat assembleDebug

    $apk = Get-ChildItem -Path "app\build\outputs\apk\debug\*.apk" | Select-Object -First 1 -ExpandProperty FullName
    if (-not $apk -or -not (Test-Path $apk)) {
        Write-Error "Debug APK build failed or APK not found."
        exit 1
    }

    Write-Host "Installing Debug APK: $apk..." -ForegroundColor Cyan
    & $adbExe install -r -d $apk
} else {
    Write-Host "`nSkipping build step (-SkipBuild specified)..." -ForegroundColor Yellow
}

Write-Host "`n=== 3. Launching Debug App ($debugAppId) ===" -ForegroundColor Cyan
& $adbExe shell am force-stop $debugAppId
& $adbExe shell am start -n "$debugAppId/$mainActivity"
Start-Sleep -Seconds 2

Write-Host "`n=== 4. Executing Maestro E2E Flow ($Flow) ===" -ForegroundColor Cyan
if (Test-Path $maestroBat) {
    & $maestroBat test $Flow
} elseif (Get-Command "maestro" -ErrorAction SilentlyContinue) {
    maestro test $Flow
} else {
    Write-Error "Maestro executable not found at $maestroBat or in PATH."
    exit 1
}

Write-Host "`n=== 5. Syncing Test Artifacts ===" -ForegroundColor Cyan
$testsDir = Join-Path $HOME ".maestro\tests"
if (Test-Path $testsDir) {
    $latestRun = Get-ChildItem -Path $testsDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestRun) {
        $shots = Get-ChildItem -Path $latestRun.FullName -Filter "*.png" -Recurse
        if ($shots) {
            New-Item -ItemType Directory -Force -Path "screenshots\" | Out-Null
            foreach ($shot in $shots) {
                Copy-Item -Path $shot.FullName -Destination "screenshots\" -Force
            }
            Write-Host "Synced $($shots.Count) screenshot(s) to screenshots\" -ForegroundColor Green
        }
    }
}

Write-Host "`nE2E testing finished successfully on Debug build!" -ForegroundColor Green
