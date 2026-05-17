"""Video extraction API"""
import re
import json
import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/video")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

async def extract_bilibili_video(url: str) -> str:
    """Extract video URL from Bilibili video page"""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            # 获取视频页面HTML，带 headers
            response = await client.get(url, headers=HEADERS)
            response.raise_for_status()

            # 查找 window.__playinfo__ 或 window.playerInfo
            html = response.text

            # 方式1: 查找 __playinfo__
            playinfo_match = re.search(r'window\.__playinfo__\s*=\s*({.*?})\s*;</script>', html, re.DOTALL)
            if playinfo_match:
                try:
                    playinfo = json.loads(playinfo_match.group(1))
                    # 找到视频流
                    if 'data' in playinfo:
                        data = playinfo['data']
                        if 'dash' in data and 'video' in data['dash']:
                            # 选择第一个视频流
                            video_streams = data['dash']['video']
                            if video_streams:
                                # 按清晰度排序，选择最高清的
                                video_streams.sort(key=lambda x: x.get('bandwidth', 0), reverse=True)
                                return video_streams[0]['baseUrl']
                        elif 'durl' in data:
                            # 旧格式
                            durls = data['durl']
                            if durls:
                                return durls[0]['url']
                except json.JSONDecodeError:
                    pass

            # 方式2: 查找 playerInfo
            playerinfo_match = re.search(r'window\.playerInfo\s*=\s*({.*?})\s*;</script>', html, re.DOTALL)
            if playerinfo_match:
                try:
                    playerinfo = json.loads(playerinfo_match.group(1))
                    if 'videoData' in playerinfo:
                        video_data = playerinfo['videoData']
                        if 'pages' in video_data and video_data['pages']:
                            cid = video_data['pages'][0]['cid']
                            bvid = video_data['bvid']
                            # 构建API请求
                            api_url = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=80"
                            api_response = await client.get(api_url, headers=HEADERS)
                            api_data = api_response.json()
                            if 'data' in api_data and 'durl' in api_data['data']:
                                return api_data['data']['durl'][0]['url']
                except json.JSONDecodeError:
                    pass

            raise HTTPException(status_code=404, detail="无法提取视频源")

    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"网络请求失败: {str(e)}")

async def extract_generic_video(url: str) -> str:
    """尝试从通用视频页面提取视频源"""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=HEADERS) as client:
            response = await client.get(url)
            response.raise_for_status()
            html = response.text
            
            # 查找 video 标签的 src 属性
            video_src_match = re.search(r'<video[^>]*src=["\']([^"\']+)["\']', html)
            if video_src_match:
                return video_src_match.group(1)
            
            # 查找 source 标签的 src 属性
            source_src_match = re.search(r'<source[^>]*src=["\']([^"\']+)["\']', html)
            if source_src_match:
                return source_src_match.group(1)
            
            # 查找 JSON-LD 中的视频URL
            json_ld_match = re.search(r'<script type=["\']application/ld\+json["\'][^>]*>({.*?})</script>', html, re.DOTALL)
            if json_ld_match:
                try:
                    json_ld = json.loads(json_ld_match.group(1))
                    if isinstance(json_ld, list):
                        json_ld = json_ld[0]
                    if 'contentUrl' in json_ld:
                        return json_ld['contentUrl']
                except json.JSONDecodeError:
                    pass
            
            raise HTTPException(status_code=404, detail="无法提取视频源")
    
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"网络请求失败: {str(e)}")

@router.get("/extract")
async def extract_video_url(url: str):
    """从视频网页提取真实视频URL"""
    if not url:
        raise HTTPException(status_code=400, detail="URL不能为空")
    
    # 判断平台
    if 'bilibili.com' in url or 'b23.tv' in url:
        video_url = await extract_bilibili_video(url)
    else:
        video_url = await extract_generic_video(url)
    
    return {"url": video_url}

@router.get("/test")
async def test_extract_video_page():
    """测试视频URL提取的HTML页面"""
    return """
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>视频 URL 提取测试</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
        h1 { color: #1a73e8; }
        .input-group { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
        input[type="url"] { flex: 1; padding: 0.75rem; font-size: 1rem; border: 2px solid #ddd; border-radius: 0.5rem; }
        button { padding: 0.75rem 1.5rem; background: #1a73e8; color: white; border: none; border-radius: 0.5rem; cursor: pointer; font-weight: bold; }
        button:hover { background: #1557b0; }
        button:disabled { background: #999; cursor: not-allowed; }
        .result { background: #f8f9fa; padding: 1rem; border-radius: 0.5rem; margin-top: 1rem; }
        .success { border-left: 4px solid #28a745; }
        .error { border-left: 4px solid #dc3545; }
        .status { margin-top: 1rem; }
    </style>
</head>
<body>
    <h1>视频 URL 提取测试</h1>
    <div class="input-group">
        <input type="url" id="urlInput" placeholder="粘贴视频页面 URL（如 Bilibili 视频页）">
        <button id="extractBtn">提取视频源</button>
    </div>
    <div id="status"></div>
    <div id="result"></div>
    
    <script>
        const urlInput = document.getElementById('urlInput');
        const extractBtn = document.getElementById('extractBtn');
        const statusDiv = document.getElementById('status');
        const resultDiv = document.getElementById('result');
        
        extractBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) {
                statusDiv.innerHTML = '<p class="error">请输入 URL</p>';
                return;
            }
            
            statusDiv.innerHTML = '<p>正在提取视频源...</p>';
            resultDiv.innerHTML = '';
            extractBtn.disabled = true;
            
            try {
                const response = await fetch(`/api/video/extract?url=${encodeURIComponent(url)}`);
                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.detail || `HTTP ${response.status}`);
                }
                
                const data = await response.json();
                statusDiv.innerHTML = '<p class="success">✅ 成功！</p>';
                resultDiv.innerHTML = `
                    <h3>提取结果：</h3>
                    <a href="${data.url}" target="_blank" style="word-break: break-all;">${data.url}</a>
                    <hr>
                    <h4>测试播放：</h4>
                    <video controls width="100%" style="margin-top:1rem;">
                        <source src="${data.url}" type="video/mp4">
                        您的浏览器不支持视频播放
                    </video>
                `;
            } catch (err) {
                statusDiv.innerHTML = `<p class="error">❌ 失败: ${err.message}</p>`;
                resultDiv.innerHTML = '<p>请检查控制台获取更多信息</p>';
                console.error(err);
            } finally {
                extractBtn.disabled = false;
            }
        });
        
        // 按 Enter 键触发提取
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                extractBtn.click();
            }
        });
    </script>
</body>
</html>
"""