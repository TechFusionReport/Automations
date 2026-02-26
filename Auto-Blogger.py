import os
import logging
import json
import asyncio
import aiohttp
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import List, Dict, Optional
import yaml

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
    notion_database_id: str
    content_creators_database_id: str
    notion_version: str
    channel_config_file: str
    lookback_days: int = 3

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            notion_token=os.environ["NOTION_TOKEN"],
            notion_database_id=os.environ["NOTION_DATABASE_ID"],
            content_creators_database_id=os.environ["CONTENT_CREATORS_DATABASE_ID"],
            notion_version=os.environ.get("NOTION_VERSION", "2022-06-28"),
            channel_config_file=os.environ.get("CHANNEL_CONFIG", "channels.json"),
            lookback_days=int(os.environ.get("LOOKBACK_DAYS", "3")),
        )

    @classmethod
    def from_yaml(cls, path: str) -> "Config":
        with open(path) as f:
            data = yaml.safe_load(f)
        # Remove youtube-specific keys if present
        data.pop("youtube_client_secrets_file", None)
        return cls(**data)


# ─────────────────────────────────────────────
# Channel Config Loader
# ─────────────────────────────────────────────
def load_channels(path: str) -> List[Dict]:
    with open(path) as f:
        channels = json.load(f)
    logger.info(f"Loaded {len(channels)} channels from {path}")
    return channels


# ─────────────────────────────────────────────
# RSS YouTube Service (Zero quota cost!)
# ─────────────────────────────────────────────
class YouTubeRSSService:
    """
    Fetches recent videos via YouTube's public RSS feeds.
    Cost: 0 API quota units per channel (completely free, no API key needed).
    RSS feeds return the 15 most recent videos for any channel.
    """
    RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    NS = {"yt": "http://www.youtube.com/xml/schemas/2015",
          "media": "http://search.yahoo.com/mrss/",
          "atom": "http://www.w3.org/2005/Atom"}

    async def get_recent_videos(
        self,
        session: aiohttp.ClientSession,
        channel_id: str,
        lookback_days: int
    ) -> List[Dict]:
        url = self.RSS_BASE.format(channel_id=channel_id)
        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.warning(f"  RSS returned HTTP {resp.status} for channel {channel_id}")
                    return []
                text = await resp.text()
        except Exception as e:
            logger.error(f"  Failed to fetch RSS for channel {channel_id}: {e}")
            return []

        try:
            root = ET.fromstring(text)
        except ET.ParseError as e:
            logger.error(f"  Failed to parse RSS XML for channel {channel_id}: {e}")
            return []

        videos = []
        for entry in root.findall("atom:entry", self.NS):
            try:
                video_id_el = entry.find("yt:videoId", self.NS)
                title_el = entry.find("atom:title", self.NS)
                published_el = entry.find("atom:published", self.NS)
                thumbnail_el = entry.find(".//media:thumbnail", self.NS)

                if video_id_el is None or title_el is None or published_el is None:
                    continue

                video_id = video_id_el.text.strip()
                title = title_el.text.strip()
                published_str = published_el.text.strip()

                # Parse published date and filter by lookback window
                published_at = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
                if published_at < cutoff:
                    continue

                thumbnail = thumbnail_el.attrib.get("url", "") if thumbnail_el is not None else ""

                videos.append({
                    "video_id": video_id,
                    "video_url": f"https://youtube.com/watch?v={video_id}",
                    "title": title,
                    "published_at": published_str,
                    "thumbnail": thumbnail,
                })
            except Exception as e:
                logger.warning(f"  Skipping malformed RSS entry: {e}")
                continue

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
                "Title": {
                    "title": [{"text": {"content": video["title"]}}]
                },
                "Video ID": {
                    "rich_text": [{"text": {"content": video["video_id"]}}]
                },
                "Video URL": {
                    "url": video["video_url"]
                },
                "Channel ID": {
                    "rich_text": [{"text": {"content": channel_id}}]
                },
                "Status": {
                    "status": {"name": "🟡 Pending Review"}
                },
                "Approved for Transcription?": {
                    "checkbox": False
                },
            }
        }

        if published_date:
            payload["properties"]["Puiblished Date"] = {
                "date": {"start": published_date}
            }

        if video.get("thumbnail"):
            payload["properties"]["Thumbnail"] = {
                "url": video["thumbnail"]
            }

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

    async def find_creator_page_id(self, channel_id: str) -> Optional[str]:
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
                logger.warning(f"  No creator found for channel_id='{channel_id}'")
                return None

            if len(results) > 1:
                page_ids = [r["id"] for r in results]
                raise RuntimeError(
                    f"Duplicate creator records for channel_id='{channel_id}'. "
                    f"Page IDs: {page_ids}. Fix duplicates in Content Creators."
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
        self, catalog_page_id: str, creator_page_id: str
    ) -> bool:
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
                    logger.info(f"  ✅ Linked creator relation on page {catalog_page_id}")
                    return True
                else:
                    error = await resp.json()
                    logger.error(f"  Failed to set relation on {catalog_page_id}: {error}")
                    return False
        except Exception as e:
            logger.error(f"  Exception setting relation on {catalog_page_id}: {e}")
            return False


