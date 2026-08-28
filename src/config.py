import os
import argparse
from typing import Optional
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

class AppConfig:
    """Application configuration loaded from environment variables and CLI arguments."""
    
    def __init__(self):
        # Target Live Stream Settings
        self.stream_url: str = os.getenv("STREAM_URL", "")
        self.stream_user: str = os.getenv("STREAM_USER", "")
        self.room_id: str = os.getenv("ROOM_ID", "")
        
        # Duration & Rate
        self.duration_minutes: int = int(os.getenv("DURATION_MINUTES", "60"))
        self.likes_per_minute: int = int(os.getenv("LIKES_PER_MINUTE", "120"))
        self.burst_mode: bool = os.getenv("BURST_MODE", "true").lower() in ("true", "1", "yes")
        
        # Google Sheets Configuration
        self.google_sheet_id: str = os.getenv("GOOGLE_SHEET_ID", "")
        self.google_sheet_name: str = os.getenv("GOOGLE_SHEET_NAME", "Accounts")
        self.google_service_account_json: Optional[str] = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", None)
        self.google_sheet_csv_url: Optional[str] = os.getenv("GOOGLE_SHEET_CSV_URL", None)
        
        # Matrix / Batch Runner Settings
        self.runner_index: int = int(os.getenv("RUNNER_INDEX", "0"))
        self.batch_size: int = int(os.getenv("BATCH_SIZE", "1"))
        self.runner_id: str = os.getenv("RUNNER_ID", f"runner-{self.runner_index}")
        
        # Android / ADB Settings
        self.adb_device_id: Optional[str] = os.getenv("ADB_DEVICE_ID", None)
        self.tiktok_package: str = os.getenv("TIKTOK_PACKAGE", "com.zhiliaoapp.musically")
        self.tiktok_apk_url: Optional[str] = os.getenv("TIKTOK_APK_URL", None)
        self.custom_apk_url: Optional[str] = self.tiktok_apk_url
        
        # Network / VPN / Proxy / Backend
        self.vpn_provider: str = os.getenv("VPN_PROVIDER", "none").lower() # none, nordvpn, pia
        self.vpn_token: Optional[str] = os.getenv("VPN_TOKEN", None)
        self.vpn_country: str = os.getenv("VPN_COUNTRY", "United_States")
        self.http_proxy: Optional[str] = os.getenv("HTTP_PROXY", None)
        self.backend_url: str = (os.getenv("TIKTOK_BOOSTER_BACKEND_URL") or os.getenv("FGOS_BACKEND_URL") or "https://api.fgos.site/tiktok").rstrip('/')
        self.require_api_level: int = int(os.getenv("REQUIRE_API_LEVEL", "34"))
        self.session_uuid: str = os.getenv("SESSION_UUID", "")

    @classmethod
    def from_args_and_env(cls) -> "AppConfig":
        """Parses command line arguments and merges them with environment variables."""
        parser = argparse.ArgumentParser(description="TikTok Mobile App Live Stream Multi-Viewer & Auto-Liker")
        
        parser.add_argument("--stream-url", type=str, help="Target TikTok Live URL (e.g. https://www.tiktok.com/@username/live)")
        parser.add_argument("--stream-user", type=str, help="Target TikTok username (e.g. @username)")
        parser.add_argument("--room-id", type=str, help="Direct TikTok Live Room ID")
        parser.add_argument("--duration", type=int, default=None, help="Duration to watch in minutes (default: 60)")
        parser.add_argument("--likes-per-min", type=int, default=None, help="Target likes per minute (default: 120)")
        parser.add_argument("--runner-index", type=int, default=None, help="Index of this runner in matrix (0, 1, 2...)")
        parser.add_argument("--batch-size", type=int, default=None, help="Number of accounts to handle per runner (default: 1)")
        parser.add_argument("--sheet-id", type=str, help="Google Sheet ID")
        parser.add_argument("--sheet-csv-url", type=str, help="Published Google Sheet CSV export URL")
        parser.add_argument("--device-id", type=str, help="ADB Device ID / Serial")
        parser.add_argument("--backend-url", type=str, help="TikTok Booster Central Backend API Base URL")
        
        args, _ = parser.parse_known_args()
        
        config = cls()
        if args.backend_url:
            config.backend_url = args.backend_url.rstrip('/')
        if args.stream_url:
            config.stream_url = args.stream_url
        if args.stream_user:
            config.stream_user = args.stream_user
        if args.room_id:
            config.room_id = args.room_id
        if args.duration is not None:
            config.duration_minutes = args.duration
        if args.likes_per_min is not None:
            config.likes_per_minute = args.likes_per_min
        if args.runner_index is not None:
            config.runner_index = args.runner_index
            config.runner_id = f"runner-{config.runner_index}"
        if args.batch_size is not None:
            config.batch_size = args.batch_size
        if args.sheet_id:
            config.google_sheet_id = args.sheet_id
        if args.sheet_csv_url:
            config.google_sheet_csv_url = args.sheet_csv_url
        if args.device_id:
            config.adb_device_id = args.device_id
            
        return config

config = AppConfig.from_args_and_env()
