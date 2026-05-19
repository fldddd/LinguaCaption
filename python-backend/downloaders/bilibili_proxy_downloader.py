"""Download Bilibili video temporarily and proxy""" 
import os
import tempfile
import asyncio
import logging
import uuid

logger = logging.getLogger(__name__)

# In-memory download tracker: {download_id: {"path": ..., "status": ...}}
_downloads = {}

async def download_bilibili_video_progressive(bvid: str, client=None) -> str:
    """
    Download Bilibili video using yt-dlp to a temp file.
    Returns the local file path.
    """
    try:
        import yt_dlp
    except ImportError:
        raise ImportError("请先安装 yt-dlp: pip install yt-dlp")
    
    from services.cookie_manager import CookieConfigManager
    
    # Create temp directory
    temp_dir = os.path.join(tempfile.gettempdir(), "linguacaption_video")
    os.makedirs(temp_dir, exist_ok=True)
    
    download_id = str(uuid.uuid4())[:8]
    output_path = os.path.join(temp_dir, f"bilibili_{bvid}_{download_id}.%(ext)s")
    
    cookie_mgr = CookieConfigManager()
    cookie_file = None
    
    # Write cookie file if available
    cookie_val = cookie_mgr.get('bilibili')
    if cookie_val:
        cookiefile = os.path.join(temp_dir, f"cookies_{download_id}.txt")
        with open(cookiefile, 'w', encoding='utf-8') as f:
            f.write("# Netscape HTTP Cookie File\n")
            for pair in cookie_val.split("; "):
                if "=" in pair:
                    key, value = pair.split("=", 1)
                    f.write(f".bilibili.com\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")
        cookie_file = cookiefile
    
    video_url = f"https://www.bilibili.com/video/{bvid}/"
    
    ydl_opts = {
        'format': 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/best[ext=mp4]/best',
        'outtmpl': output_path,
        'http_headers': {'Referer': 'https://www.bilibili.com'},
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'merge_output_format': 'mp4',
    }
    
    if cookie_file:
        ydl_opts['cookiefile'] = cookie_file
    
    def progress_hook(d):
        if d.get('status') == 'downloading':
            total = d.get('total_bytes', 0) or d.get('total_bytes_estimate', 0)
            downloaded = d.get('downloaded_bytes', 0)
            if total > 0:
                pct = downloaded / total * 100
                print(f"[bilibili_download] {bvid}: {pct:.0f}% ({downloaded//1024//1024}MB/{total//1024//1024}MB)")
    
    ydl_opts['progress_hooks'] = [progress_hook]
    
    logger.info(f"Downloading Bilibili video {bvid}...")
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=True)
        actual_path = os.path.join(temp_dir, f"bilibili_{bvid}_{download_id}.mp4")
        
        # yt-dlp might use a different extension or create merged file
        possible_paths = [
            actual_path,
            os.path.join(temp_dir, f"bilibili_{bvid}_{download_id}.m4a"),
            os.path.join(temp_dir, f"bilibili_{bvid}_{download_id}.mkv"),
            os.path.join(temp_dir, f"bilibili_{bvid}_{download_id}.webm"),
        ]
        
        # Check if path with the video's actual id exists
        video_id = info.get('id', bvid)
        for fname in os.listdir(temp_dir):
            if fname.startswith(f"bilibili_{bvid}") or fname.startswith(video_id):
                fpath = os.path.join(temp_dir, fname)
                if os.path.isfile(fpath) and os.path.getsize(fpath) > 1000:
                    return fpath
        
        # Check all temp files with appropriate extension
        for fname in os.listdir(temp_dir):
            if download_id in fname:
                fpath = os.path.join(temp_dir, fname)
                if os.path.isfile(fpath) and os.path.getsize(fpath) > 1000:
                    return fpath
    
    raise FileNotFoundError(f"下载完成但找不到视频文件: {bvid}")
