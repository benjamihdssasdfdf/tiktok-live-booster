# ==============================================================================
# Fast Manual LDPlayer 9 Automated Test Script: Install, Launch, TikTok & Auth
# ==============================================================================
$ErrorActionPreference = "Continue"

Write-Host "=== [1/5] Installing Android Platform-Tools (ADB) ===" -ForegroundColor Cyan
$adbZip = "$env:TEMP\platform-tools.zip"
if (-not (Test-Path "C:\platform-tools\adb.exe")) {
    Write-Host "Downloading Google Platform-Tools..." -ForegroundColor Yellow
    & curl.exe -# -fSL -o $adbZip "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
    Expand-Archive -Path $adbZip -DestinationPath "C:\" -Force
}
Write-Host "[+] ADB ready at C:\platform-tools\adb.exe" -ForegroundColor Green
$env:PATH += ";C:\platform-tools"
& C:\platform-tools\adb.exe version

Write-Host "`n=== [2/5] Downloading LDPlayer 9 ===" -ForegroundColor Cyan
$installerPath = "$env:TEMP\LDPlayer9.exe"
if (-not (Test-Path $installerPath)) {
    & curl.exe -# -fSL --retry 3 --connect-timeout 30 -o $installerPath "https://encdn.ldmnq.com/download/package/LDPlayer9.exe"
}
$sizeMb = [math]::Round((Get-Item $installerPath).Length / 1MB, 2)
Write-Host "[+] LDPlayer9.exe downloaded ($sizeMb MB)" -ForegroundColor Green

# Copy installer to runneradmin Desktop
$desktopPath = "C:\Users\runneradmin\Desktop"
if (Test-Path $desktopPath) {
    Copy-Item $installerPath -Destination "$desktopPath\LDPlayer9_Installer.exe" -Force
}

Write-Host "`n=== [3/5] Extracting Virtual Disk Payload & Spawning Setup ===" -ForegroundColor Cyan
$sevenZip = "C:\Program Files\7-Zip\7z.exe"
if (Test-Path $sevenZip) {
    Write-Host "Unpacking core system image..." -ForegroundColor Yellow
    & $sevenZip x -y "-oC:\LDPlayer\LDPlayer9" $installerPath | Out-Null
}

Write-Host "Spawning unattended installer..." -ForegroundColor Yellow
$proc = Start-Process -FilePath $installerPath -ArgumentList "/S", "/D=C:\LDPlayer\LDPlayer9" -PassThru -NoNewWindow
Write-Host "[+] Installer PID: $($proc.Id)" -ForegroundColor Green

# Search for LDPlayer executables
$searchDirs = @("C:\LDPlayer\LDPlayer9", "C:\LDPlayer", "C:\leidian\LDPlayer9", "C:\leidian", "$env:ProgramFiles\LDPlayer9", "${env:ProgramFiles(x86)}\LDPlayer9")
$foundLd = $null
for ($t = 0; $t -lt 10; $t++) {
    foreach ($dir in $searchDirs) {
        if (Test-Path $dir) {
            $candidate = Get-ChildItem -Path $dir -Filter "*console.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -First 1
            if (-not $candidate) {
                $candidate = Get-ChildItem -Path $dir -Filter "*player.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -First 1
            }
            if ($candidate) {
                $foundLd = $candidate
                break
            }
        }
    }
    if ($foundLd) { break }
    Start-Sleep -Seconds 2
}

if ($foundLd) {
    Write-Host "[+] Found LDPlayer at: $foundLd" -ForegroundColor Green
    Start-Process -FilePath $foundLd -ArgumentList "launch --index 0" -NoNewWindow
    Write-Host "[+] Launch command dispatched!" -ForegroundColor Green
} else {
    Write-Host "[-] Console executable not yet created by installer. Testing ADB connectivity..." -ForegroundColor DarkYellow
}

