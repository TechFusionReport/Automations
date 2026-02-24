import os
import logging
import json
import asyncio
import aiohttp
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import List, Dict, Optional
import yaml

import googleapiclient.discovery
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import google_auth_oauthlib.flow

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────
@dataclass
class Config:
    notion_token: str
    notion_database_id: str                  # Content Catalog v2 collection ID
    content_creators_database_id: str        # Content Creators database ID (for relation linking)
    notion_version: str
    youtube_client_secrets_file: str
    channel_config_file: str                 # JSON file: [{"channel_id": "UC...", "name": "..."}, ...]
    lookback_days: int = 3                   # How many days back to check for new videos

    @classmethod
    def from_yaml(cls, path: str) -> "Config":
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls(**data)

    @classmethod
    def from_env(cls) -> "Config":
        """Load config from environment variables (used in GitHub Actions)."""
        return cls(
            notion_token=os.environ["NOTION_TOKEN"],
            notion_database_id=os.environ["NOTION_DATABASE_ID"],
            content_creators_database_id=os.environ["CONTENT_CREATORS_DATABASE_ID"],
            notion_version=os.environ.get("NOTION_VERSION", "2022-06-28"),
            youtube_client_secrets_file=os.environ.get("YOUTUBE_CLIENT_SECRETS", "client_secrets.json"),
            channel_config_file=os.environ.get("CHANNEL_CONFIG", "channels.json"),
            lookback_days=int(os.environ.get("LOOKBACK_DAYS", "3")),
        )

# ─────────────────────────────────────────────
# Channel Config Loader
# ─────────────────────────────────────────────
def load_channels(path: str) -> List[Dict]:
    """
    Load channels from a JSON file.
    Expected format:
    [
      {"channel_id": "UCxxxxxx", "name": "Hayls World"},
      {"channel_id": "UCxxxxxx", "name": "Mrwhosetheboss"},
      ...
    ]
    """
    with open(path) as f:
        channels = json.load(f)
    logger.info(f"Loaded {len(channels)} channels from {path}")
    return channels

# ─────────────────────────────────────────────
# YouTube Service
# ─────────────────────────────────────────────
class YouTubeService:
    def __init__(self, client_secrets_file: str):
        self.youtube = self._authenticate(client_secrets_file)

    def _authenticate(self, client_secrets_file: str):
        credentials = None
        token_path = "token.json"

        # Try loading saved token
        if os.path.exists(token_path):
            credentials = Credentials.from_authorized_user_file(
                token_path,
                ["https://www.googleapis.com/auth/youtube.readonly"]
            )

        # Refresh or re-authenticate if needed
        if not credentials or not credentials.valid:
            if credentials and credentials.expired and credentials.refresh_token:
                credentials.refresh(Request())
            else:
                # GitHub Actions: use API key instead of OAuth
                api_key = os.environ.get("YOUTUBE_API_KEY")
                if api_key:
                    return googleapiclient.discovery.build(
                        "youtube", "v3", developerKey=api_key
                    )
                flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
                    client_secrets_file,
                    ["https://www.googleapis.com/auth/youtube.readonly"]
                )
                credentials = flow.run_console()

            with open(token_path, "w") as f:
                f.write(credentials.to_json())

        return googleapiclient.discovery.build("youtube", "v3", credentials=credentials)

    def get_recent_videos(self, channel_id: str, lookback_days: int) -> List[Dict]:
        """Get videos published in the last N days for a channel."""
        published_after = (
            datetime.now(timezone.utc) - timedelta(days=lookback_days)
        ).isoformat()

        videos = []
        page_token = None

        try:
            while True:
                response = self.youtube.search().list(
                    part="id,snippet",
                    channelId=channel_id,
                    type="video",
                    order="date",
                    publishedAfter=published_after,
                    maxResults=50,
                    pageToken=page_token
                ).execute()

                for item in response.get("items", []):
                    if item["id"].get("kind") != "youtube#video":
                        continue
                    video_id = item["id"]["videoId"]
                    snippet = item["snippet"]
                    videos.append({
                        "video_id": video_id,
                        "video_url": f"https://youtube.com/watch?v={video_id}",
                        "title": snippet.get("title", ""),
                        "published_at": snippet.get("publishedAt", ""),
                        "thumbnail": (
                            snippet.get("thumbnails", {})
                            .get("high", {})
                            .get("url", "")
                        ),
                    })

                page_token = response.get("nextPageToken")
                if not page_token:
                    break

        except Exception as e:
            logger.error(f"Error fetching videos for channel {channel_id}: {e}")

        return videos

