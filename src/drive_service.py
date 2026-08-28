import os
import json
import logging
import io
from typing import Optional
from src.config import AppConfig

logger = logging.getLogger("GoogleDriveService")

class GoogleDriveService:
    """Service to automatically upload, download, and synchronize session archives on Google Drive."""

    def __init__(self, config: AppConfig):
        self.config = config
        self.service_account_json = config.google_service_account_json
        self._drive_client = None

    def _get_client(self):
        """Initializes Google Drive v3 API client."""
        if self._drive_client:
            return self._drive_client

        if not self.service_account_json:
            logger.warning("No GOOGLE_SERVICE_ACCOUNT_JSON provided. Google Drive features disabled.")
            return None

        try:
            from google.oauth2.service_account import Credentials
            from googleapiclient.discovery import build

            scopes = ["https://www.googleapis.com/auth/drive"]
            
            if os.path.exists(self.service_account_json):
                creds = Credentials.from_service_account_file(self.service_account_json, scopes=scopes)
            else:
                info = json.loads(self.service_account_json)
                creds = Credentials.from_service_account_info(info, scopes=scopes)

            self._drive_client = build("drive", "v3", credentials=creds)
            logger.info("Connected to Google Drive API v3 successfully.")
            return self._drive_client
        except Exception as e:
            logger.error(f"Failed to initialize Google Drive client: {e}")
            return None

    def _get_or_create_folder(self, folder_name: str = "TikTok_Sessions") -> Optional[str]:
        """Gets or creates the dedicated session storage folder in Google Drive."""
        client = self._get_client()
        if not client:
            return None

        try:
            # Query if folder already exists
            query = f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
            results = client.files().list(q=query, fields="files(id, name)").execute()
            files = results.get("files", [])
            
            if files:
                folder_id = files[0]["id"]
                logger.debug(f"Found existing Google Drive folder '{folder_name}' (ID: {folder_id})")
                return folder_id

            # Create folder
            folder_metadata = {
                "name": folder_name,
                "mimeType": "application/vnd.google-apps.folder"
            }
            folder = client.files().create(body=folder_metadata, fields="id").execute()
            folder_id = folder.get("id")
            logger.info(f"Created new Google Drive folder '{folder_name}' (ID: {folder_id})")
            return folder_id
        except Exception as e:
            logger.error(f"Error creating/getting Google Drive folder: {e}")
            return None

    def upload_session(self, local_file_path: str, account_name: str) -> Optional[str]:
        """
        Uploads a session archive (.tar.gz) to Google Drive and returns a direct download URL.
        """
        client = self._get_client()
        if not client or not os.path.exists(local_file_path):
            return None

        try:
            from googleapiclient.http import MediaFileUpload
            folder_id = self._get_or_create_folder()
            filename = f"tiktok_session_{account_name}.tar.gz"

            # Check if file with same name already exists in folder, update if so
            query = f"name = '{filename}' and trashed = false"
            if folder_id:
                query += f" and '{folder_id}' in parents"
                
            results = client.files().list(q=query, fields="files(id, name)").execute()
            existing = results.get("files", [])

            media = MediaFileUpload(local_file_path, mimetype="application/gzip", resumable=True)

            if existing:
                file_id = existing[0]["id"]
                logger.info(f"Updating existing session file on Google Drive (ID: {file_id})...")
                updated = client.files().update(fileId=file_id, media_body=media, fields="id, webViewLink").execute()
            else:
                file_metadata = {"name": filename}
                if folder_id:
                    file_metadata["parents"] = [folder_id]
                logger.info(f"Uploading new session file '{filename}' to Google Drive...")
                file = client.files().create(body=file_metadata, media_body=media, fields="id, webViewLink").execute()
                file_id = file.get("id")

            # Make file accessible via link
            try:
                client.permissions().create(
                    fileId=file_id,
                    body={"type": "anyone", "role": "reader"}
                ).execute()
            except Exception:
                pass

            download_url = f"https://drive.google.com/uc?id={file_id}&export=download"
            logger.info(f"[+] Session stored on Google Drive! Direct URL: {download_url}")
            return download_url
        except Exception as e:
            logger.error(f"Failed to upload session to Google Drive: {e}")
            return None

    def download_session(self, file_id_or_url: str, destination_path: str) -> bool:
        """
        Downloads a session archive (.tar.gz) from Google Drive directly to destination_path.
        """
        if not file_id_or_url:
            return False

        # Extract file ID if URL is provided
        file_id = file_id_or_url
        if "id=" in file_id_or_url:
            file_id = file_id_or_url.split("id=")[1].split("&")[0]
        elif "/d/" in file_id_or_url:
            file_id = file_id_or_url.split("/d/")[1].split("/")[0]

        client = self._get_client()
        if client:
            try:
                from googleapiclient.http import MediaIoBaseDownload
                logger.info(f"Downloading session from Google Drive (ID: {file_id}) ...")
                request = client.files().get_media(fileId=file_id)
                fh = io.FileIO(destination_path, "wb")
                downloader = MediaIoBaseDownload(fh, request)
                done = False
                while not done:
                    status, done = downloader.next_chunk()
                fh.close()
                logger.info(f"[+] Download complete: {destination_path} ({os.path.getsize(destination_path)} bytes)")
                return True
            except Exception as e:
                logger.warning(f"Google Drive API download failed: {e}. Trying direct HTTP...")

        # Fallback to direct HTTP request
        try:
            import requests
            url = f"https://drive.google.com/uc?id={file_id}&export=download"
            r = requests.get(url, stream=True, timeout=30)
            if r.status_code == 200:
                with open(destination_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        f.write(chunk)
                logger.info(f"[+] HTTP Download complete: {destination_path}")
                return True
        except Exception as e:
            logger.error(f"Failed to download session via HTTP: {e}")
            return False

        return False