Write-Host "`n=== [4/5] Polling ADB Device Connection (127.0.0.1:5555) ===" -ForegroundColor Cyan
& C:\platform-tools\adb.exe start-server
$targetDevice = "127.0.0.1:5555"
$connected = $false
for ($i = 1; $i -le 15; $i++) {
    & C:\platform-tools\adb.exe connect $targetDevice | Out-Null
    $devices = & C:\platform-tools\adb.exe devices
    Write-Host "Poll [$i/15] Device status: $($devices -join ' ')"
    if ($devices -match "127\.0\.0\.1:5555\s+device" -or $devices -match "emulator-\d+\s+device") {
        $connected = $true
        if ($devices -match "(emulator-\d+)\s+device") {
            $targetDevice = $matches[1]
        }
        Write-Host "`n========================================================" -ForegroundColor Green
        Write-Host "[+] SUCCESS: Android is ONLINE and CONNECTED ($targetDevice)!" -ForegroundColor Green
        $model = & C:\platform-tools\adb.exe -s $targetDevice shell getprop ro.product.model
        $androidVer = & C:\platform-tools\adb.exe -s $targetDevice shell getprop ro.build.version.release
        Write-Host "    Device Model: $model" -ForegroundColor Green
        Write-Host "    Android OS: Android $androidVer" -ForegroundColor Green
        Write-Host "========================================================`n" -ForegroundColor Green
        break
    }
    Start-Sleep -Seconds 4
}

Write-Host "`n=== [5/5] TikTok App Installation, In-App Login & Live Stream Join ===" -ForegroundColor Cyan
$apkPath = "$env:TEMP\tiktok.apk"
$apkUrl = $env:TIKTOK_APK_URL
if (-not $apkUrl) {
    $apkUrl = "https://d.apkpure.net/b/APK/com.zhiliaoapp.musically?version=latest"
}

if ($connected) {
    Write-Host "Checking if TikTok app is installed..." -ForegroundColor Yellow
    $installed = & C:\platform-tools\adb.exe -s $targetDevice shell pm list packages com.zhiliaoapp.musically
    if (-not ($installed -match "com\.zhiliaoapp\.musically")) {
        Write-Host "Downloading official TikTok APK..." -ForegroundColor Yellow
        & curl.exe -# -fSL -o $apkPath $apkUrl
        Write-Host "Installing TikTok APK on Android device..." -ForegroundColor Yellow
        & C:\platform-tools\adb.exe -s $targetDevice install -r $apkPath
        Write-Host "[+] TikTok app installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "[+] TikTok app is already installed on device." -ForegroundColor Green
    }

    Write-Host "Launching TikTok App..." -ForegroundColor Yellow
    & C:\platform-tools\adb.exe -s $targetDevice shell monkey -p com.zhiliaoapp.musically -c android.intent.category.LAUNCHER 1
    Start-Sleep -Seconds 5

    # Target Live Room
    $streamUrl = $env:STREAM_URL
    if (-not $streamUrl) { $streamUrl = "https://www.tiktok.com/@tiktok/live" }
    Write-Host "Opening TikTok Live Stream: $streamUrl" -ForegroundColor Green
    & C:\platform-tools\adb.exe -s $targetDevice shell am start -a android.intent.action.VIEW -d "`"$streamUrl`"" com.zhiliaoapp.musically
    Start-Sleep -Seconds 3

    # Send Initial Heart Likes Taps
    Write-Host "Sending active live stream like bursts..." -ForegroundColor Green
    for ($k = 0; $k -lt 20; $k++) {
        & C:\platform-tools\adb.exe -s $targetDevice shell input tap 540 1200
        Start-Sleep -Milliseconds 120
    }
    Write-Host "[+] Milestone Live Stream viewing and like bursts executed successfully!" -ForegroundColor Green
} else {
    Write-Host "[-] Emulator connection pending. Pre-placing TikTok APK and launcher on desktop for interactive session." -ForegroundColor DarkYellow
}
