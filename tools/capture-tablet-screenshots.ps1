$ErrorActionPreference = "Stop"

$sdk = "C:\Users\sagar\AppData\Local\Android\Sdk"
$emulatorExe = Join-Path $sdk "emulator\emulator.exe"
$adbExe = Join-Path $sdk "platform-tools\adb.exe"
$avdHome = "D:\AVD"
$javaHome = "D:\Program Files\Android Studio\jbr"
$maestroBin = "D:\Software\maestro\bin"
$maestroBat = Join-Path $maestroBin "maestro.bat"

$env:ANDROID_AVD_HOME = $avdHome
$env:ANDROID_EMULATOR_HOME = $avdHome
$env:ANDROID_USER_HOME = $avdHome
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $javaHome
$env:PATH = "$maestroBin;$javaHome\bin;$sdk\platform-tools;$env:PATH"

# Ensure output directories exist
New-Item -ItemType Directory -Force -Path "screenshots\tablet_7inch" | Out-Null
New-Item -ItemType Directory -Force -Path "screenshots\tablet_10inch" | Out-Null

Write-Host "=== 1. Checking Android Emulator on $avdHome ===" -ForegroundColor Cyan
$existingDevice = (& $adbExe devices | Where-Object { $_ -match "emulator-\d+\s+device" })

if (-not $existingDevice) {
    Write-Host "Launching emulator process from D:\AVD..." -ForegroundColor Yellow
    $emuProcess = Start-Process -FilePath $emulatorExe -ArgumentList "-avd", "Pixel_8", "-no-boot-anim", "-gpu", "auto" -PassThru
    
    Write-Host "Waiting for emulator to connect to ADB..." -ForegroundColor Cyan
    & $adbExe wait-for-device
    
    $targetDevice = "emulator-5554"
    $booted = $false
    $timeout = 180
    $elapsed = 0
    while (-not $booted -and $elapsed -lt $timeout) {
        Start-Sleep -Seconds 3
        $elapsed += 3
        $state = (& $adbExe -s $targetDevice get-state 2>$null) -replace "\r|\n",""
        if ($state -eq "device") {
            $bootProp = (& $adbExe -s $targetDevice shell getprop sys.boot_completed 2>$null) -replace "\r|\n",""
            if ($bootProp -eq "1") {
                $booted = $true
                break
            }
        }
        Write-Host "  Booting emulator... ($elapsed s)"
    }
    Write-Host "Emulator booted and ready!" -ForegroundColor Green
} else {
    Write-Host "Emulator is already online!" -ForegroundColor Green
}

Start-Sleep -Seconds 3

Write-Host "`n=== 2. Building & Installing Vitta Vriksha ===" -ForegroundColor Cyan
$gradlew = ".\gradlew.bat"
& $gradlew assembleDebug

$apk = Get-ChildItem -Path "app\build\outputs\apk\debug\*.apk" | Select-Object -First 1 -ExpandProperty FullName
Write-Host "Installing APK: $apk..." -ForegroundColor Cyan
& $adbExe -s emulator-5554 install -r -d $apk

# =========================================================================
# 3. 7-INCH TABLET SCREENSHOTS (16:9 Aspect Ratio)
# Standard 7" tablet resolution: 1080x1920 @ 320 dpi (or 1200x1920)
# =========================================================================
Write-Host "`n=== 3. Configuring 7-inch Tablet Screen (1080x1920 @ 320 dpi, 16:9) ===" -ForegroundColor Cyan
& $adbExe -s emulator-5554 shell wm size 1080x1920
& $adbExe -s emulator-5554 shell wm density 320
Start-Sleep -Seconds 2

& $adbExe -s emulator-5554 shell am start -n com.chikatistudio.vittavriksha.debug/com.chikatistudio.vittavriksha.MainActivity
Start-Sleep -Seconds 3

Write-Host "Running Maestro Flow for 7-inch Tablet..." -ForegroundColor Yellow
& $maestroBat test .maestro/07_store_screenshots_tablet7.yaml

# Sync 7-inch screenshots
$testsDir = Join-Path $HOME ".maestro\tests"
if (Test-Path $testsDir) {
    $latestRun = Get-ChildItem -Path $testsDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestRun) {
        $shots = Get-ChildItem -Path $latestRun.FullName -Filter "*.png" -Recurse
        foreach ($shot in $shots) {
            Copy-Item -Path $shot.FullName -Destination "screenshots\tablet_7inch\" -Force
        }
    }
}

# =========================================================================
# 4. 10-INCH TABLET SCREENSHOTS (16:9 Aspect Ratio)
# Standard 10" tablet resolution: 1440x2560 @ 280 dpi (16:9)
# =========================================================================
Write-Host "`n=== 4. Configuring 10-inch Tablet Screen (1440x2560 @ 280 dpi, 16:9) ===" -ForegroundColor Cyan
& $adbExe -s emulator-5554 shell wm size 1440x2560
& $adbExe -s emulator-5554 shell wm density 280
Start-Sleep -Seconds 2

& $adbExe -s emulator-5554 shell am start -n com.chikatistudio.vittavriksha.debug/com.chikatistudio.vittavriksha.MainActivity
Start-Sleep -Seconds 3

Write-Host "Running Maestro Flow for 10-inch Tablet..." -ForegroundColor Yellow
& $maestroBat test .maestro/07_store_screenshots_tablet10.yaml

# Sync 10-inch screenshots
if (Test-Path $testsDir) {
    $latestRun = Get-ChildItem -Path $testsDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestRun) {
        $shots = Get-ChildItem -Path $latestRun.FullName -Filter "*.png" -Recurse
        foreach ($shot in $shots) {
            Copy-Item -Path $shot.FullName -Destination "screenshots\tablet_10inch\" -Force
        }
    }
}

# =========================================================================
# 5. RESET EMULATOR DISPLAY TO DEFAULT
# =========================================================================
Write-Host "`n=== 5. Resetting Emulator Display to Default ===" -ForegroundColor Cyan
& $adbExe -s emulator-5554 shell wm size reset
& $adbExe -s emulator-5554 shell wm density reset
Start-Sleep -Seconds 2

Write-Host "`n=== 6. Captured Screenshots Summary ===" -ForegroundColor Green
Write-Host "--- 7-inch Tablet Screenshots ---" -ForegroundColor Cyan
Get-ChildItem -Path "screenshots\tablet_7inch" -Filter "*.png" | Select-Object Name, Length, LastWriteTime
Write-Host "`n--- 10-inch Tablet Screenshots ---" -ForegroundColor Cyan
Get-ChildItem -Path "screenshots\tablet_10inch" -Filter "*.png" | Select-Object Name, Length, LastWriteTime

Write-Host "`nTablet screenshot generation completed successfully!" -ForegroundColor Green