# ─────────────────────────────────────────────
# Notion Service
# ─────────────────────────────────────────────
class NotionService:
    NOTION_API = "https://api.notion.com/v1"

    def __init__(self, config: Config):
        self.database_id = config.notion_database_id
        self.creators_database_id = config.content_creators_database_id
        self.headers = {
            "Authorization": f"Bearer {config.notion_token}",
            "Content-Type": "application/json",
            "Notion-Version": config.notion_version,
        }
        self.session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(headers=self.headers)
        return self

    async def __aexit__(self, *args):
        if self.session:
            await self.session.close()

    async def video_exists(self, video_id: str) -> bool:
        """Check if a video ID already exists in the database to avoid duplicates."""
        payload = {
            "filter": {
                "property": "Video ID",
                "rich_text": {"equals": video_id}
            }
        }
        async with self.session.post(
            f"{self.NOTION_API}/databases/{self.database_id}/query",
            json=payload
        ) as resp:
            data = await resp.json()
            return len(data.get("results", [])) > 0

    async def create_lead(self, video: Dict, channel_id: str, channel_name: str) -> Optional[str]:
        """
        Create a new lead entry in Content Catalog v2.
        Returns the new Notion page ID on success, or None on failure.
        Maps to the exact field names in the database schema.
        """
        # Parse published date
        published_date = ""
        if video.get("published_at"):
            try:
                published_date = datetime.fromisoformat(
                    video["published_at"].replace("Z", "+00:00")
                ).strftime("%Y-%m-%d")
            except Exception:
                published_date = ""

        payload = {
            "parent": {"database_id": self.database_id},
            "properties": {
                # Title field (required)
                "Title": {
                    "title": [{"text": {"content": video["title"]}}]
                },
                # Video ID (text)
                "Video ID": {
                    "rich_text": [{"text": {"content": video["video_id"]}}]
                },
                # Video URL
                "Video URL": {
                    "url": video["video_url"]
                },
                # Channel ID — stores raw UC... value as text for relation lookup
                # Also written to the multi-select "Channel ID" field using channel name
                "Channel ID": {
                    "rich_text": [{"text": {"content": channel_id}}]
                },
                # Published Date (note: field has a typo "Puiblished Date" in Notion)
                "Puiblished Date": {
                    "date": {"start": published_date} if published_date else None
                },
                # Thumbnail URL
                "Thumbnail": {
                    "url": video["thumbnail"] if video.get("thumbnail") else None
                },
                # Status — set to Pending Review so it appears in your leads view
                "Status": {
                    "status": {"name": "🟡 Pending Review"}
                },
                # Transcription checkbox — starts unchecked
                "Approved for Transcription?": {
                    "checkbox": False
                },
            }
        }

        # Remove None date if empty
        if not published_date:
            del payload["properties"]["Puiblished Date"]

        # Remove None thumbnail if empty
        if not video.get("thumbnail"):
            del payload["properties"]["Thumbnail"]

        try:
            async with self.session.post(
                f"{self.NOTION_API}/pages",
                json=payload
            ) as resp:
                data = await resp.json()
                if resp.status == 200:
                    return data["id"]
                else:
                    logger.error(f"Notion error for {video['video_id']}: {data}")
                    return None
        except Exception as e:
            logger.error(f"Failed to create lead for {video['video_id']}: {e}")
            return None

    # ─────────────────────────────────────────────
    # Creator Relation Linking
    # ─────────────────────────────────────────────

    async def find_creator_page_id(self, channel_id: str) -> Optional[str]:
        """
        Query the Content Creators database for the page whose 'Channel ID'
        text property exactly matches the given UC... channel_id.

        Returns the creator page ID if exactly one match is found.
        Returns None and logs a warning if no match is found.
        Raises RuntimeError if multiple matches are found (data integrity issue).
        """
        payload = {
            "filter": {
                "property": "Channel ID",
                "rich_text": {"equals": channel_id}
            }
        }
        try:
            async with self.session.post(
                f"{self.NOTION_API}/databases/{self.creators_database_id}/query",
                json=payload
            ) as resp:
                data = await resp.json()

            results = data.get("results", [])

            if len(results) == 0:
                logger.warning(
                    f"No creator found in Content Creators for channel_id='{channel_id}'. "
                    "The 'Channel / Creator Name' relation will not be set for this page."
                )
                return None

            if len(results) > 1:
                page_ids = [r["id"] for r in results]
                raise RuntimeError(
                    f"Duplicate creator records found for channel_id='{channel_id}'. "
                    f"Matching page IDs: {page_ids}. "
                    "Fix duplicates in Content Creators before re-running."
                )

            creator_page_id = results[0]["id"]
            logger.info(f"  Matched creator page {creator_page_id} for channel {channel_id}")
            return creator_page_id

        except RuntimeError:
            raise
        except Exception as e:
            logger.error(f"Error querying Content Creators for {channel_id}: {e}")
            return None

    async def link_creator_relation(
        self, catalog_page_id: str, creator_page_id: str, channel_id: str
    ) -> bool:
        """
        PATCH the Content Catalog page to set the 'Channel / Creator Name'
        relation property to the given creator page.

        Idempotent: reads current relation first and skips the write if it already
        points to the correct creator page.
        """
        # --- idempotency check: read current relation value ---
        try:
            async with self.session.get(
                f"{self.NOTION_API}/pages/{catalog_page_id}"
            ) as resp:
                page_data = await resp.json()

            current_relation = (
                page_data.get("properties", {})
                .get("Channel / Creator Name", {})
                .get("relation", [])
            )
            current_ids = {r["id"] for r in current_relation}

            if creator_page_id in current_ids and len(current_ids) == 1:
                logger.info(
                    f"  Relation already correct for page {catalog_page_id}, skipping write."
                )
                return True
        except Exception as e:
            logger.warning(f"Could not read current relation for {catalog_page_id}: {e}. Will proceed with write.")

        # --- write the relation ---
        payload = {
            "properties": {
                "Channel / Creator Name": {
                    "relation": [{"id": creator_page_id}]
                }
            }
        }
        try:
            async with self.session.patch(
                f"{self.NOTION_API}/pages/{catalog_page_id}",
                json=payload
            ) as resp:
                if resp.status == 200:
                    logger.info(
                        f"  ✅ Linked creator relation on page {catalog_page_id} "
                        f"→ creator {creator_page_id}"
                    )
                    return True
                else:
                    error = await resp.json()
                    logger.error(
                        f"  Failed to set relation on {catalog_page_id}: {error}"
                    )
                    return False
        except Exception as e:
            logger.error(f"  Exception setting relation on {catalog_page_id}: {e}")
            return False

