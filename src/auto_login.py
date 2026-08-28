import os
import time
import hashlib
import logging
from typing import Optional
from src.config import AppConfig
from src.models import TikTokAccount
from src.adb_controller import ADBController
from src.drive_service import GoogleDriveService
from src.sheet_service import GoogleSheetService

logger = logging.getLogger("AutoLoginManager")

class AutoLoginManager:
    """
    Automates cloud-native account onboarding:
    1. Generates persistent hardware ID.
    2. Performs in-app login or session initialization on Android.
    3. Archives the authenticated session.
    4. Uploads archive to Google Drive.
    5. Syncs Google Sheet with Drive URL and Device ID.
    """

    def __init__(self, config: AppConfig, adb: ADBController, drive: GoogleDriveService, sheet: GoogleSheetService):
        self.config = config
        self.adb = adb
        self.drive = drive
        self.sheet = sheet

    def _generate_device_id(self, account_identifier: str) -> str:
        """Generates a deterministic, persistent 16-hex Android ID based on account name."""
        hash_val = hashlib.sha256(account_identifier.encode("utf-8")).hexdigest()
        return hash_val[:16]

    def onboard_account(self, account: TikTokAccount) -> bool:
        """Runs the complete end-to-end cloud onboarding for a new account."""
        acc_label = account.username or account.id
        logger.info(f"=== [Cloud Onboarding] Initializing Session for {acc_label} ===")

        # 1. Assign Persistent Device ID if missing
        if not account.device_id:
            account.device_id = self._generate_device_id(acc_label)
            logger.info(f"Generated persistent Device ID: {account.device_id}")

        self.adb.set_persistent_device_identity(account.device_id)

        # 2. Configure Proxy
        if account.proxy:
            self.adb.configure_proxy(account.proxy)

        # 3. If cookies are provided, inject them; otherwise perform in-app Email/Password UI login
        if account.cookies_raw:
            logger.info(f"Injecting initial cookie/session token for {acc_label}...")
            self._inject_session_cookies_to_app(account)
            # Launch TikTok Mobile App
            logger.info("Launching TikTok app on Android device...")
            self.adb.shell(f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {self.adb.package_name}")
            time.sleep(6)
            self.adb.dismiss_popups()
        elif account.username and account.password:
            # Launch TikTok Mobile App
            logger.info("Launching TikTok app on Android device for automated Email/Password login...")
            self.adb.shell(f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {self.adb.package_name}")
            time.sleep(6)
            # Perform automated Email/Password in-app login
            self.login_with_email_password(account.username, account.password)
        else:
            # Launch guest
            self.adb.shell(f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {self.adb.package_name}")
            time.sleep(5)
            self.adb.dismiss_popups()

        # 4. Extract and bundle the authenticated app data
        local_tar = os.path.join(os.getcwd(), f"tiktok_session_{acc_label}.tar.gz")
        logger.info("Creating session archive from Android app data...")
        backed_up = self.adb.backup_app_session(local_tar)

        if not backed_up or not os.path.exists(local_tar) or os.path.getsize(local_tar) == 0:
            logger.warning("Could not extract app session. Please ensure emulator has permissions.")
            return False

        # 6. Upload to Google Drive automatically
        logger.info("Uploading session archive directly to Google Drive...")
        drive_url = self.drive.upload_session(local_tar, acc_label)
        
        if drive_url:
            account.session_backup_url = drive_url
            account.status = "Ready / Synced"
            logger.info(f"[+] Account {acc_label} successfully onboarded! Drive URL: {drive_url}")

            # 7. Update Google Sheet
            self._update_sheet_row(account)
            return True

        return False

    def _inject_session_cookies_to_app(self, account: TikTokAccount) -> None:
        """Injects session token directly into TikTok Android shared_preferences."""
        cookies = account.get_cookies_list()
        session_val = None
        for c in cookies:
            if c.get("name") == "sessionid":
                session_val = c.get("value")
                break
                
        if not session_val and account.cookies_raw and len(account.cookies_raw) > 10:
            session_val = account.cookies_raw.strip()

        if session_val:
            xml_content = f'''<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\' ?>
<map>
    <string name="session_key">{session_val}</string>
    <string name="sessionid">{session_val}</string>
</map>'''
            device_xml = f"/sdcard/aweme_user.xml"
            # Write to tmp and move to shared_prefs
            self.adb.shell(f"echo '{xml_content}' > {device_xml}")
            self.adb.shell(f"mkdir -p /data/data/{self.adb.package_name}/shared_prefs")
            self.adb.shell(f"cp {device_xml} /data/data/{self.adb.package_name}/shared_prefs/aweme_user.xml 2>/dev/null || true")

    def login_with_email_password(self, email: str, password: str) -> bool:
        """
        Executes instrumented in-app login with Email and Password for authorized test accounts.
        Logs package, activity, UI tree availability, and challenge detection without security bypasses.
        """
        masked_email = f"{email[:3]}...@{email.split('@')[-1]}" if "@" in email else "auth_user"
        logger.info(f"=== [Auth State Machine] Starting Login for {masked_email} ===")
        width = self.adb.screen_width
        height = self.adb.screen_height

        # Diagnostic: Current Foreground Activity
        cur_act = self.adb.get_foreground_activity()
        logger.info(f"[Auth Diagnostic] Foreground Activity before login: {cur_act}")

        # Diagnostic: UI XML Hierarchy Inspection
        xml = self.adb.dump_ui_hierarchy()
        logger.info(f"[Auth Diagnostic] UI Hierarchy Dump available: {xml is not None} ({len(xml) if xml else 0} bytes)")

        # 1. Dismiss any initial ANR or system dialog
        self.adb.dismiss_popups()
        time.sleep(1.5)

        # 2. Check if screen is in Sign-up mode and click "Log in" link at bottom
        if self.adb.click_element(text="Already have an account") or self.adb.click_element(text="Log in"):
            logger.info("Switched from Sign-up to Log-in screen.")
            time.sleep(2)

        # 3. Tap 'Use phone / email / username' option
        logger.info("Selecting 'Use phone / email / username' option...")
        clicked_phone_email = (
            self.adb.click_element(text="Use phone / email / username") or
            self.adb.click_element(text="Use phone") or
            self.adb.click_element(text="phone / email")
        )
        if not clicked_phone_email:
            self.adb.shell(f"input tap {width // 2} {int(height * 0.36)}")
        time.sleep(3)

        # 4. Switch to 'Email / Username' Tab (Right tab)
        logger.info("Selecting 'Email / Username' tab...")
        clicked_tab = (
            self.adb.click_element(text="Email / Username") or
            self.adb.click_element(text="Email or username") or
            self.adb.click_element(text="Email")
        )
        if not clicked_tab:
            tab_email_x = int(width * 0.72)
            tab_email_y = int(height * 0.12)
            self.adb.shell(f"input tap {tab_email_x} {tab_email_y}")
        time.sleep(2)

        # 5. Tap Email input field & enter Email
        logger.info("Focusing email input field...")
        focused_email = (
            self.adb.click_element(text="Email or username") or
            self.adb.click_element(resource_id="email_input") or
            self.adb.click_element(text="Email")
        )
        if not focused_email:
            self.adb.shell(f"input tap {width // 2} {int(height * 0.20)}")
        time.sleep(1)

        escaped_email = email.replace(" ", "").strip()
        self.adb.shell(f"input text {escaped_email}")
        time.sleep(1.5)

        # 6. Tap Next / Password field
        logger.info("Navigating to password input...")
        if not self.adb.click_element(text="Next"):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.32)}")
        time.sleep(3)

        # 7. Type Password
        logger.info("Focusing password field...")
        focused_pwd = (
            self.adb.click_element(text="Password") or
            self.adb.click_element(resource_id="password_input")
        )
        if not focused_pwd:
            self.adb.shell(f"input tap {width // 2} {int(height * 0.24)}")
        time.sleep(1)

        escaped_pwd = password.replace(" ", "%s").replace("&", "\&").strip()
        self.adb.shell(f"input text {escaped_pwd}")
        time.sleep(1.5)

        # 8. Tap 'Log in' button
        logger.info("Submitting login form...")
        if not self.adb.click_element(text="Log in"):
            self.adb.shell(f"input tap {width // 2} {int(height * 0.34)}")
        time.sleep(5)

        # 9. Diagnostic: Check if Challenge / Verification appeared
        out_win = self.adb.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").lower()
        if any(c in out_win for c in ["captcha", "sec_captcha", "verify", "challenge", "two_step"]):
            logger.warning(f"[Auth Challenge Detected] Application presented interactive challenge: {out_win.strip()}")
            return False

        # 10. Verify if login succeeded
        if not self.adb._is_login_screen_active():
            logger.info(f"[Auth Success] Account {masked_email} entered main feed.")
            return True
        else:
            logger.warning("[Auth Incomplete] Application remains on authentication activity.")
            return False

    def _update_sheet_row(self, account: TikTokAccount) -> None:
        """Updates Google Sheet with the new session_backup_url and device_id."""
        if self.sheet._worksheet:
            try:
                cell = self.sheet._worksheet.find(account.username) if account.username else self.sheet._worksheet.find(account.id)
                if cell:
                    row = cell.row
                    self.sheet._worksheet.update_cell(row, 5, account.session_backup_url or "")
                    self.sheet._worksheet.update_cell(row, 6, account.device_id or "")
                    self.sheet._worksheet.update_cell(row, 8, "Ready / Synced")
                    logger.info("Updated Google Sheet with Google Drive URL and Device ID.")
            except Exception as e:
                logger.warning(f"Could not update Google Sheet row: {e}")