# ─────────────────────────────────────────────
# Main Pipeline
# ─────────────────────────────────────────────
async def process_channel(
    rss_service: YouTubeRSSService,
    rss_session: aiohttp.ClientSession,
    notion: NotionService,
    channel: Dict,
    lookback_days: int
):
    channel_id = channel["channel_id"]
    channel_name = channel["name"]

    logger.info(f"Processing channel: {channel_name} ({channel_id})")
    videos = await rss_service.get_recent_videos(rss_session, channel_id, lookback_days)
    logger.info(f"  Found {len(videos)} recent videos")

    # Resolve creator page once per channel
    try:
        creator_page_id = await notion.find_creator_page_id(channel_id)
    except RuntimeError as e:
        logger.error(f"  Skipping channel {channel_name}: {e}")
        return 0

    new_count = 0
    for video in videos:
        if await notion.video_exists(video["video_id"]):
            logger.info(f"  Skipping duplicate: {video['title']}")
            continue

        catalog_page_id = await notion.create_lead(video, channel_id, channel_name)
        if catalog_page_id:
            new_count += 1
            logger.info(f"  ✅ Added: {video['title']}")

            if creator_page_id:
                await notion.link_creator_relation(catalog_page_id, creator_page_id)
            else:
                logger.warning(
                    f"  ⚠️  No creator relation set for '{video['title']}' "
                    f"(channel_id={channel_id} not found in Content Creators)"
                )
        else:
            logger.warning(f"  ❌ Failed to add: {video['title']}")

    logger.info(f"  Added {new_count} new leads from {channel_name}")
    return new_count


async def main():
    try:
        config = Config.from_env()
    except KeyError:
        config = Config.from_yaml("config.yaml")

    channels = load_channels(config.channel_config_file)
    rss_service = YouTubeRSSService()

    total_new = 0

    # Shared HTTP session for RSS fetching (no auth needed)
    async with aiohttp.ClientSession() as rss_session:
        async with NotionService(config) as notion:
            # Process all channels concurrently in batches
            batch_size = 10
            for i in range(0, len(channels), batch_size):
                batch = channels[i:i + batch_size]
                results = await asyncio.gather(
                    *[
                        process_channel(rss_service, rss_session, notion, ch, config.lookback_days)
                        for ch in batch
                    ]
                )
                total_new += sum(results)
                if i + batch_size < len(channels):
                    await asyncio.sleep(0.5)  # Small pause between batches

    logger.info(f"✅ Done. Total new leads added: {total_new}")


if __name__ == "__main__":
    asyncio.run(main())
