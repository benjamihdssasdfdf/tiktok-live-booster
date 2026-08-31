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
        self.transition_state(RunnerState.STOPPING, reason="SIGINT/SIGTERM shutdown signal received")
        self.stream_forwarder.stop()
        self.send_heartbeat()
        self._notify_stop()

    def transition_state(self, new_state: RunnerState, reason: str = ""):
        """Logs deterministic state transition and immediately transmits high-speed telemetry update to backend."""
        if self.current_state != new_state:
            self.previous_state = self.current_state
            self.current_state = new_state
            ts = datetime.utcnow().isoformat() + "Z"
            self.current_reason = reason or f"Transitioned to {new_state.value}"
            logger.info(f"[STATE_TRANSITION] runner={self.runner_key} session={self.session_uuid} previous={self.previous_state.value} new={self.current_state.value} reason='{self.current_reason}' timestamp={ts}")
            
            # Immediately notify central backend (fast sub-50ms transmission without taking heavy screenshot)
            try:
                self.send_heartbeat(include_screenshot=False, reason=self.current_reason)
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

    def send_heartbeat(self, include_screenshot=False, reason: str = "") -> list:
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
            "reason": reason or getattr(self, 'current_reason', f"State: {self.current_state.value}"),
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

        # Include structured VPN telemetry
        if hasattr(self, 'vpn') and self.vpn:
            payload.update(self.vpn.get_telemetry())

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
            except Exception as e:
                err_msg = str(e)
                logger.error(f"Failed to execute dashboard command {cmd_id}: {e}")

            # Send ack
            try:
                ack_url = f"{self.config.backend_url}/api/runners/{self.runner_key}/commands/{cmd_id}/ack"
                requests.post(ack_url, json={"success": success, "error": err_msg}, timeout=3)
            except Exception:
                pass

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

    def run_session(self):
        """Orchestrates Milestone 1 automated Live Stream attendance and like burst session."""
        console.rule("[bold magenta]TikTok Booster Android 14 Runner Engine[/bold magenta]")
        logger.info(f"Runner Key: {self.runner_key} | Session UUID: {self.session_uuid}")
        logger.info(f"Target Stream: {self.config.stream_url or self.config.stream_user or self.config.room_id}")

        self.transition_state(RunnerState.INITIALIZING, reason="Runner process spawned; reading runtime configuration")

        # 1. VPN Setup
        if self.config.vpn_provider != "none":
            vpn_ok = self.vpn.setup_vpn()
            if not vpn_ok and self.config.vpn_provider == "pia":
                logger.error("[-] PIA VPN failed to connect. Halting runner to prevent unprotected traffic.")
                self.transition_state(RunnerState.ERROR, reason="PIA VPN initialization failed")
                sys.exit(1)

        # 2. ADB & Android 14 Connectivity
        self.transition_state(RunnerState.ADB_CONNECTING, reason="Establishing ADB connection to Android 14 AVD")
        if not self.adb.check_connection():
            logger.error("ADB connection failed!")
            self.transition_state(RunnerState.ERROR, reason="ADB connection failed to reach device")
            sys.exit(1)

        self.transition_state(RunnerState.ADB_CONNECTED, reason="ADB connected and authorized")
        self.transition_state(RunnerState.ANDROID_READY, reason=f"Android 14 system boot completed (API {self.adb.sdk_level})")

        # 3. Register in PostgreSQL & Start Real-Time Scrcpy Stream Forwarder
        self.register_runner()
        self.stream_forwarder.start_background()
        self.stream_forwarder.wait_until_connected(timeout=2.0)
        self.send_heartbeat(include_screenshot=True, reason="Scrcpy forwarder connected; initial screen snapshot taken")

        self.adb.wake_and_unlock()

        # 4. App Installation Verification
        self.transition_state(RunnerState.APP_STARTING, reason="Verifying TikTok APK installation and launching app")
        if not self.adb.ensure_app_installed():
            logger.warning("TikTok package is not installed. Proceeding with browser fallback.")

        # Verify initial emulator network egress
        if self.config.vpn_provider != "none":
            egress = self.vpn.verify_android_egress(self.adb)
            if self.config.vpn_provider == "pia" and not egress.get("has_internet"):
                logger.error("[-] Android emulator has no Internet connectivity through VPN. Halting.")
                self.transition_state(RunnerState.ERROR, reason="Android emulator has no Internet via VPN")
                sys.exit(1)

        # 5. Dynamic Account Assignment & In-App Authentication with Account Rotation
        candidate_accounts = self._fetch_candidate_accounts()
        authenticated_account = None

        if candidate_accounts and len(candidate_accounts) > 0:
            logger.info(f"[+] Loaded {len(candidate_accounts)} candidate enabled account(s) for runner rotation pool.")
            
            def auth_callback(phase_name: str, phase_reason: str):
                state_mapping = {
                    "STARTING": RunnerState.STARTING,
                    "LOGIN_REQUIRED": RunnerState.LOGIN_REQUIRED,
                    "LOGIN_STARTED": RunnerState.LOGIN_STARTED,
                    "LOGIN_SUBMITTED": RunnerState.LOGIN_SUBMITTED,
                    "LOGIN_VERIFYING": RunnerState.LOGIN_VERIFYING,
                    "2FA_REQUIRED": RunnerState.TWO_FA_REQUIRED,
                    "AUTHENTICATED": RunnerState.AUTHENTICATED,
                    "LOGGED_IN": RunnerState.LOGGED_IN,
                    "LOGIN_FAILED": RunnerState.LOGIN_FAILED,
                    "LOGIN_CHALLENGE": RunnerState.LOGIN_CHALLENGE,
                    "LOGIN_RATE_LIMITED": RunnerState.LOGIN_RATE_LIMITED,
                    "LOGIN_BLOCKED": RunnerState.LOGIN_BLOCKED,
                }
                mapped_state = state_mapping.get(phase_name, RunnerState.LOGIN_REQUIRED)
                self.transition_state(mapped_state, reason=f"{phase_name}: {phase_reason}")
                self.send_heartbeat(include_screenshot=True, reason=f"{phase_name}: {phase_reason}")

            for idx, account in enumerate(candidate_accounts):
                acc_id = account.get("id")
                acc_email = account.get("email") or account.get("username")
                masked_email = f"{acc_email[:3]}***@{acc_email.split('@')[-1]}" if "@" in str(acc_email) else str(acc_email)
                
                logger.info(f"\n{'='*60}")
                logger.info(f"🔄 [Account Rotation] Evaluating Candidate #{idx+1}/{len(candidate_accounts)}: {masked_email} (ID #{acc_id})")
                logger.info(f"{'='*60}")

                # 1. Rotate VPN IP for subsequent attempts to provide clean IP
                if self.config.vpn_provider == "pia" and idx > 0:
                    logger.info(f"Rotating PIA VPN IP for Candidate #{idx+1}...")
                    self.vpn.rotate_vpn()
                    self.vpn.verify_android_egress(self.adb)

                # 2. Clean slate: Wipe app data
                logger.info(f"Wiping TikTok cache and state for clean slate...")
                self.adb.shell(f"pm clear {self.adb.package_name}")
                time.sleep(2)

                # 3. Set persistent device identity
                dev_id = account.get("device_id") or f"dev_{acc_id}_{int(time.time())}"
                self.adb.set_persistent_device_identity(dev_id)

                # 4. Configure Proxy if assigned
                if account.get("proxy"):
                    self.adb.configure_proxy(account.get("proxy"))

                # 5. Attempt login
                curr_ip_label = f" (IP: {self.vpn.current_ip})" if self.vpn.current_ip else ""
                self.transition_state(RunnerState.LOGIN_REQUIRED, reason=f"Starting login for candidate #{idx+1}: {masked_email}{curr_ip_label}")
                auth_success = self.auto_login.authenticate_account(account, state_callback=auth_callback)

                if auth_success:
                    logger.info(f"🎉 [Account Rotation] SUCCESS: Account {masked_email} authenticated into main feed!")
                    authenticated_account = account
                    self.transition_state(RunnerState.LOGGED_IN, reason=f"Account {masked_email} authenticated into feed")
                    self.send_heartbeat(include_screenshot=True, reason=f"Account {masked_email} authenticated")
                    break
                else:
                    logger.warning(f"⚠️ [Account Rotation] Account {masked_email} did not authenticate ({self.current_state}). Recording outcome and rotating to next candidate...")
                    self.send_heartbeat(include_screenshot=True, reason=f"Account {masked_email} login outcome: {self.current_state}")
                    time.sleep(2)

            if authenticated_account:
                self._run_stream_session(account=authenticated_account)
            else:
                logger.error("[-] All candidate accounts in rotation pool failed or were rate-limited/challenged. Stopping session cleanly without proceeding to Live Stream.")
                if self.current_state not in [RunnerState.LOGIN_RATE_LIMITED, RunnerState.LOGIN_CHALLENGE, RunnerState.TWO_FA_REQUIRED, RunnerState.LOGIN_FAILED]:
                    self.transition_state(RunnerState.LOGIN_FAILED, reason="All candidate accounts failed authentication")
                self.send_heartbeat(include_screenshot=True, reason="All candidate accounts failed authentication")
                self._notify_stop()
                return
        else:
            logger.info("No dedicated account assigned in backend. Running in Guest Viewer mode.")
            self._run_stream_session(account=None)

        # 6. Session Finished
        self.transition_state(RunnerState.STOPPED, reason="Session duration completed cleanly")
        self.send_heartbeat(include_screenshot=True, reason="Final session completion heartbeat")
        self._notify_stop()
        logger.info(f"Milestone 1 Session Finished! Total likes: {self.total_likes_sent}")

    def _fetch_assigned_account(self) -> dict:
        """Fetches assigned TikTok account with decrypted secrets from central backend."""
        try:
            url = f"{self.config.backend_url}/api/accounts/runner-assignment/{self.runner_key}"
            res = requests.get(url, headers={"Authorization": f"Bearer runner_token"}, timeout=5)
            if res.status_code == 200:
                data = res.json()
                if data.get("has_account") and data.get("account"):
                    return data.get("account")
        except Exception as e:
            logger.debug(f"Backend account assignment fetch note: {e}")
        return None

    def _run_stream_session(self, account=None):
        acc_label = f"[{account.get('username')}]" if account and isinstance(account, dict) and account.get('username') else (f"[{account.username}]" if account and hasattr(account, 'username') else "[Guest-Viewer]")
        logger.info(f"=== Starting Session for {acc_label} ===")

        # 1. Identity & Proxy
        if account and isinstance(account, dict):
            if account.get("device_id"):
                self.adb.set_persistent_device_identity(account.get("device_id"))
            if account.get("proxy"):
                self.adb.configure_proxy(account.get("proxy"))
        elif account and hasattr(account, 'device_id') and account.device_id:
            self.adb.set_persistent_device_identity(account.device_id)

        # 2. Launch Target Stream
        self.transition_state(RunnerState.OPENING_LIVE, reason=f"Opening target live stream room: {self.config.stream_url}")
        self.adb.launch_live_stream(
            stream_url=self.config.stream_url,
            room_id=self.config.room_id,
            stream_user=self.config.stream_user
        )

        time.sleep(3)
        self.adb.dismiss_popups()

        if self.adb.is_login_or_signup_screen():
            logger.info("Screen is on login/signup page. Auto-dismissing to enter Live Room...")
            self.adb.dismiss_popups()
            if self.adb.is_login_or_signup_screen():
                self.adb.shell("input keyevent 4")
                time.sleep(1)
            # Re-trigger live room navigation intent
            if self.config.stream_url:
                self.adb.shell(f'am start -a android.intent.action.VIEW -d "{self.config.stream_url}" {self.adb.package_name}')
                time.sleep(2)

        if self.adb.is_live_stream_active():
            self.transition_state(RunnerState.WATCHING, reason="TikTok Live stream player confirmed active and receiving video")
        else:
            self.transition_state(RunnerState.OPENING_LIVE, reason="Waiting for live player buffer to confirm active stream")

        self.send_heartbeat(include_screenshot=True, reason="Live room loaded, starting auto-liker loop")

        duration_seconds = self.config.duration_minutes * 60
        start_time = time.time()
        taps_per_burst = 10
        bursts_per_minute = max(1, self.config.likes_per_minute // taps_per_burst)
        interval_between_bursts = 60.0 / bursts_per_minute

        last_burst_time = 0
        last_heartbeat_time = 0
        last_stream_reopen_time = time.time()

        self.transition_state(RunnerState.RUNNING, reason=f"Auto-liker active at {self.config.likes_per_minute} likes/min target")

        while self.is_running and (time.time() - start_time) < duration_seconds:
            now = time.time()

            # Auto-reconnect if stream dropped
            if now > getattr(self.adb, 'user_override_until', 0) and (now - last_stream_reopen_time) >= 20:
                if not self.adb.is_live_stream_active():
                    self.transition_state(RunnerState.RECOVERING, reason="Live player inactive; dismissing overlays and re-launching room")
                    self.adb.dismiss_popups()
                    if self.config.room_id:
                        self.adb.shell(f'am start -a android.intent.action.VIEW -d "snssdk1233://live?room_id={self.config.room_id}" {self.adb.package_name}')
                    elif self.config.stream_url:
                        self.adb.shell(f'am start -a android.intent.action.VIEW -d "{self.config.stream_url}" {self.adb.package_name}')
                else:
                    self.transition_state(RunnerState.RUNNING, reason="Live player active and tapping")
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

