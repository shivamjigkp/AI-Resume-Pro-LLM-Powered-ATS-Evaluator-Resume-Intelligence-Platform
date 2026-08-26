"""
gate1/google_auth.py
────────────────────
Shared Google OAuth2 helper for Gate 1 (Gmail send/draft + Sheets read/write).

One login covers both Gmail and Sheets, since both scopes are requested together.
Credentials are cached locally in token.json (gitignored) so the user only has
to complete the browser consent flow once, until the token is revoked/expired
without a refresh token.

SETUP (one-time, per user):
  1. Go to https://console.cloud.google.com/apis/credentials
  2. Create an OAuth 2.0 Client ID of type "Desktop app".
  3. Download the JSON and save it as credentials.json in the project root
     (same folder as server.py).
  4. Enable the Gmail API and Google Sheets API for that project.
  5. On first Gate 1 run, a browser window will open asking you to sign in
     and approve access — this creates token.json automatically.
"""
import os
import logging
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

logger = logging.getLogger("Gate1.GoogleAuth")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(BASE_DIR, "token.json")
CREDENTIALS_PATH = os.path.join(BASE_DIR, "credentials.json")

# Combined scopes needed for Gate 1: composing/sending Gmail + reading/writing the lead sheet + creating new sheets in Drive.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]


class MissingCredentialsError(Exception):
    """Raised when credentials.json has not been set up yet."""
    pass


def get_credentials() -> Credentials:
    """
    Returns valid Google OAuth credentials, refreshing or re-authenticating as needed.
    Raises MissingCredentialsError with a clear setup message if credentials.json is absent.
    """
    creds = None

    if os.path.exists(TOKEN_PATH):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
        except Exception as e:
            logger.warning(f"token.json unreadable/corrupted, will re-authenticate: {e}")
            creds = None

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(creds)
            return creds
        except Exception as e:
            logger.warning(f"Token refresh failed, will re-authenticate from scratch: {e}")
            creds = None

    # Full interactive re-auth needed
    if not os.path.exists(CREDENTIALS_PATH):
        raise MissingCredentialsError(
            "credentials.json not found in project root. Download an OAuth Desktop "
            "Client ID from Google Cloud Console (APIs & Services → Credentials), "
            "enable the Gmail API and Google Sheets API, and place the file as "
            "'credentials.json' next to server.py. See gate1/google_auth.py for full steps."
        )

    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
    creds = flow.run_local_server(port=0)
    _save_token(creds)
    return creds


def _save_token(creds: Credentials):
    try:
        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())
    except Exception as e:
        logger.error(f"Could not cache token.json: {e}")
