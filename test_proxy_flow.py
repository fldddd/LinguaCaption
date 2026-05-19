"""Test the full proxy flow end-to-end (bypass uvicorn reload issues)"""
import asyncio
import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com",
}

async def test_proxy_flow():
    url = "https://www.bilibili.com/video/BV1r25R68EUq/"
    bvid = "BV1r25R68EUq"
    
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        # Step 1: Get video info
        info_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        info_resp = await client.get(info_url, headers=HEADERS)
        info_data = info_resp.json()
        cid = info_data.get('data', {}).get('cid')
        print(f"CID: {cid}")
        
        if not cid:
            print("FAILED: no cid")
            return
        
        # Step 2: Get CDN URL (qn=80 for highest quality)
        playurl = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=80&otype=json"
        play_resp = await client.get(playurl, headers=HEADERS)
        play_data = play_resp.json()
        cdn_url = play_data['data']['durl'][0]['url']
        print(f"CDN URL obtained, len={len(cdn_url)}")
        
        # Step 3: Fetch the CDN URL directly (as the proxy would)
        proxy_headers = HEADERS.copy()
        proxy_headers['Referer'] = 'https://www.bilibili.com/'
        
        print(f"Fetching CDN URL...")
        resp = await client.get(cdn_url, headers=proxy_headers, timeout=60)
        print(f"CDN Status: {resp.status_code}")
        print(f"CDN Content-Type: {resp.headers.get('content-type')}")
        print(f"CDN Content-Length: {resp.headers.get('content-length', 'chunked')}")
        print(f"First 100 bytes: {resp.content[:100]}")
        
asyncio.run(test_proxy_flow())
