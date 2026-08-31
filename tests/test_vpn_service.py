import unittest
import os
from unittest.mock import MagicMock, patch
from src.config import AppConfig
from src.vpn_service import VPNService

class TestVPNService(unittest.TestCase):
    def setUp(self):
        self.config = AppConfig()
        self.config.vpn_provider = "pia"
        self.config.vpn_country = "us"
        self.config.openvpn_config_dir = "/tmp/test_pia_configs"
        self.config.openvpn_auth_file = "/tmp/test_pia_auth.txt"
        self.vpn = VPNService(self.config)

    def test_country_filtering_normalization(self):
        # Mock available configs list
        self.vpn.available_configs = [
            "/tmp/test_pia_configs/us_california.ovpn",
            "/tmp/test_pia_configs/us_chicago.ovpn",
            "/tmp/test_pia_configs/us_texas.ovpn",
            "/tmp/test_pia_configs/uk_london.ovpn",
            "/tmp/test_pia_configs/de_berlin.ovpn",
            "/tmp/test_pia_configs/ca_toronto.ovpn",
        ]

        # Test US prefix
        us_configs = self.vpn._country_filtered_configs("us")
        self.assertEqual(len(us_configs), 3)
        self.assertTrue(all("us_" in c for c in us_configs))

        # Test region broadening (e.g. us_california -> us)
        broad_us = self.vpn._country_filtered_configs("us_california")
        self.assertEqual(len(broad_us), 3)

        # Test UK prefix
        uk_configs = self.vpn._country_filtered_configs("uk")
        self.assertEqual(len(uk_configs), 1)
        self.assertEqual(os.path.basename(uk_configs[0]), "uk_london.ovpn")

        # Test fallback on empty/none
        all_configs = self.vpn._country_filtered_configs("")
        self.assertEqual(len(all_configs), 6)

    def test_initialization_disabled(self):
        self.config.vpn_provider = "none"
        vpn = VPNService(self.config)
        with patch.object(vpn, 'get_current_ip_info', return_value={"ip": "1.2.3.4"}):
            self.assertTrue(vpn.setup_vpn())

if __name__ == "__main__":
    unittest.main()
