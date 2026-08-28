import os
import csv
import json
import logging
from datetime import datetime
from typing import List, Optional
import io
import requests
from src.models import TikTokAccount
from src.config import AppConfig

logger = logging.getLogger("SheetService")

class GoogleSheetService:
    """Service to fetch and synchronize TikTok accounts from Google Sheets or local fallback."""

    def __init__(self, config: AppConfig):
        self.config = config
        self.sheet_id = config.google_sheet_id
        self.sheet_name = config.google_sheet_name
        self.service_account_json = config.google_service_account_json
        self.csv_url = config.google_sheet_csv_url
        self._gspread_client = None
        self._worksheet = None

    def _init_gspread(self) -> bool:
        """Initializes gspread client using Service Account JSON if provided."""
        if self._worksheet:
            return True
            
        if not self.service_account_json or not self.sheet_id:
            return False
            
        try:
            import gspread
            from google.oauth2.service_account import Credentials
            
            scopes = [
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/drive"
            ]
            
            # Can be a JSON file path or raw JSON string
            if os.path.exists(self.service_account_json):
                creds = Credentials.from_service_account_file(self.service_account_json, scopes=scopes)
            else:
                info = json.loads(self.service_account_json)
                creds = Credentials.from_service_account_info(info, scopes=scopes)
                
            self._gspread_client = gspread.authorize(creds)
            sheet = self._gspread_client.open_by_key(self.sheet_id)
            self._worksheet = sheet.worksheet(self.sheet_name)
            logger.info(f"Connected to Google Sheet: '{self.sheet_name}' (ID: {self.sheet_id})")
            return True
        except Exception as e:
            logger.warning(f"Could not connect via gspread Service Account: {e}")
            return False

    def fetch_all_accounts(self) -> List[TikTokAccount]:
        """Fetches all accounts from Google Sheets or local files."""
        # 1. Try Google Sheets API (gspread)
        if self._init_gspread():
            try:
                records = self._worksheet.get_all_records()
                accounts = []
                for idx, row in enumerate(records, start=2): # Row 1 is header
                    acc = TikTokAccount(
                        id=str(row.get("id", idx)),
                        username=str(row.get("username", "")),
                        password=str(row.get("password", "") or ""),
                        cookies_raw=str(row.get("cookies", "") or row.get("cookies_json", "") or row.get("sessionid", "")),
                        session_backup_url=str(row.get("session_backup_url", "") or row.get("backup_url", "") or ""),
                        device_id=str(row.get("device_id", "") or row.get("android_id", "") or ""),
                        proxy=str(row.get("proxy", "") or ""),
                        status=str(row.get("status", "Idle")),
                        last_active=str(row.get("last_active", "")),
                        assigned_runner=str(row.get("assigned_runner", ""))
                    )
                    if acc.username or acc.cookies_raw:
                        accounts.append(acc)
                logger.info(f"Loaded {len(accounts)} accounts from Google Sheets (gspread).")
                return accounts
            except Exception as e:
                logger.error(f"Failed to fetch records via gspread: {e}")

        # 2. Try Google Drive API CSV Export (requires only Drive API which is already authenticated)
        if self.sheet_id and self.service_account_json:
            try:
                from googleapiclient.discovery import build
                from googleapiclient.http import MediaIoBaseDownload
                from google.oauth2.service_account import Credentials

                scopes = ["https://www.googleapis.com/auth/drive"]
                if os.path.exists(self.service_account_json):
                    creds = Credentials.from_service_account_file(self.service_account_json, scopes=scopes)
                else:
                    info = json.loads(self.service_account_json)
                    creds = Credentials.from_service_account_info(info, scopes=scopes)

                drive_service = build("drive", "v3", credentials=creds)
                req = drive_service.files().export_media(fileId=self.sheet_id, mimeType="text/csv")
                fh = io.BytesIO()
                downloader = MediaIoBaseDownload(fh, req)
                done = False
                while not done:
                    status, done = downloader.next_chunk()

                csv_text = fh.getvalue().decode("utf-8").strip()
                if csv_text:
                    reader = csv.DictReader(io.StringIO(csv_text))
                    accounts = []
                    for idx, row in enumerate(reader, start=2):
                        acc = TikTokAccount(
                            id=str(row.get("id", idx)),
                            username=str(row.get("username", "")),
                            password=str(row.get("password", "") or ""),
                            cookies_raw=str(row.get("cookies", "") or row.get("cookies_json", "") or row.get("sessionid", "")),
                            session_backup_url=str(row.get("session_backup_url", "") or row.get("backup_url", "") or ""),
                            device_id=str(row.get("device_id", "") or row.get("android_id", "") or ""),
                            proxy=str(row.get("proxy", "") or ""),
                            status=str(row.get("status", "Idle")),
                            last_active=str(row.get("last_active", "")),
                            assigned_runner=str(row.get("assigned_runner", ""))
                        )
                        if acc.username or acc.cookies_raw:
                            accounts.append(acc)
                    if accounts:
                        logger.info(f"Loaded {len(accounts)} accounts from Google Sheet via Drive API export.")
                        return accounts
            except Exception as e:
                logger.debug(f"Could not export sheet via Drive API: {e}")

        # 3. Try Published Google Sheet CSV URL
        if self.csv_url or (self.sheet_id and not self.service_account_json):
            url = self.csv_url
            if not url and self.sheet_id:
                url = f"https://docs.google.com/spreadsheets/d/{self.sheet_id}/gviz/tq?tqx=out:csv&sheet={self.sheet_name}"
            
            try:
                logger.info(f"Fetching accounts from published CSV URL: {url}")
                resp = requests.get(url, timeout=15)
                if resp.status_code == 200:
                    reader = csv.DictReader(io.StringIO(resp.text))
                    accounts = []
                    for idx, row in enumerate(reader, start=2):
                        acc = TikTokAccount(
                            id=str(row.get("id", idx)),
                            username=str(row.get("username", "")),
                            password=str(row.get("password", "") or ""),
                            cookies_raw=str(row.get("cookies", "") or row.get("cookies_json", "") or row.get("sessionid", "")),
                            proxy=str(row.get("proxy", "") or ""),
                            status=str(row.get("status", "Idle")),
                            last_active=str(row.get("last_active", "")),
                            assigned_runner=str(row.get("assigned_runner", ""))
                        )
                        if acc.username or acc.cookies_raw:
                            accounts.append(acc)
                    logger.info(f"Loaded {len(accounts)} accounts from Google Sheet CSV.")
                    return accounts
            except Exception as e:
                logger.warning(f"Failed to fetch accounts via CSV URL: {e}")

        # 4. Try Local fallback file (accounts.csv or accounts.json)
        local_csv = os.path.join(os.getcwd(), "accounts.csv")
        if os.path.exists(local_csv):
            try:
                with open(local_csv, mode="r", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    accounts = [
                        TikTokAccount(
                            id=str(row.get("id", idx)),
                            username=str(row.get("username", "")),
                            password=str(row.get("password", "") or ""),
                            cookies_raw=str(row.get("cookies", "") or row.get("cookies_json", "") or row.get("sessionid", "")),
                            proxy=str(row.get("proxy", "") or ""),
                            status=str(row.get("status", "Idle")),
                        )
                        for idx, row in enumerate(reader, start=2)
                        if row.get("username") or row.get("cookies")
                    ]
                logger.info(f"Loaded {len(accounts)} accounts from local accounts.csv")
                return accounts
            except Exception as e:
                logger.error(f"Failed to read local accounts.csv: {e}")

        local_json = os.path.join(os.getcwd(), "accounts.json")
        if os.path.exists(local_json):
            try:
                with open(local_json, mode="r", encoding="utf-8") as f:
                    data = json.load(f)
                    accounts = [TikTokAccount(**item) for item in data]
                logger.info(f"Loaded {len(accounts)} accounts from local accounts.json")
                return accounts
            except Exception as e:
                logger.error(f"Failed to read local accounts.json: {e}")

        logger.warning("No accounts found from Google Sheets or local files. Will proceed in Guest/Anonymous Live viewer mode.")
        return []

    def get_assigned_accounts_for_runner(self) -> List[TikTokAccount]:
        """Calculates and returns the specific subset of accounts assigned to this runner."""
        all_accounts = self.fetch_all_accounts()
        if not all_accounts:
            return []

        start_idx = self.config.runner_index * self.config.batch_size
        end_idx = start_idx + self.config.batch_size
        
        # If matrix index is beyond account length, wrap around or clamp
        if start_idx >= len(all_accounts):
            idx = self.config.runner_index % len(all_accounts)
            assigned = [all_accounts[idx]]
        else:
            assigned = all_accounts[start_idx:end_idx]

        logger.info(f"Runner #{self.config.runner_index} assigned {len(assigned)} accounts (indices {start_idx}..{end_idx-1})")
        return assigned

    def update_account_status(self, account: TikTokAccount, status: str, likes_sent: int = 0) -> None:
        """Updates account status in Google Sheet if write access is available."""
        account.status = status
        account.last_active = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        account.assigned_runner = self.config.runner_id
        
        logger.info(f"Account [{account.username or account.id}] status -> {status} (Likes: {likes_sent})")
        
        if self._worksheet:
            try:
                cell = self._worksheet.find(account.username) if account.username else self._worksheet.find(account.id)
                if cell:
                    row = cell.row
                    self._worksheet.update_cell(row, 6, status)
                    self._worksheet.update_cell(row, 7, account.last_active)
                    self._worksheet.update_cell(row, 8, self.config.runner_id)
            except Exception as e:
                logger.debug(f"Could not update status cell in Google Sheet: {e}")
