import os
import logging
import subprocess
import time
from typing import Optional
from src.config import AppConfig

logger = logging.getLogger("VPNService")

class VPNService:
    """Manages VPN connections on GitHub Actions runners (NordVPN CLI, PIA WireGuard/OpenVPN)."""

    def __init__(self, config: AppConfig):
        self.config = config
        self.provider = config.vpn_provider.lower()
        self.token = config.vpn_token
        self.country = config.vpn_country

    def setup_vpn(self) -> bool:
        """Initializes and connects to the specified VPN provider."""
        if self.provider == "none" or not self.provider:
            logger.info("VPN is disabled or set to 'none'. Using default runner network.")
            return True

        if self.provider == "nordvpn":
            return self._setup_nordvpn()
        elif self.provider == "pia":
            return self._setup_pia()
        else:
            logger.warning(f"Unknown VPN provider '{self.provider}'. Proceeding without VPN.")
            return False

    def _setup_nordvpn(self) -> bool:
        """Configures and connects via NordVPN CLI."""
        logger.info("Initializing NordVPN connection...")
        if not self.token:
            logger.error("NordVPN token is missing! Please provide VPN_TOKEN in secrets.")
            return False

        try:
            # Login with token
            logger.info("Logging into NordVPN...")
            subprocess.run(["nordvpn", "login", "--token", self.token], check=True)
            
            # Set technology and obfuscation if needed
            subprocess.run(["nordvpn", "set", "technology", "NordLynx"], check=False)
            
            # Connect to chosen country or best server
            target = self.country if self.country else "United_States"
            logger.info(f"Connecting to NordVPN server in {target}...")
            subprocess.run(["nordvpn", "connect", target], check=True)
            
            time.sleep(3)
            self._log_public_ip()
            return True
        except Exception as e:
            logger.error(f"NordVPN setup failed: {e}")
            return False

    def _setup_pia(self) -> bool:
        """Configures and connects via PIA (Private Internet Access) VPN."""
        logger.info("Initializing Private Internet Access (PIA) VPN...")
        try:
            # PIA CLI support
            subprocess.run(["piactl", "connect"], check=True)
            time.sleep(5)
            self._log_public_ip()
            return True
        except Exception as e:
            logger.error(f"PIA VPN setup failed: {e}")
            return False

    def _log_public_ip(self) -> None:
        """Fetches and logs the current external public IP."""
        try:
            import requests
            ip_info = requests.get("https://ipinfo.io/json", timeout=10).json()
            logger.info(f"Connected! Public IP: {ip_info.get('ip')} ({ip_info.get('city')}, {ip_info.get('country')})")
        except Exception as e:
            logger.warning(f"Could not verify public IP: {e}")

    def disconnect(self) -> None:
        """Gracefully disconnects VPN."""
        try:
            if self.provider == "nordvpn":
                subprocess.run(["nordvpn", "disconnect"], check=False)
            elif self.provider == "pia":
                subprocess.run(["piactl", "disconnect"], check=False)
            logger.info("VPN disconnected.")
        except Exception:
            pass
