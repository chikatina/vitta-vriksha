$ErrorActionPreference = "Stop"

$avdRoot = "D:\AVD"
$avdFolder = "D:\AVD\Pixel_8.avd"

if (-not (Test-Path $avdRoot)) {
    New-Item -ItemType Directory -Path $avdRoot -Force | Out-Null
}
if (-not (Test-Path $avdFolder)) {
    New-Item -ItemType Directory -Path $avdFolder -Force | Out-Null
}

# 1. Set environment variables permanently in User scope
Write-Host "Setting ANDROID_AVD_HOME, ANDROID_EMULATOR_HOME, ANDROID_USER_HOME to $avdRoot..." -ForegroundColor Cyan
[Environment]::SetEnvironmentVariable("ANDROID_AVD_HOME", $avdRoot, "User")
[Environment]::SetEnvironmentVariable("ANDROID_EMULATOR_HOME", $avdRoot, "User")
[Environment]::SetEnvironmentVariable("ANDROID_USER_HOME", $avdRoot, "User")

$env:ANDROID_AVD_HOME = $avdRoot
$env:ANDROID_EMULATOR_HOME = $avdRoot
$env:ANDROID_USER_HOME = $avdRoot

# 2. Write Pixel_8.ini
$iniContent = @"
avd.ini.encoding=UTF-8
path=D:\AVD\Pixel_8.avd
path.rel=Pixel_8.avd
target=android-37.1
"@
Set-Content -Path "D:\AVD\Pixel_8.ini" -Value $iniContent -Encoding UTF8

# 3. Write Pixel_8.avd\config.ini
$configContent = @"
PlayStore.enabled=true
abi.type=x86_64
avd.ini.displayname=Pixel 8
avd.ini.encoding=UTF-8
disk.dataPartition.size=6442450944
hw.accelerometer=yes
hw.audioInput=yes
hw.battery=yes
hw.camera.back=virtualscene
hw.camera.front=emulated
hw.cpu.arch=x86_64
hw.cpu.ncore=4
hw.dPad=no
hw.device.manufacturer=Google
hw.device.name=pixel_8
hw.gps=yes
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.initialOrientation=Portrait
hw.keyboard=yes
hw.lcd.density=420
hw.lcd.height=2400
hw.lcd.width=1080
hw.mainKeys=no
hw.ramSize=4096
hw.sdCard=yes
hw.sensors.orientation=yes
hw.sensors.proximity=yes
hw.trackBall=no
image.sysdir.1=system-images\android-37.1\google_apis_playstore_ps16k\x86_64\
runtime.network.latency=none
runtime.network.speed=full
sdcard.size=2048M
showDeviceFrame=yes
skin.dynamic=yes
skin.name=pixel_8
skin.path=C:\Users\sagar\AppData\Local\Android\Sdk\skins\pixel_8
tag.display=Google Play
tag.id=google_apis_playstore,page_size_16kb
vm.heapSize=512
"@
Set-Content -Path "D:\AVD\Pixel_8.avd\config.ini" -Value $configContent -Encoding UTF8

Write-Host "AVD configuration files written successfully." -ForegroundColor Green

# 4. Verify emulator lists the new AVD
$emulator = "C:\Users\sagar\AppData\Local\Android\Sdk\emulator\emulator.exe"
Write-Host "Checking emulator list-avds..." -ForegroundColor Cyan
& $emulator -list-avds
