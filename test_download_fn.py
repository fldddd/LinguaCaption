"""Test that the server can find the cached file"""
import sys, os
sys.path.insert(0, "D:/projects/LinguaCaption/python-backend")

# Direct test
cache_dir = os.path.join(os.environ.get('TMP', os.environ.get('TEMP', '/tmp')), "linguacaption_video")
os.makedirs(cache_dir, exist_ok=True)
cached = os.path.join(cache_dir, "BV1r25R68EUq.mp4")
print(f"cache_dir: {cache_dir}")
print(f"cached: {cached}")
print(f"exists: {os.path.exists(cached)}")
print(f"size: {os.path.getsize(cached) if os.path.exists(cached) else 0}")

# Now test the function
from api.video import _download_bilibili_sync
result = _download_bilibili_sync("BV1r25R68EUq")
print(f"Result: {result}")
print(f"Result exists: {os.path.exists(result)}")
