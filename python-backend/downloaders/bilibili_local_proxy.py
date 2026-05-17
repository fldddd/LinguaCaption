"""
Bilibili video proxy — download via yt-dlp then serve locally.
Falls back to CDN proxy for non-Bilibili sources.
"""
import os
import re
import tempfile
import logging
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# Cache downloaded files by bvid
_download_cache = {}

def _write_cookie_file(cookie_val: str) -> str | None:
    """Write Bilibili cookie to Netscape format temp file."""
    if not cookie_val:
        return None
    cookiefile = os.path.join(
        tempfile.gettempdir(), "linguacaption_cookies",
        f"bilibili_{uuid.uuid4().hex[:8]}.txt"
    )
    os.makedirs(os.path.dirname(cookiefile), exist_ok=True)
    with open(cookiefile, 'w', encoding='utf-8') as f:
        f.write("# Netscape HTTP Cookie File\n")
        for pair in cookie_val.split("; "):
            if "=" in pair:
                key, value = pair.split("=", 1)
                f.write(f".bilibili.com\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")
    return cookiefile


def _download_video_sync(bvid: str, on_progress=None) -> str:
    """
    Download Bilibili video using yt-dlp. 
    Returns local file path. Uses cache to avoid re-download.
    Thread-safe for FastAPI background tasks.
    """
    # Check cache
    if bvid in _download_cache:
        cached = _download_cache[bvid]
        if os.path.exists(cached):
            logger.info(f"[bili_cache] Using cached: {cached}")
            return cached
    
    try:
        import yt_dlp
    except ImportError:
        raise ImportError("请先安装 yt-dlp: pip install yt-dlp")
    
    from services.cookie_manager import CookieConfigManager
    
    temp_dir = os.path.join(tempfile.gettempdir(), "linguacaption_video")
    os.makedirs(temp_dir, exist_ok=True)
    
    # Clean old cache entries
    _download_cache.clear()
    for f in Path(temp_dir).glob("bilibili_*"):
        age = (os.path.getmtime(f) if os.path.exists(f) else 0)
        if abs(os.path.getmtime(f) - __import__('time').time()) > 3600:  # 1 hour
            try: os.remove(f)
            except: pass
    
    output_template = os.path.join(temp_dir, f"bilibili_{bvid}_%(id)s.%(ext)s")
    
    cookie_mgr = CookieConfigManager()
    cookie_val = cookie_mgr.get('bilibili')
    cookiefile = _write_cookie_file(cookie_val) if cookie_val else None
    
    ydl_opts = {
        'format': 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/best',
        'outtmpl': output_template,
        'http_headers': {'Referer': 'https://www.bilibili.com'},
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'merge_output_format': 'mp4',
    }
    
    if cookiefile:
        ydl_opts['cookiefile'] = cookiefile
    
    def _hook(d):
        if d.get('status') == 'downloading' and on_progress:
            total = d.get('total_bytes', 0) or d.get('total_bytes_estimate', 0)
            downloaded = d.get('downloaded_bytes', 0)
            if total > 0:
                on_progress(downloaded, total)
    
    ydl_opts['progress_hooks'] = [_hook]
    
    video_url = f"https://www.bilibili.com/video/{bvid}/"
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=True)
    
    # Find the downloaded file
    video_id = info.get('id', bvid)
    temp_dir_path = Path(temp_dir)
    
    # Search for files matching this download
    for f in temp_dir_path.iterdir():
        fname = f.name
        if video_id in fname and f.suffix in ('.mp4', '.mkv', '.webm'):
            if f.stat().st_size > 1000:
                _download_cache[bvid] = str(f)
                logger.info(f"[bili_download] Complete: {f} ({f.stat().st_size // 1024 // 1024}MB)")
                return str(f)
    
    raise FileNotFoundError(f"Download completed but video file not found for {bvid}")


def download_bilibili_video_background(bvid: str) -> str:
    """
    Public entry point. Downloads Bilibili video and returns local path.
    Can be called from FastAPI background tasks or directly.
    """
    return _download_video_sync(bvid)
