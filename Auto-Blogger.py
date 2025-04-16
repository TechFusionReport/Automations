import os
import logging
from typing import List, Dict, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass
import asyncio
import aiohttp
import google_auth_oauthlib.flow
import googleapiclient.discovery
import googleapiclient.errors
import yaml
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

@dataclass
class Config:
    """Configuration for the application"""
    notion_api_url: str
    notion_token: str
    notion_database_id: str
    notion_version: str
    youtube_client_secrets_file: str
    channel_config_file: str

    @classmethod
    def from_yaml(cls, file_path: str) -> 'Config':
        with open(file_path, 'r') as f:
            config_data = yaml.safe_load(f)
        return cls(**config_data)

class YouTubeService:
    "Handles YouTube API interactions"
    def __init__(self, client_secrets_file: str):
        self.client_secrets_file = client_secrets_file
        self.youtube = self._authenticate()

    def _authenticate(self):
        "Authenticate with YouTube API"
        try:
            credentials = None
            if os.path.exists('token.json'):
                credentials = Credentials.from_authorized_user_file('token.json', ['https://www.googleapis.com/auth/youtube.force-ssl'])
            
            if not credentials or not credentials.valid:
                if credentials and credentials.expired and credentials.refresh_token:
                    credentials.refresh(Request())
                else:
                    flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
                        self.client_secrets_file, ['https://www.googleapis.com/auth/youtube.force-ssl'])
                    credentials = flow.run_console()
                
                with open('token.json', 'w') as token:
                    token.write(credentials.to_json())

            return googleapiclient.discovery.build("youtube", "v3", credentials=credentials)
        except Exception as e:
            logger.error(f"Authentication failed: {e}")
            raise

    async def get_video_details(self, video_id: str) -> Dict:
        "Get video details from YouTube API"
        try:
            video_response = self.youtube.videos().list(
                part="snippet,statistics",
                id=video_id
            ).execute()

            if not video_response['items']:
                return {}

            video = video_response['items'][0]
            return {
                "videoId": video_id,
                "title": video['snippet']['title'],
                "channelId": video['snippet']['channelId'],
                "publishedAt": video['snippet']['publishedAt'],
                "viewCount": video['statistics'].get('viewCount', 'N/A'),
                "likeCount": video['statistics'].get('likeCount', 'N/A'),
                "commentCount": video['statistics'].get('commentCount', 'N/A')
            }
        except Exception as e:
            logger.error(f"Error getting video details for {video_id}: {e}")
            return {}

    async def get_video_transcript(self, video_id: str) -> str:
        "Get video transcript (placeholder function)"
        # Implement actual transcript retrieval logic here
        return f"Transcript for video {video_id}"

class NotionService:
    "Handles Notion API interactions"
    def __init__(self, config: Config):
        self.config = config
        self.session = None

    async def create_session(self):
        self.session = aiohttp.ClientSession(headers={
            "Authorization": f"Bearer {self.config.notion_token}",
            "Content-Type": "application/json",
            "Notion-Version": self.config.notion_version
        })

    async def close_session(self):
        if self.session:
            await self.session.close()

    async def create_page(self, video_info: Dict, transcript: str) -> bool:
        "Create a new page in Notion database with proper error handling"
        if not self.session:
            await self.create_session()

        try:
            payload = self._build_page_payload(video_info, transcript)
            async with self.session.post(f"{self.config.notion_api_url}/pages", json=payload) as response:
                response.raise_for_status()
            return True
        except aiohttp.ClientError as e:
            logger.error(f"Failed to create Notion page: {e}")
            return False

    def _build_page_payload(self, video_info: Dict, transcript: str) -> Dict:
        "Build the payload for Notion page creation"
        return {
            "parent": {"database_id": self.config.notion_database_id},
            "properties": {
                "Title": {"title": [{"text": {"content": video_info["title"]}}]},
                "Video ID": {"rich_text": [{"text": {"content": video_info["videoId"]}}]},
                "Channel ID": {"rich_text": [{"text": {"content": video_info["channelId"]}}]},
                "Published At": {"date": {"start": video_info["publishedAt"]}},
                "View Count": {"number": int(video_info["viewCount"]) if video_info["viewCount"] != "N/A" else 0},
                "Like Count": {"number": int(video_info["likeCount"]) if video_info["likeCount"] != "N/A" else 0},
                "Comment Count": {"number": int(video_info["commentCount"]) if video_info["commentCount"] != "N/A" else 0}
            },
            "children": [
                {
                    "object": "block",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [{"type": "text", "text": {"content": transcript}}]
                    }
                }
            ]
        }

async def process_video(youtube_service: YouTubeService, notion_service: NotionService, video_id: str):
    "Process a single video"
    video_info = await youtube_service.get_video_details(video_id)
    if not video_info:
        logger.warning(f"No information found for video: {video_id}")
        r eturn

    transcript = await youtube_service.get_video_transcript(video_id)
    if await notion_service.create_page(video_info, transcript):
        logger.info(f"Successfully processed video: {video_id}")
    else:
        logger.error(f"Failed to process video: {video_id}")

async def process_channel(youtube_service: YouTubeService, notion_service: NotionService, channel_id: str):
    "Process videos for a single channel"
    try:
        page_token = None
        while True:
            videos_response = youtube_service.youtube.search().list(
                part="id,snippet",
                channelId=channel_id,
                order="date",
                publishedAfter=(datetime.now() - timedelta(days=7)).isoformat() + "Z",
                pageToken=page_token,
                maxResults=50
            ).execute()

            tasks = [process_video(youtube_service, notion_service, item['id']['videoId']) 
                     for item in videos_response['items']]
            await asyncio.gather(*tasks)

            page_token = videos_response.get('nextPageToken')
            if not page_token:
                break
    except Exception as e:
        logger.error(f"Error processing channel {channel_id}: {e}")

async def main():
    try:
        config = Config.from_yaml('config.yaml')
        youtube_service = YouTubeService(config.youtube_client_secrets_file)
        notion_service = NotionService(config)

        with open(config.channel_config_file, 'r') as f:
            channel_ids = [line.strip() for line in f.readlines()]

        await notion_service.create_session()

        tasks = [process_channel(youtube_service, notion_service, channel_id) for channel_id in channel_ids]
        await asyncio.gather(*tasks)

    except Exception as e:
        logger.error(f"Application error: {e}")
    finally:
        await notion_service.close_session()

if __name__ == "__main__":
    asyncio.run(main())