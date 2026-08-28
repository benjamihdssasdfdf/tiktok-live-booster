"""
TikTok Booster - Automated In-App Authentication & Onboarding Engine
Deterministic, instrumented login state machine supporting:
- Session Cleanup to guarantee genuine credential login
- Persistent Hardware Identity
- Native In-App Email & Password Entry
- Automated Gmail IMAP 2FA Code Extraction
- Non-Bypass CAPTCHA / Challenge Detection (LOGIN_REQUIRES_USER_ACTION)
- Authoritative Post-Auth UI Validation
"""

import os
import time
import hashlib
import logging
import requests
from typing import Optional, Callable
from src.config import AppConfig
from src.adb_controller import ADBController
from src.email_service import GmailVerificationService

logger = logging.getLogger("AutoLoginManager")

class AutoLoginManager:
    def __init__(self, config: AppConfig, adb: ADBController, drive=None, sheet=None):
        self.config = config
        self.adb = adb
        self.drive = drive
        self.sheet = sheet

    def _generate_device_id(self, account_identifier: str) -> str:
        """Generates a deterministic 16-hex Android ID based on account name."""
        return hashlib.sha256(account_identifier.encode("utf-8")).hexdigest()[:16]

    def authenticate_account(self, account: dict, state_callback: Optional[Callable[[str, str], None]] = None) -> bool:
        """
        Executes the full automated login state machine:
        TIKTOK_LAUNCHING -> LOGIN_REQUIRED -> LOGIN_SUBMITTING -> VERIFICATION_REQUIRED -> VERIFICATION_SUBMITTED -> TIKTOK_AUTHENTICATED -> LIVE_BROWSING_READY
        """
        username = account.get("username") or account.get("email") or "guest"
        password = account.get("password") or ""
        gmail_addr = account.get("gmail_address")
        gmail_pwd = account.get("gmail_app_password")
        acc_id = account.get("id")

        masked_acc = f"{username[:3]}...@{username.split('@')[-1]}" if "@" in username else username
        logger.info(f"=== [Auth State Machine] Starting In-App Authentication for {masked_acc} ===")

        def report(st: str, reason: str = ""):
            logger.info(f"[AUTH_PHASE] {st}: {reason}")
            if state_callback:
                state_callback(st, reason)
            if acc_id:
                try:
                    url = f"{self.config.backend_url}/api/accounts/{acc_id}/login-status"
                    requests.post(url, json={"login_status": st, "error_message": reason}, timeout=3)
                except Exception:
                    pass

        # 1. Guarantee a completely fresh, logged-out session for credential login testing
        logger.info(f"Clearing existing application data and authentication state for {self.adb.package_name}...")
        self.adb.shell(f"pm clear {self.adb.package_name}")
        time.sleep(2)

        # 2. Device Hardware Identity
        device_id = account.get("device_id") or self._generate_device_id(username)
        self.adb.set_persistent_device_identity(device_id)

        # 3. Configure Proxy if assigned
        if account.get("proxy"):
            self.adb.configure_proxy(account.get("proxy"))

        # 4. Launch clean TikTok Application
        report("TIKTOK_LAUNCHING", "Starting clean TikTok native Android activity")
        self.adb.shell(f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {self.adb.package_name}")
        time.sleep(6)

        width = self.adb.screen_width or 1080
        height = self.adb.screen_height or 2400

        # 5. Dismiss initial onboarding prompts (Terms, Interests, Start Watching)
        if self.adb.click_element(text="Agree and continue") or self.adb.click_element(text="Agree"):
            time.sleep(1.5)
        if self.adb.click_element(text="Skip") or self.adb.click_element(text="Choose your interests"):
            time.sleep(1.5)
        if self.adb.click_element(text="Start watching"):
            time.sleep(1.5)
        self.adb.dismiss_popups()

        if not password:
            logger.info(f"No password provided for {masked_acc}. Proceeding in Guest / Read-Only mode.")
            report("LIVE_BROWSING_READY", "Running as Guest Viewer")
            return True

        # 6. Navigate to Login Screen
        report("LOGIN_REQUIRED", "Authentication required; navigating to Email login tab")
        time.sleep(1)

        # Tap Profile tab in bottom right
        if not (self.adb.click_element(text="Profile") or self.adb.click_element(text="Me")):
            self.adb.shell(f"input tap {int(width * 0.90)} {int(height * 0.96)}")
        time.sleep(2)

        # Check if screen is in Sign-up mode and click "Log in" link
        if self.adb.click_element(text="Already have an account") or self.adb.click_element(text="Log in"):
            logger.info("Clicked 'Log in' link on signup screen.")
            time.sleep(2)

        # Tap 'Use phone / email / username' option
        if not (self.adb.click_element(text="Use phone / email / username") or self.adb.click_element(text="Use phone") or self.adb.click_element(text="phone / email")):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.36)}")
        time.sleep(2.5)

        # Select 'Email / Username' tab
        if not (self.adb.click_element(text="Email / Username") or self.adb.click_element(text="Email or username") or self.adb.click_element(text="Email")):
            self.adb.shell(f"input tap {int(width * 0.72)} {int(height * 0.12)}")
        time.sleep(2)

        # Focus Email input & enter email
        if not (self.adb.click_element(text="Email or username") or self.adb.click_element(resource_id="email_input") or self.adb.click_element(text="Email")):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.20)}")
        time.sleep(1)

        clean_user = username.replace(" ", "").strip()
        self.adb.shell(f"input text {clean_user}")
        time.sleep(1.5)

        # Tap Next / Password field
        if not self.adb.click_element(text="Next"):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.32)}")
        time.sleep(2.5)

        # Type Password
        report("LOGIN_SUBMITTING", "Entering account credentials")
        if not (self.adb.click_element(text="Password") or self.adb.click_element(resource_id="password_input")):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.24)}")
        time.sleep(1)

        escaped_pwd = password.replace(" ", "%s").replace("&", "\&").strip()
        self.adb.shell(f"input text {escaped_pwd}")
        time.sleep(1.5)

        # Tap 'Log in' button
        if not self.adb.click_element(text="Log in"):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.34)}")
        time.sleep(5)

        # 7. Check for CAPTCHA / Puzzle Challenge
        win_info = self.adb.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").lower()
        if any(c in win_info for c in ["captcha", "sec_captcha", "puzzle", "challenge", "two_step"]):
            logger.warning(f"[Challenge Detected] TikTok presented security challenge: {win_info.strip()}")
            report("LOGIN_REQUIRES_USER_ACTION", "Interactive challenge detected. Please solve on Live Screen.")
            # Wait up to 60s for operator resolution
            for _ in range(30):
                time.sleep(2)
                if not self._is_login_screen_active():
                    break

        # 8. Check for 2FA / Email Verification Code Screen
        win_info = self.adb.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").lower()
        ui_dump = (self.adb.dump_ui_hierarchy() or "").lower()
        if "verification" in win_info or "verify" in win_info or "enter 6-digit code" in ui_dump or "digit code" in ui_dump or "code" in win_info:
            report("VERIFICATION_REQUIRED", "Email verification code requested by TikTok")
            if gmail_addr and gmail_pwd:
                logger.info(f"Connecting to Gmail IMAP for account {gmail_addr}...")
                email_srv = GmailVerificationService(gmail_addr, gmail_pwd)
                code = email_srv.fetch_tiktok_verification_code(timeout_seconds=45)
                if code:
                    logger.info(f"Typing retrieved verification code '{code}' into TikTok verification input...")
                    self.adb.shell(f"input text {code}")
                    time.sleep(2)
                    report("VERIFICATION_SUBMITTED", f"Submitted code {code[:2]}****")
                    time.sleep(4)
                else:
                    logger.warning("No verification code received from Gmail IMAP within timeout.")
                    report("LOGIN_REQUIRES_USER_ACTION", "2FA code timeout. Please enter code manually.")
            else:
                report("LOGIN_REQUIRES_USER_ACTION", "2FA code required. Please enter code on Live Screen.")
                time.sleep(15)

        # 9. Post-Login Authoritative UI Validation
        self.adb.dismiss_popups()
        time.sleep(2)

        # Dismiss post-login prompts: "Save login info", "Allow notifications", "Sync contacts"
        if self.adb.click_element(text="Save") or self.adb.click_element(text="Not now"):
            time.sleep(1)
        if self.adb.click_element(text="Don't allow") or self.adb.click_element(text="Deny"):
            time.sleep(1)

        # Verify that we are on home feed / live viewer / profile and NOT on login activity
        if not self._is_login_screen_active():
            logger.info(f"[+] [AUTH SUCCESS] Account {masked_acc} authenticated successfully into native app!")
            report("TIKTOK_AUTHENTICATED", "User authenticated into main feed")
            report("LIVE_BROWSING_READY", "Ready for live stream viewer")
            return True
        else:
            logger.warning(f"[-] [AUTH FAILED] Application remains on authentication activity.")
            report("LOGIN_REQUIRED", "Login incomplete or rejected")
            return False

    def _is_login_screen_active(self) -> bool:
        """Checks if login or sign-up activity is currently foreground."""
        act = self.adb.get_foreground_activity().lower()
        login_indicators = [
            "signupactivity",
            "loginactivity",
            "i18nsignupactivity",
            "account.login",
            "authorizeactivity"
        ]
        return any(ind in act for ind in login_indicators)
