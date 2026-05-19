"""Bilibili 视频/音频下载器 - 使用 yt-dlp"""
import os
import json
import logging
import tempfile
from typing import Optional, List

import httpx

from services.cookie_manager import CookieConfigManager
from utils.url_parser import extract_video_id
from downloaders.bilibili_subtitle import BilibiliSubtitleFetcher, SubtitleResult

logger = logging.getLogger(__name__)


class AudioDownloadResult:
    """音频下载结果"""
    def __init__(
        self,
        file_path: str,
        title: str = "",
        duration: float = 0,
        cover_url: str = "",
        platform: str = "",
        video_id: str = "",
        raw_info: dict = None,
        video_path: Optional[str] = None
    ):
        self.file_path = file_path
        self.title = title
        self.duration = duration
        self.cover_url = cover_url
        self.platform = platform
        self.video_id = video_id
        self.raw_info = raw_info or {}
        self.video_path = video_path


class BilibiliDownloader:
    """Bilibili 视频/音频下载器"""

    def __init__(self):
        self._cookie_mgr = CookieConfigManager()
        self._cookie = self._cookie_mgr.get('bilibili')
        self._cookiefile = self._write_netscape_cookie_file()

    def _write_netscape_cookie_file(self) -> Optional[str]:
        """将 Cookie 写入 Netscape 格式临时文件，返回文件路径（供 yt-dlp cookiefile 使用）"""
        if not self._cookie:
            logger.warning("B站 Cookie 未配置，下载可能失败")
            return None
        lines = ["# Netscape HTTP Cookie File\n"]
        for pair in self._cookie.split("; "):
            if "=" in pair:
                key, value = pair.split("=", 1)
                lines.append(f".bilibili.com\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8')
        tmp.writelines(lines)
        tmp.close()
        logger.info("已生成 B站 Netscape Cookie 文件: %s (条目: %d)", tmp.name, len(lines) - 1)
        return tmp.name

    def download_audio(
        self,
        video_url: str,
        output_dir: Optional[str] = None,
        quality: str = "fast"
    ) -> AudioDownloadResult:
        """
        下载音频

        :param video_url: 视频链接
        :param output_dir: 输出目录
        :param quality: 音频质量 fast/medium/slow
        :return: AudioDownloadResult
        """
        try:
            import yt_dlp
        except ImportError:
            raise ImportError("请先安装 yt-dlp: pip install yt-dlp")

        if output_dir is None:
            output_dir = "data/audio"
        os.makedirs(output_dir, exist_ok=True)

        output_path = os.path.join(output_dir, "%(id)s.%(ext)s")

        # 质量映射
        quality_map = {"fast": "32", "medium": "64", "slow": "128"}
        audio_quality = quality_map.get(quality, "64")

        ydl_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio/best',
            'outtmpl': output_path,
            'http_headers': {'Referer': 'https://www.bilibili.com'},
            'postprocessors': [
                {
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': audio_quality,
                }
            ],
            'noplaylist': True,
            'quiet': False,
        }
        if self._cookiefile:
            ydl_opts['cookiefile'] = self._cookiefile

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
            video_id = info.get("id")
            title = info.get("title")
            duration = info.get("duration", 0)
            cover_url = info.get("thumbnail")
            audio_path = os.path.join(output_dir, f"{video_id}.mp3")

        return AudioDownloadResult(
            file_path=audio_path,
            title=title,
            duration=duration,
            cover_url=cover_url,
            platform="bilibili",
            video_id=video_id,
            raw_info=info,
            video_path=None
        )

    def download_video(
        self,
        video_url: str,
        output_dir: Optional[str] = None,
    ) -> str:
        """
        下载视频，返回视频文件路径
        """
        try:
            import yt_dlp
        except ImportError:
            raise ImportError("请先安装 yt-dlp: pip install yt-dlp")

        if output_dir is None:
            output_dir = "data/video"
        os.makedirs(output_dir, exist_ok=True)

        video_id = extract_video_id(video_url, "bilibili")
        video_path = os.path.join(output_dir, f"{video_id}.mp4")
        if os.path.exists(video_path):
            return video_path

        output_path = os.path.join(output_dir, "%(id)s.%(ext)s")

        ydl_opts = {
            'format': 'bv*[ext=mp4]/bestvideo+bestaudio/best',
            'outtmpl': output_path,
            'http_headers': {'Referer': 'https://www.bilibili.com'},
            'noplaylist': True,
            'quiet': False,
            'merge_output_format': 'mp4',
        }
        if self._cookiefile:
            ydl_opts['cookiefile'] = self._cookiefile

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
            video_id = info.get("id")
            video_path = os.path.join(output_dir, f"{video_id}.mp4")

        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件未找到: {video_path}")

        return video_path

    def download_subtitles(self, video_url: str) -> Optional[SubtitleResult]:
        """
        获取 B 站视频字幕（优先使用官方 API）

        :param video_url: 视频链接
        :return: SubtitleResult 或 None
        """
        # 优先走 B 站官方 player API
        try:
            result = BilibiliSubtitleFetcher().fetch_subtitles(video_url)
            if result and result.segments:
                return result
        except Exception as e:
            logger.warning(f"player API 直拉字幕异常: {e}")

        return None

    def get_video_info(self, video_url: str) -> dict:
        """
        获取视频信息（不下载）

        :param video_url: 视频链接
        :return: 视频信息字典
        """
        try:
            import yt_dlp
        except ImportError:
            raise ImportError("请先安装 yt-dlp: pip install yt-dlp")

        ydl_opts = {
            'quiet': True,
            'skip_download': True,
        }
        if self._cookiefile:
            ydl_opts['cookiefile'] = self._cookiefile

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            return {
                'id': info.get('id'),
                'title': info.get('title'),
                'description': info.get('description'),
                'duration': info.get('duration'),
                'thumbnail': info.get('thumbnail'),
                'uploader': info.get('uploader'),
                'view_count': info.get('view_count'),
                'like_count': info.get('like_count'),
            }


# 便捷函数
def download_bilibili_audio(video_url: str, output_dir: str = None, quality: str = "fast") -> AudioDownloadResult:
    """下载 Bilibili 音频"""
    downloader = BilibiliDownloader()
    return downloader.download_audio(video_url, output_dir, quality)


def download_bilibili_video(video_url: str, output_dir: str = None) -> str:
    """下载 Bilibili 视频"""
    downloader = BilibiliDownloader()
    return downloader.download_video(video_url, output_dir)


def get_bilibili_subtitles(video_url: str) -> Optional[SubtitleResult]:
    """获取 Bilibili 字幕"""
    downloader = BilibiliDownloader()
    return downloader.download_subtitles(video_url)
