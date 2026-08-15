param(
    [string]$Flow = ".maestro/07_store_screenshots.yaml"
)

$ErrorActionPreference = "Stop"

$sdk = "C:\Users\sagar\AppData\Local\Android\Sdk"
$emulatorExe = Join-Path $sdk "emulator\emulator.exe"
$adbExe = Join-Path $sdk "platform-tools\adb.exe"
$avdHome = "D:\AVD"
$javaHome = "D:\Program Files\Android Studio\jbr"
$maestroBin = "D:\Software\maestro\bin"

$env:ANDROID_AVD_HOME = $avdHome
$env:ANDROID_EMULATOR_HOME = $avdHome
$env:ANDROID_USER_HOME = $avdHome
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $javaHome
$env:PATH = "$maestroBin;$javaHome\bin;$sdk\platform-tools;$env:PATH"

Write-Host "=== 1. Starting Pixel 8 Emulator from $avdHome ===" -ForegroundColor Cyan
$existingDevice = (& $adbExe devices | Where-Object { $_ -match "emulator-\d+\s+device" })

if (-not $existingDevice) {
    Write-Host "Launching emulator process from D:\AVD..." -ForegroundColor Yellow
    $emuProcess = Start-Process -FilePath $emulatorExe -ArgumentList "-avd", "Pixel_8", "-no-boot-anim", "-gpu", "auto" -PassThru
    
    Write-Host "Waiting for emulator to connect to ADB..." -ForegroundColor Cyan
    & $adbExe wait-for-device
    
    $targetDevice = "emulator-5554"
    Write-Host "Target device: $targetDevice" -ForegroundColor Cyan
    
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
        Write-Host "  Booting Pixel 8... ($elapsed s)"
    }
    
    if (-not $booted) {
        Write-Error "Pixel 8 emulator boot timed out."
        exit 1
    }
    Write-Host "Pixel 8 booted and ready!" -ForegroundColor Green
} else {
    Write-Host "Emulator is already online!" -ForegroundColor Green
}

# Give system 5 seconds to settle
Start-Sleep -Seconds 5

Write-Host "`n=== 2. Building & Installing Vitta Vriksha ===" -ForegroundColor Cyan
$gradlew = ".\gradlew.bat"
& $gradlew assembleDebug

$apk = Get-ChildItem -Path "app\build\outputs\apk\debug\*.apk" | Select-Object -First 1 -ExpandProperty FullName
if (-not $apk -or -not (Test-Path $apk)) {
    Write-Error "Debug APK not found."
    exit 1
}

Write-Host "Installing APK: $apk..." -ForegroundColor Cyan
& $adbExe -s emulator-5554 install -r -d $apk

Write-Host "Launching App Activity..." -ForegroundColor Cyan
& $adbExe -s emulator-5554 shell am start -n com.chikatistudio.vittavriksha.debug/com.chikatistudio.vittavriksha.MainActivity
Start-Sleep -Seconds 3

Write-Host "`n=== 3. Running Maestro Flow ($Flow) ===" -ForegroundColor Cyan
$maestroBat = Join-Path $maestroBin "maestro.bat"
& $maestroBat test $Flow

Write-Host "`n=== 4. Syncing Captured Screenshots ===" -ForegroundColor Cyan
$testsDir = Join-Path $HOME ".maestro\tests"
if (Test-Path $testsDir) {
    $latestRun = Get-ChildItem -Path $testsDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestRun) {
        $shots = Get-ChildItem -Path $latestRun.FullName -Filter "*.png" -Recurse
        foreach ($shot in $shots) {
            Copy-Item -Path $shot.FullName -Destination "screenshots\" -Force
        }
    }
}

Write-Host "`n=== 5. Captured Screenshots in d:\Projects\moneytree\screenshots\ ===" -ForegroundColor Green
Get-ChildItem -Path "screenshots" -Filter "*.png" | Select-Object Name, Length, LastWriteTime

Write-Host "`nAll steps completed successfully!" -ForegroundColor Green
