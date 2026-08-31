# ==============================================================================
# Fast Manual LDPlayer 9 Automated Test Script
# ==============================================================================
$ErrorActionPreference = "Continue"

Write-Host "=== [1/4] Installing Android Platform-Tools (ADB) ===" -ForegroundColor Cyan
$adbZip = "$env:TEMP\platform-tools.zip"
if (-not (Test-Path "C:\platform-tools\adb.exe")) {
    Write-Host "Downloading Google Platform-Tools..." -ForegroundColor Yellow
    & curl.exe -# -fSL -o $adbZip "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
    Expand-Archive -Path $adbZip -DestinationPath "C:\" -Force
}
Write-Host "[+] ADB ready at C:\platform-tools\adb.exe" -ForegroundColor Green
$env:PATH += ";C:\platform-tools"
& C:\platform-tools\adb.exe version

Write-Host "`n=== [2/4] Downloading LDPlayer 9 ===" -ForegroundColor Cyan
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

Write-Host "`n=== [3/4] Extracting Virtual Disk Payload & Spawning Setup ===" -ForegroundColor Cyan
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

Write-Host "`n=== [4/4] Polling ADB Device Connection (127.0.0.1:5555) ===" -ForegroundColor Cyan
& C:\platform-tools\adb.exe start-server
$connected = $false
for ($i = 1; $i -le 12; $i++) {
    & C:\platform-tools\adb.exe connect 127.0.0.1:5555 | Out-Null
    $devices = & C:\platform-tools\adb.exe devices
    Write-Host "Poll [$i/12] Device status: $($devices -join ' ')"
    if ($devices -match "127\.0\.0\.1:5555\s+device") {
        $connected = $true
        Write-Host "`n========================================================" -ForegroundColor Green
        Write-Host "[+] SUCCESS: LDPlayer Android is ONLINE and CONNECTED!" -ForegroundColor Green
        $model = & C:\platform-tools\adb.exe -s 127.0.0.1:5555 shell getprop ro.product.model
        $androidVer = & C:\platform-tools\adb.exe -s 127.0.0.1:5555 shell getprop ro.build.version.release
        Write-Host "    Device Model: $model" -ForegroundColor Green
        Write-Host "    Android OS: Android $androidVer" -ForegroundColor Green
        Write-Host "========================================================`n" -ForegroundColor Green
        break
    }
    Start-Sleep -Seconds 5
}
