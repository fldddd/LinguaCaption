"""Test the _re_extract_bilibili_url function"""
import asyncio
import sys
sys.path.insert(0, "D:/projects/LinguaCaption/python-backend")
from api.video import _re_extract_bilibili_url
import httpx

async def test():
    bvid = "BV1r25R68EUq"
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        result = await _re_extract_bilibili_url(bvid, client)
        print(f"Result: {result}")
        if result:
            print(f"First 80 chars: {result[:80]}")
        else:
            print("FAILED - got None")

asyncio.run(test())
