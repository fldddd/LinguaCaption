"""Test _download_bilibili_sync from within the uvicorn server"""
import httpx

# Hit the proxy endpoint which should return video/mp4 from cache
resp = httpx.get(
    "http://localhost:8000/api/video/proxy?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1r25R68EUq%2F",
    timeout=30,
    follow_redirects=True
)
print(f"Status: {resp.status_code}")
print(f"Content-Type: {resp.headers.get('content-type')}")
print(f"Content-Length: {len(resp.content)}")
print(f"First 100 bytes: {resp.content[:100]}")
