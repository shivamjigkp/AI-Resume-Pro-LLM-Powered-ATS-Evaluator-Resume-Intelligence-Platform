import os
import json
import time
import logging
from typing import List, Dict, Optional
from dotenv import load_dotenv

# Set up logging with formatting (Prompt 2: no sensitive data logged)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("SystemConfig")

# Load base environment variables
load_dotenv()

# Global Path Constants
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SECRETS_FILE = os.path.join(BASE_DIR, "secrets.json")

# Safety measures config values
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID", "")
BASE_RESUME_PATH = os.getenv("BASE_RESUME_PATH", "resume/base_resume.docx")
OUTPUT_RESUMES_DIR = os.getenv("OUTPUT_RESUMES_DIR", "output_resumes")
EMAIL_DELAY_SECONDS = int(os.getenv("EMAIL_DELAY_SECONDS", 45))
AUTOFILL_WAIT_MS = int(os.getenv("AUTOFILL_WAIT_MS", 2000))

# Ensure output directories exist locally
os.makedirs(os.path.join(BASE_DIR, OUTPUT_RESUMES_DIR), exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "resume"), exist_ok=True)

class SmartAPIClient:
    """
    Manages API keys pools, rotation, and dynamic provider fallbacks
    without exposing any key value in logs or stdout (Prompt 1 / Prompt 2 compliance).
    """
    def __init__(self):
        self.secrets_data = self._load_secrets()
        # Cooldown state tracking {key_value: timestamp_blocked}
        self.cooldowns: Dict[str, float] = {}

    def _load_secrets(self) -> Dict:
        """Loads secrets.json safely, fallback to default schema if missing."""
        if os.path.exists(SECRETS_FILE):
            try:
                with open(SECRETS_FILE, "r") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Error reading secrets.json: {e}")
        
        # Return default empty structure
        return {
            "GLOBAL": {
                "gemini_keys": [],
                "groq_keys": [],
                "nvidia_keys": [],
                "openrouter_keys": [],
                "provider_priority": ["gemini", "groq", "free_ai"]
            },
            "SECTIONS": {}
        }

    def save_secrets(self, data: Dict) -> bool:
        """Saves updated configuration data back to local secrets.json safely."""
        try:
            with open(SECRETS_FILE, "w") as f:
                json.dump(data, f, indent=2)
            self.secrets_data = data
            logger.info("Local secrets.json updated successfully.")
            return True
        except Exception as e:
            logger.error(f"Failed to save secrets: {e}")
            return False

    def get_masked_key(self, key: str) -> str:
        """Returns masked key representation (e.g. AIzaSy...4aB) to protect privacy."""
        if not key or len(key) < 8:
            return "Invalid/Empty Key"
        return f"{key[:8]}...{key[-4:]}"

    def trigger_key_cooldown(self, key: str, minutes: int = 10):
        """Temporarily blocks a key from rotation for specified minutes (Rate limit)."""
        masked = self.get_masked_key(key)
        logger.warning(f"Key {masked} hit rate limit. Putting on cooldown for {minutes} mins.")
        self.cooldowns[key] = time.time() + (minutes * 60)

    def is_key_on_cooldown(self, key: str) -> bool:
        """Checks if a key is currently blocked."""
        if key not in self.cooldowns:
            return False
        if time.time() > self.cooldowns[key]:
            # Cooldown expired, remove from track
            del self.cooldowns[key]
            return False
        return True

    def get_active_keys(self, section: str, provider: str) -> List[str]:
        """
        Retrieves API keys for a specific provider, prioritizing section-specific keys
        first, then falling back to GLOBAL keys. Filters out keys currently on cooldown.
        """
        keys_pool = []
        
        # Check section specific overrides
        sections = self.secrets_data.get("SECTIONS", {})
        if section in sections:
            sect_data = sections[section]
            keys_pool = sect_data.get(f"{provider}_keys", [])

        # Fallback to GLOBAL pool if section pool is empty
        if not keys_pool:
            global_data = self.secrets_data.get("GLOBAL", {})
            keys_pool = global_data.get(f"{provider}_keys", [])

        # Filter out keys on cooldown
        active_keys = [k for k in keys_pool if not self.is_key_on_cooldown(k)]
        return active_keys

    def get_provider_priority(self, section: str) -> List[str]:
        """Gets priority order of models (e.g. ['gemini', 'groq', 'free_ai']) for a section."""
        sections = self.secrets_data.get("SECTIONS", {})
        if section in sections and "provider_priority" in sections[section]:
            return sections[section]["provider_priority"]
        
        return self.secrets_data.get("GLOBAL", {}).get("provider_priority", ["gemini", "groq", "free_ai"])

# Initialize Global Client Manager
secrets_client = SmartAPIClient()
