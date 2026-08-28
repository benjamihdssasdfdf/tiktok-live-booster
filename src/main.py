import sys
import os
import time
import signal
import logging
import uuid
import requests
from datetime import datetime
from rich.console import Console
from rich.logging import RichHandler

from src.config import config
from src.models import RunnerState, RunnerRegistration, RunnerHeartbeat
from src.sheet_service import GoogleSheetService
from src.adb_controller import ADBController
from src.vpn_service import VPNService
from src.drive_service import GoogleDriveService
from src.auto_login import AutoLoginManager
from src.stream_forwarder import ScrcpyStreamForwarder

console = Console()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[RichHandler(console=console, rich_tracebacks=True)]
)
logger = logging.getLogger("TikTokBoosterRunner")

class TikTokBoosterOrchestrator:
    """Master TikTok Booster orchestrator with deterministic State Machine & PostgreSQL Synchronization."""

    def __init__(self):
        self.config = config
        self.runner_key = f"{os.getenv('GITHUB_REPOSITORY', 'tiktok-live-booster').split('/')[-1]}_runner_{self.config.runner_index}"
        self.session_uuid = self.config.session_uuid or f"session_{uuid.uuid4().hex[:12]}"
        self.current_state = RunnerState.INITIALIZING
        self.previous_state = None
        self.is_running = True
        self.total_likes_sent = 0
        self.start_time = time.time()
        self.last_heartbeat_time = 0

        self.sheet_service = GoogleSheetService(self.config)
        self.adb = ADBController(self.config)
        self.vpn = VPNService(self.config)
        self.drive = GoogleDriveService(self.config)
        self.auto_login = AutoLoginManager(self.config, self.adb, self.drive, self.sheet_service)
        self.stream_forwarder = ScrcpyStreamForwarder(self.config.backend_url, self.runner_key)

        signal.signal(signal.SIGINT, self._handle_exit)
        signal.signal(signal.SIGTERM, self._handle_exit)

    def _handle_exit(self, signum, frame):
        logger.warning("Shutdown signal received. Exiting gracefully...")
        self.is_running = False
        self.transition_state(RunnerState.STOPPING)
        self.stream_forwarder.stop()
        self.send_heartbeat()
        self._notify_stop()

    def transition_state(self, new_state: RunnerState):
        """Logs deterministic state transition and immediately transmits high-speed telemetry update to backend."""
        if self.current_state != new_state:
            self.previous_state = self.current_state
            self.current_state = new_state
            ts = datetime.utcnow().isoformat() + "Z"
            logger.info(f"[STATE_TRANSITION] runner={self.runner_key} session={self.session_uuid} previous={self.previous_state.value} new={self.current_state.value} timestamp={ts}")
            
            # Immediately notify central backend (fast sub-50ms transmission without taking heavy screenshot)
            try:
                self.send_heartbeat(include_screenshot=False)
            except Exception as e:
                logger.debug(f"Immediate state transition heartbeat notice: {e}")

    def register_runner(self) -> bool:
        """Registers this cloud Android worker in the central PostgreSQL database."""
        url = f"{self.config.backend_url}/api/runners/register"
        payload = {
            "runner_key": self.runner_key,
            "cluster_repo": os.getenv("GITHUB_REPOSITORY", "kashifjutt7456-art/tiktok-live-booster"),
            "runner_index": self.config.runner_index,
            "session_uuid": self.session_uuid,
            "android_version": self.adb.android_version,
            "sdk_level": self.adb.sdk_level,
            "display_width": self.adb.screen_width,
            "display_height": self.adb.screen_height,
            "display_density": self.adb.screen_density,
            "target_stream_url": self.config.stream_url,
            "workflow_run_id": int(os.getenv("GITHUB_RUN_ID", 0)) or None
        }

        try:
            logger.info(f"Registering runner in PostgreSQL via {url} ...")
            res = requests.post(url, json=payload, timeout=8)
            if res.status_code == 200:
                logger.info(f"[+] Runner {self.runner_key} registered successfully in PostgreSQL!")
                return True
            else:
                logger.warning(f"Registration response {res.status_code}: {res.text}")
        except Exception as e:
            logger.debug(f"Registration fallback note: {e}")
        return False

    def send_heartbeat(self, include_screenshot=False) -> list:
        """Transmits state heartbeat to PostgreSQL and retrieves pending control commands."""
        url = f"{self.config.backend_url}/api/telemetry/heartbeat"
        screenshot_b64 = None
        if include_screenshot:
            screenshot_b64 = self.adb.capture_screen_base64()

        foreground_act = self.adb.get_foreground_activity()
        elapsed = int(time.time() - self.start_time)

        payload = {
            "runner_id": self.config.runner_index,
            "runner_key": self.runner_key,
            "session_uuid": self.session_uuid,
            "repo": os.getenv("GITHUB_REPOSITORY", "kashifjutt7456-art/tiktok-live-booster"),
            "account": "Active Live Session",
            "status": self.current_state.value,
            "state": self.current_state.value,
            "likes_sent": self.total_likes_sent,
            "elapsed_seconds": elapsed,
            "screenshot_b64": screenshot_b64,
            "foreground_activity": foreground_act,
            "package_name": self.adb.package_name,
            "adb_state": "OK" if self.adb.device_id else "DISCONNECTED",
            "app_state": "RUNNING" if self.adb._is_tiktok_in_foreground() else "BACKGROUND",
            "screen_state": self.stream_forwarder.stream_state,
            "control_state": "CONNECTED" if self.stream_forwarder.control_socket else "POLLING",
            "log_snippet": f"{self.runner_key} | {self.current_state.value} | Stream: {self.stream_forwarder.stream_state} | Likes: {self.total_likes_sent}",
            "device_timestamp": datetime.utcnow().isoformat() + "Z"
        }

        try:
            res = requests.post(url, json=payload, timeout=6)
            if res.status_code == 200:
                data = res.json()
                commands = data.get("commands", [])
                self._execute_commands(commands)
                return commands
        except Exception as e:
            logger.debug(f"Heartbeat network notice: {e}")
        return []

    def _execute_commands(self, commands: list):
        """Executes remote control commands received from the dashboard and sends acknowledgements."""
        if not commands:
            return

        self.adb.user_override_until = time.time() + 25

        for cmd in commands:
            cmd_id = cmd.get("id")
            action = cmd.get("action", "tap")
            logger.info(f"COMMAND_RECEIVED: ID={cmd_id} Action={action}")

            success = False
            err_msg = None

            try:
                if action in ["touch", "tap"]:
                    x = int(cmd.get("x", self.adb.screen_width // 2))
                    y = int(cmd.get("y", self.adb.screen_height // 2))
                    logger.info(f"Executing touch tap at ({x}, {y})")
                    self.adb.shell(f"input tap {x} {y}")
                    success = True
                elif action == "swipe":
                    x1 = int(cmd.get("x1", self.adb.screen_width // 2))
                    y1 = int(cmd.get("y1", int(self.adb.screen_height * 0.75)))
                    x2 = int(cmd.get("x2", self.adb.screen_width // 2))
                    y2 = int(cmd.get("y2", int(self.adb.screen_height * 0.25)))
                    logger.info(f"Executing swipe ({x1}, {y1}) -> ({x2}, {y2})")
                    self.adb.shell(f"input swipe {x1} {y1} {x2} {y2} 250")
                    success = True
                elif action == "key":
                    keycode = int(cmd.get("keycode", 4))
                    logger.info(f"Executing keyevent {keycode}")
                    self.adb.shell(f"input keyevent {keycode}")
                    success = True
                elif action == "text" and cmd.get("text"):
                    text_val = cmd.get("text").replace(" ", "%s")
                    self.adb.shell(f"input text {text_val}")
                    success = True
                elif action == "burst":
                    self.adb.send_batch_likes(tap_count=50, delay_ms=80)
                    success = True
                elif action in ["reload", "restart_app"]:
                    self.adb.shell(f"am force-stop {self.adb.package_name}")
                    time.sleep(1)
                    self.adb.launch_live_stream(self.config.stream_url, self.config.room_id, self.config.stream_user)
                    success = True
            except Exception as ex:
                err_msg = str(ex)
                logger.error(f"COMMAND_FAILED: {err_msg}")

            # Send Command Ack to PostgreSQL
            self._ack_command(cmd_id, "EXECUTED" if success else "FAILED", err_msg)

    def _ack_command(self, cmd_id, status, error_message=None):
        if not cmd_id:
            return
        try:
            url = f"{self.config.backend_url}/api/runners/{self.config.runner_index}/command-ack"
            requests.post(url, json={"command_id": cmd_id, "status": status, "error_message": error_message}, timeout=3)
        except Exception:
            pass

    def _notify_stop(self):
        try:
            url = f"{self.config.backend_url}/api/runners/{self.config.runner_index}/stop"
            requests.post(url, json={"runner_key": self.runner_key, "session_uuid": self.session_uuid}, timeout=4)
        except Exception:
            pass

    def start(self):
        console.rule("[bold magenta]TikTok Booster Android 14 Runner Engine[/bold magenta]")
        logger.info(f"Runner Key: {self.runner_key} | Session UUID: {self.session_uuid}")
        logger.info(f"Target Stream: {self.config.stream_url or self.config.stream_user or self.config.room_id}")

        self.transition_state(RunnerState.INITIALIZING)

        # 1. VPN Setup
        if self.config.vpn_provider != "none":
            self.vpn.setup_vpn()

        # 2. ADB & Android 14 Connectivity
        self.transition_state(RunnerState.ADB_CONNECTING)
        if not self.adb.check_connection():
            logger.error("ADB connection failed!")
            self.transition_state(RunnerState.ERROR)
            sys.exit(1)

        self.transition_state(RunnerState.ADB_CONNECTED)
        self.transition_state(RunnerState.ANDROID_READY)

        # 3. Register in PostgreSQL & Start Real-Time Scrcpy Stream Forwarder
        self.register_runner()
        self.stream_forwarder.start_background()
        self.stream_forwarder.wait_until_connected(timeout=2.0)
        self.send_heartbeat(include_screenshot=True)

        self.adb.wake_and_unlock()

        # 4. App Installation Verification
        self.transition_state(RunnerState.APP_STARTING)
        if not self.adb.ensure_app_installed():
            logger.warning("TikTok package is not installed. Proceeding with browser fallback.")

        # 5. Account Assignment from Google Sheets
        assigned_accounts = self.sheet_service.get_assigned_accounts_for_runner()
        if not assigned_accounts:
            logger.info("No dedicated account assigned. Running in Guest Viewer mode.")
            self._run_stream_session(account=None)
        else:
            for acc in assigned_accounts:
                if not self.is_running:
                    break
                self._run_stream_session(account=acc)

        # 6. Session Finished
        self.transition_state(RunnerState.STOPPED)
        self.send_heartbeat(include_screenshot=True)
        self._notify_stop()
        logger.info(f"Milestone 1 Session Finished! Total likes: {self.total_likes_sent}")

    def _run_stream_session(self, account=None):
        acc_label = f"[{account.username}]" if account and account.username else "[Guest-Viewer]"
        logger.info(f"=== Starting Session for {acc_label} ===")

        # 1. Identity & Proxy
        if account and account.device_id:
            self.adb.set_persistent_device_identity(account.device_id)
        if account and account.proxy:
            self.adb.configure_proxy(account.proxy)

        # 2. Launch Target Stream
        self.transition_state(RunnerState.TARGET_OPENING)
        self.adb.launch_live_stream(
            stream_url=self.config.stream_url,
            room_id=self.config.room_id,
            stream_user=self.config.stream_user
        )

        time.sleep(3)
        self.adb.dismiss_popups()

        if self.adb.is_live_stream_active():
            self.transition_state(RunnerState.TARGET_VERIFIED)
        else:
            self.transition_state(RunnerState.TARGET_OPENING)

        self.send_heartbeat(include_screenshot=True)

        duration_seconds = self.config.duration_minutes * 60
        start_time = time.time()
        taps_per_burst = 10
        bursts_per_minute = max(1, self.config.likes_per_minute // taps_per_burst)
        interval_between_bursts = 60.0 / bursts_per_minute

        last_burst_time = 0
        last_heartbeat_time = 0
        last_stream_reopen_time = time.time()

        self.transition_state(RunnerState.RUNNING)

        while self.is_running and (time.time() - start_time) < duration_seconds:
            now = time.time()

            # Auto-reconnect if stream dropped
            if now > getattr(self.adb, 'user_override_until', 0) and (now - last_stream_reopen_time) >= 20:
                if not self.adb.is_live_stream_active():
                    self.transition_state(RunnerState.RECOVERING)
                    self.adb.dismiss_popups()
                    if self.config.room_id:
                        self.adb.shell(f'am start -a android.intent.action.VIEW -d "snssdk1233://live?room_id={self.config.room_id}" {self.adb.package_name}')
                    elif self.config.stream_url:
                        self.adb.shell(f'am start -a android.intent.action.VIEW -d "{self.config.stream_url}" {self.adb.package_name}')
                else:
                    self.transition_state(RunnerState.RUNNING)
                last_stream_reopen_time = now

            # Execute Heart Likes Burst
            if now - last_burst_time >= interval_between_bursts:
                if self.adb.is_live_stream_active():
                    taps = self.adb.send_batch_likes(tap_count=taps_per_burst, delay_ms=120)
                    self.total_likes_sent += taps
                else:
                    self.adb.dismiss_popups()
                last_burst_time = now

            # Send Telemetry & Process Remote Commands every 2.5s
            if now - last_heartbeat_time >= 2.5:
                self.send_heartbeat(include_screenshot=True)
                last_heartbeat_time = now

            time.sleep(0.3)

def main():
    orchestrator = TikTokBoosterOrchestrator()
    orchestrator.start()

if __name__ == "__main__":
    main()

