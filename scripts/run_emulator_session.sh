#!/usr/bin/env bash
# ==============================================================================
# TikTok Booster - Android 14 / API 34 Emulator Session & Scrcpy Runner
# ==============================================================================
set -e

echo "=== [1/4] Android 14 Boot & Version Verification ==="
adb devices
SDK_VER=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
REL_VER=$(adb shell getprop ro.build.version.release | tr -d '\r')
BOOT_DONE=$(adb shell getprop sys.boot_completed | tr -d '\r')
WM_SIZE=$(adb shell wm size | tr -d '\r')
WM_DENSITY=$(adb shell wm density | tr -d '\r')

echo "=================================================="
echo "SDK Version:      $SDK_VER"
echo "Android Release:  $REL_VER"
echo "Boot Completed:   $BOOT_DONE"
echo "Display Size:     $WM_SIZE"
echo "Display Density:  $WM_DENSITY"
echo "=================================================="

if [ "$SDK_VER" != "34" ]; then
    echo "[ERROR] Expected Android 14 (API 34) but got SDK $SDK_VER!"
    exit 1
fi
echo "[PASS] Android 14 (API 34) verified successfully!"

# 2. Fast Tap script
echo "=== [2/4] Setting Up Fast Tap Acceleration Script ==="
chmod +x ./scripts/fast_tap.sh
adb push ./scripts/fast_tap.sh /data/local/tmp/fast_tap.sh
adb shell chmod +x /data/local/tmp/fast_tap.sh
echo "[PASS] fast_tap.sh installed on device."

# 3. Setup & Launch Official Scrcpy v2.4 Server
echo "=== [3/4] Setting Up Official Scrcpy v2.4 Server ==="
chmod +x ./scripts/setup_scrcpy.sh
./scripts/setup_scrcpy.sh
echo "[PASS] scrcpy-server v2.4 launched on port 27183."

# 4. Run TikTok Booster Python Orchestrator
echo "=== [4/4] Starting TikTok Booster Orchestrator ==="
RUNNER_INDEX="${RUNNER_INDEX:-0}"
STREAM_URL="${STREAM_URL:-https://www.tiktok.com/@tiktok/live}"
DURATION_MIN="${DURATION_MIN:-60}"
LIKES_RATE="${LIKES_RATE:-120}"

python -m src.main \
  --stream-url "$STREAM_URL" \
  --duration "$DURATION_MIN" \
  --likes-per-min "$LIKES_RATE" \
  --runner-index "$RUNNER_INDEX"