# ─────────────────────────────────────────────
# Main Pipeline
# ─────────────────────────────────────────────
async def process_channel(
    youtube: YouTubeService,
    notion: NotionService,
    channel: Dict,
    lookback_days: int
):
    channel_id   = channel["channel_id"]
    channel_name = channel["name"]

    logger.info(f"Processing channel: {channel_name} ({channel_id})")
    videos = youtube.get_recent_videos(channel_id, lookback_days)
    logger.info(f"  Found {len(videos)} recent videos")

    # Resolve creator page once per channel (not per video) to save API calls
    try:
        creator_page_id = await notion.find_creator_page_id(channel_id)
    except RuntimeError as e:
        # Duplicate creators = data integrity error — skip entire channel
        logger.error(f"  Skipping channel {channel_name}: {e}")
        return 0

    new_count = 0
    for video in videos:
        # Skip duplicates
        if await notion.video_exists(video["video_id"]):
            logger.info(f"  Skipping duplicate: {video['title']}")
            continue

        catalog_page_id = await notion.create_lead(video, channel_id, channel_name)
        if catalog_page_id:
            new_count += 1
            logger.info(f"  ✅ Added: {video['title']}")

            # Link to Content Creators relation (gives Notion the rollup data)
            if creator_page_id:
                await notion.link_creator_relation(catalog_page_id, creator_page_id, channel_id)
            else:
                logger.warning(
                    f"  ⚠️  No creator relation set for '{video['title']}' "
                    f"(channel_id={channel_id} not found in Content Creators)"
                )
        else:
            logger.warning(f"  ❌ Failed: {video['title']}")

    logger.info(f"  Added {new_count} new leads from {channel_name}")
    return new_count


async def main():
    # Load config — prefers environment variables (GitHub Actions),
    # falls back to config.yaml for local runs
    try:
        config = Config.from_env()
    except KeyError:
        config = Config.from_yaml("config.yaml")

    channels = load_channels(config.channel_config_file)
    youtube = YouTubeService(config.youtube_client_secrets_file)

    total_new = 0
    async with NotionService(config) as notion:
        # Process all channels concurrently (batched to avoid rate limits)
        batch_size = 10
        for i in range(0, len(channels), batch_size):
            batch = channels[i:i + batch_size]
            results = await asyncio.gather(
                *[
                    process_channel(youtube, notion, ch, config.lookback_days)
                    for ch in batch
                ]
            )
            total_new += sum(results)
            # Small delay between batches to respect API limits
            if i + batch_size < len(channels):
                await asyncio.sleep(1)

    logger.info(f"✅ Done. Total new leads added: {total_new}")


if __name__ == "__main__":
    asyncio.run(main())
