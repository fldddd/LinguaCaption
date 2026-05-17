"""Video extraction API — 集成 Bilibili 视频下载功能"""
import os
import re
import json
import httpx
import asyncio
import tempfile
from urllib.parse import quote
from typing import Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, FileResponse

# 导入新模块
from downloaders.bilibili_downloader import BilibiliDownloader, download_bilibili_audio, get_bilibili_subtitles
from services.cookie_manager import CookieConfigManager

router = APIRouter(prefix="/api/video")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"Windows\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

def parse_bvid_from_url(url: str) -> str:
    """从URL中解析BV号"""
    match = re.search(r'BV[a-zA-Z0-9]+', url)
    if match:
        return match.group(0)
    return ""

async def extract_bilibili_video(url: str) -> str:
    """Extract video URL from Bilibili video page"""
    try:
        bvid = parse_bvid_from_url(url)
        if not bvid:
            raise HTTPException(status_code=400, detail="无法从URL中提取BV号")
        
        print(f"🔍 解析到 BV 号: {bvid}")
        
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            info_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
            info_response = await client.get(info_url, headers=HEADERS)
            info_response.raise_for_status()
            try:
                info_data = info_response.json()
            except UnicodeDecodeError:
                content = info_response.content.decode('gbk')
                info_data = json.loads(content)
            
            if info_data.get('code') != 0:
                raise HTTPException(status_code=404, detail=f"获取视频信息失败: {info_data.get('message', '未知错误')}")
            
            video_info = info_data.get('data', {})
            cid = video_info.get('cid')
            if not cid:
                pages = video_info.get('pages', [])
                if pages:
                    cid = pages[0].get('cid')
            
            if not cid:
                raise HTTPException(status_code=404, detail="无法获取视频CID")
            
            print(f"✅ 获取到 CID: {cid}")
            
            playurl = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=80&type=&otype=json"
            play_response = await client.get(playurl, headers=HEADERS)
            play_response.raise_for_status()
            play_data = play_response.json()
            
            if play_data.get('code') != 0:
                raise HTTPException(status_code=404, detail=f"获取播放链接失败: {play_data.get('message', '未知错误')}")
            
            data = play_data.get('data', {})
            if 'dash' in data and 'video' in data['dash']:
                video_streams = data['dash']['video']
                if video_streams:
                    video_streams.sort(key=lambda x: x.get('bandwidth', 0), reverse=True)
                    return video_streams[0]['baseUrl']
            elif 'durl' in data:
                durls = data['durl']
                if durls:
                    return durls[0]['url']
            
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
            
            video_src_match = re.search(r'<video[^>]*src=["\']([^"\']+)["\']', html)
            if video_src_match:
                return video_src_match.group(1)
            
            source_src_match = re.search(r'<source[^>]*src=["\']([^"\']+)["\']', html)
            if source_src_match:
                return source_src_match.group(1)
            
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

# ==================== 原有 API ====================

@router.get("/extract")
async def extract_video_url(url: str):
    """从视频网页提取真实视频URL"""
    print(f"🔔 /api/video/extract called with url: {url}")
    if not url:
        print("❌ URL为空")
        raise HTTPException(status_code=400, detail="URL不能为空")
    
    if 'bilibili.com' in url or 'b23.tv' in url:
        print("🔍 检测到B站URL，调用extract_bilibili_video")
        video_url = await extract_bilibili_video(url)
    else:
        print("🔍 非B站URL，调用extract_generic_video")
        video_url = await extract_generic_video(url)
    
    print(f"✅ 成功提取视频URL: {video_url[:50]}...")
    # 前端根据用户选择追加 &mode=stream 或 &mode=download
    return {"url": video_url, "proxy_url": f"/api/video/proxy?url={quote(url)}"}

async def _re_extract_bilibili_url(bvid: str, client: httpx.AsyncClient) -> str | None:
    """从 Bilibili API 重新提取视频播放链接（处理 dash + durl 两种格式）"""
    try:
        info_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        info_resp = await client.get(info_url, headers=HEADERS)
        info_data = info_resp.json()
        cid = info_data.get('data', {}).get('cid')
        if not cid:
            return None

        for qn in [80, 64, 32, 16]:
            playurl = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn={qn}&otype=json"
            play_resp = await client.get(playurl, headers=HEADERS)
            play_data = play_resp.json()
            if play_data.get('code') != 0:
                continue
            data = play_data.get('data', {})
            if 'durl' in data and data['durl']:
                return data['durl'][0]['url']
            if 'dash' in data and 'video' in data['dash']:
                streams = data['dash']['video']
                if streams:
                    streams.sort(key=lambda x: x.get('bandwidth', 0), reverse=True)
                    return streams[0]['baseUrl']
    except Exception as e:
        print(f"⚠️ re-extract error: {e}")
    return None


def _download_bilibili_sync(bvid: str) -> str:
    """后台线程中下载B站视频，返回本地路径"""
    try:
        import yt_dlp
    except ImportError:
        raise ImportError("yt-dlp not installed")
    
    from services.cookie_manager import CookieConfigManager
    
    # 检查缓存
    cache_dir = os.path.join(tempfile.gettempdir(), "linguacaption_video")
    os.makedirs(cache_dir, exist_ok=True)
    cached = os.path.join(cache_dir, f"{bvid}.mp4")
    if os.path.exists(cached) and os.path.getsize(cached) > 10000:
        print(f"✅ Using cached: {cached}")
        return cached
    
    # 清理旧格式的临时文件（避免重复缓存）
    for old_f in os.listdir(cache_dir):
        if old_f.startswith(f"{bvid}_") and old_f.endswith('.mp4') and old_f != f"{bvid}.mp4":
            old_path = os.path.join(cache_dir, old_f)
            try:
                os.remove(old_path)
                print(f"🧹 Cleaned up old format: {old_f}")
            except OSError:
                pass
    
    # 直接输出为规范文件名，避免重命名产生重复
    output_template = os.path.join(cache_dir, f"{bvid}.%(ext)s")
    cookiefile = None
    cookie_val = CookieConfigManager().get('bilibili')
    if cookie_val:
        cf = os.path.join(cache_dir, f"{bvid}_cookies.txt")
        with open(cf, 'w', encoding='utf-8') as f:
            f.write("# Netscape HTTP Cookie File\n")
            for pair in cookie_val.split("; "):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    f.write(f".bilibili.com\tTRUE\t/\tFALSE\t0\t{k}\t{v}\n")
        cookiefile = cf
    
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
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(f"https://www.bilibili.com/video/{bvid}/", download=True)
    
    # 直接返回规范文件名（输出模板已保证名称正确）
    final = os.path.join(cache_dir, f"{bvid}.mp4")
    if os.path.exists(final) and os.path.getsize(final) > 10000:
        print(f"✅ Download complete: {final}")
        return final
    
    raise FileNotFoundError(f"下载完成但找不到视频文件: {bvid}")


@router.get("/proxy")
async def proxy_video(url: str, request: Request, mode: str = "stream"):
    """代理视频请求
    支持三种模式：
    1. mode=download, url=原始B站视频页URL — 通过yt-dlp下载到本地再服务（可复用缓存）
    2. mode=stream, url=原始B站视频页URL — 代理CDN流，不保存到本地
    3. url=直接CDN链接 — 直接代理（非B站或已过期）
    """
    if not url:
        raise HTTPException(status_code=400, detail="URL不能为空")
    
    # ── 模式1: B站视频页 — yt-dlp下载本地再服务 ──────
    if 'bilibili.com/video/' in url or 'b23.tv' in url:
        bvid = parse_bvid_from_url(url)
        if not bvid:
            raise HTTPException(status_code=400, detail="无法从URL中提取BV号")
        
        if mode == "download":
            try:
                print(f"🔁 Bilibili proxy [download]: {bvid}")
                local_path = await asyncio.to_thread(_download_bilibili_sync, bvid)
                file_size_mb = os.path.getsize(local_path) // 1024 // 1024
                print(f"✅ Local video: {local_path} ({file_size_mb}MB)")
                return FileResponse(local_path, media_type='video/mp4')
            except Exception as e:
                print(f"❌ Download failed: {e}, falling back to CDN proxy")
        else:
            print(f"🔁 Bilibili proxy [stream]: {bvid}")
    
    # ── 模式2: 直接CDN链接代理 ──────────────────────────
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            actual_url = url
            if 'bilibili.com/video/' in url or 'b23.tv' in url:
                bvid = parse_bvid_from_url(url)
                if bvid:
                    fresh_url = await _re_extract_bilibili_url(bvid, client)
                    if fresh_url:
                        actual_url = fresh_url
            
            proxy_headers = HEADERS.copy()
            proxy_headers['Referer'] = 'https://www.bilibili.com/'
            
            range_header = request.headers.get('range')
            req_headers = proxy_headers.copy()
            if range_header:
                req_headers['Range'] = range_header
            
            response = await client.get(actual_url, headers=req_headers)
            response.raise_for_status()
            
            forbidden_headers = {'content-encoding', 'transfer-encoding', 'content-length'}
            safe_headers = {
                k: v for k, v in response.headers.items()
                if k.lower() not in forbidden_headers
            }
            
            return StreamingResponse(
                response.aiter_bytes(),
                status_code=response.status_code,
                headers=safe_headers,
                media_type=response.headers.get('content-type', 'video/mp4')
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"代理请求失败: {str(e)}")


# ==================== 新增 API ====================

@router.post("/download/audio")
async def download_audio_api(url: str, quality: str = "fast", background_tasks: BackgroundTasks = None):
    """
    下载 Bilibili 视频音频
    
    - url: Bilibili 视频链接
    - quality: 音频质量 (fast/medium/slow)
    """
    if not url or ('bilibili.com' not in url and 'b23.tv' not in url):
        raise HTTPException(status_code=400, detail="请提供有效的 Bilibili 视频链接")
    
    try:
        output_dir = "data/audio"
        os.makedirs(output_dir, exist_ok=True)
        
        result = download_bilibili_audio(url, output_dir=output_dir, quality=quality)
        
        return {
            "success": True,
            "file_path": result.file_path,
            "title": result.title,
            "duration": result.duration,
            "cover_url": result.cover_url,
            "video_id": result.video_id,
        }
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"缺少依赖: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"下载失败: {str(e)}")

@router.post("/download/video")
async def download_video_api(url: str):
    """
    下载 Bilibili 视频
    
    - url: Bilibili 视频链接
    """
    if not url or ('bilibili.com' not in url and 'b23.tv' not in url):
        raise HTTPException(status_code=400, detail="请提供有效的 Bilibili 视频链接")
    
    try:
        output_dir = "data/video"
        os.makedirs(output_dir, exist_ok=True)
        
        downloader = BilibiliDownloader()
        video_path = downloader.download_video(url, output_dir=output_dir)
        
        return {
            "success": True,
            "file_path": video_path,
        }
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"缺少依赖: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"下载失败: {str(e)}")

@router.get("/subtitles")
async def get_subtitles(url: str):
    """
    获取 Bilibili 视频字幕
    
    - url: Bilibili 视频链接
    - 返回: 字幕内容（优先人工字幕，其次 AI 字幕）
    """
    if not url or ('bilibili.com' not in url and 'b23.tv' not in url):
        raise HTTPException(status_code=400, detail="请提供有效的 Bilibili 视频链接")
    
    try:
        result = get_bilibili_subtitles(url)
        
        if not result:
            return {
                "success": False,
                "message": "该视频没有可用字幕（可能需要登录或视频本身无字幕）"
            }
        
        # 转换 segments 为字典列表
        segments = [
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text
            }
            for seg in result.segments
        ]
        
        return {
            "success": True,
            "language": result.language,
            "full_text": result.full_text,
            "segments": segments,
            "source": result.raw.get("source"),
            "ai_type": result.raw.get("ai_type"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取字幕失败: {str(e)}")

@router.get("/info")
async def get_video_info(url: str):
    """
    获取 Bilibili 视频信息（不下载）
    
    - url: Bilibili 视频链接
    """
    if not url or ('bilibili.com' not in url and 'b23.tv' not in url):
        raise HTTPException(status_code=400, detail="请提供有效的 Bilibili 视频链接")
    
    try:
        downloader = BilibiliDownloader()
        info = downloader.get_video_info(url)
        
        return {
            "success": True,
            "info": info
        }
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"缺少依赖: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取信息失败: {str(e)}")


# ==================== Cookie 管理 API ====================

@router.get("/cookie")
async def get_cookie():
    """获取当前 Bilibili Cookie 配置状态"""
    mgr = CookieConfigManager()
    cookie = mgr.get("bilibili")
    return {
        "has_cookie": cookie is not None,
        "cookie_preview": cookie[:50] + "..." if cookie and len(cookie) > 50 else cookie
    }

@router.post("/cookie")
async def set_cookie(cookie: str):
    """
    设置 Bilibili Cookie
    
    - cookie: 完整的 Cookie 字符串（包含 SESSDATA）
    """
    if not cookie:
        raise HTTPException(status_code=400, detail="Cookie 不能为空")
    
    mgr = CookieConfigManager()
    mgr.set("bilibili", cookie)
    
    return {
        "success": True,
        "message": "Cookie 已保存"
    }

@router.delete("/cookie")
async def delete_cookie():
    """删除 Bilibili Cookie"""
    mgr = CookieConfigManager()
    mgr.delete("bilibili")
    
    return {
        "success": True,
        "message": "Cookie 已删除"
    }


# ==================== 测试页面 ====================

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
        .section { margin: 2rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: 0.5rem; }
        .section h3 { margin-top: 0; color: #333; }
        .video-container { margin-top: 1rem; }
        video { max-width: 100%; border-radius: 0.5rem; }
        .proxy-hint { color: #666; font-size: 0.9rem; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <h1>视频 URL 提取测试</h1>
    
    <div class="section">
        <h3>1. 提取视频源 URL</h3>
        <div class="input-group">
            <input type="url" id="urlInput" placeholder="粘贴视频页面 URL（如 Bilibili 视频页）">
            <button id="extractBtn">提取视频源</button>
        </div>
        <div id="extractStatus"></div>
        <div id="extractResult"></div>
    </div>
    
    <div class="section">
        <h3>2. 获取视频信息</h3>
        <button id="infoBtn">获取信息</button>
        <div id="infoResult"></div>
    </div>
    
    <div class="section">
        <h3>3. 获取字幕</h3>
        <button id="subtitleBtn">获取字幕</button>
        <div id="subtitleResult"></div>
    </div>
    
    <div class="section">
        <h3>4. 下载音频</h3>
        <select id="qualitySelect">
            <option value="fast">快速 (32kbps)</option>
            <option value="medium" selected>标准 (64kbps)</option>
            <option value="slow">高质量 (128kbps)</option>
        </select>
        <button id="audioBtn">下载音频</button>
        <div id="audioResult"></div>
    </div>

    <div class="section">
        <h3>5. 测试代理播放</h3>
        <div class="input-group">
            <input type="url" id="proxyUrlInput" readonly placeholder="提取视频源后自动填充">
            <button id="proxyPlayBtn">代理播放</button>
        </div>
        <div class="video-container" id="proxyVideoContainer"></div>
        <div id="proxyStatus"></div>
    </div>
    
    <script>
        const urlInput = document.getElementById('urlInput');
        const baseUrl = '/api/video';
        
        // 提取视频源
        document.getElementById('extractBtn').addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) { alert('请输入 URL'); return; }
            
            const statusDiv = document.getElementById('extractStatus');
            const resultDiv = document.getElementById('extractResult');
            const proxyUrlInput = document.getElementById('proxyUrlInput');
            statusDiv.innerHTML = '<p>正在提取...</p>';
            
            try {
                const response = await fetch(`${baseUrl}/extract?url=${encodeURIComponent(url)}`);
                const data = await response.json();
                
                if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
                
                statusDiv.innerHTML = '<p class="success">✅ 成功！</p>';
                
                // 设置代理播放输入框
                const proxyUrl = window.location.origin + data.proxy_url;
                proxyUrlInput.value = proxyUrl;
                
                resultDiv.innerHTML = `
                    <h4>提取结果：</h4>
                    <a href="${data.url}" target="_blank" style="word-break: break-all;">${data.url}</a>
                    <hr>
                    <h4>直接播放测试：</h4>
                    <video controls width="100%" style="margin-top:1rem;">
                        <source src="${data.url}" type="video/mp4">
                        您的浏览器不支持视频播放
                    </video>
                    <p class="proxy-hint">⚠️ 如果直接播放失败，请使用下方「代理播放」按钮</p>
                `;
            } catch (err) {
                statusDiv.innerHTML = `<p class="error">❌ 失败: ${err.message}</p>`;
            }
        });

        // 代理播放
        document.getElementById('proxyPlayBtn').addEventListener('click', async () => {
            const proxyUrl = document.getElementById('proxyUrlInput').value;
            const container = document.getElementById('proxyVideoContainer');
            const statusDiv = document.getElementById('proxyStatus');
            
            if (!proxyUrl) {
                statusDiv.innerHTML = '<p class="error">请先提取视频源</p>';
                return;
            }
            
            statusDiv.innerHTML = '<p>正在加载代理播放...</p>';
            container.innerHTML = `
                <video controls width="100%" style="margin-top:1rem;">
                    <source src="${proxyUrl}" type="video/mp4">
                    您的浏览器不支持视频播放
                </video>
            `;
            
            // 监听加载事件
            const video = container.querySelector('video');
            video.onloadedmetadata = () => {
                statusDiv.innerHTML = '<p class="success">✅ 代理播放成功！</p>';
            };
            video.onerror = () => {
                const err = video.error;
                statusDiv.innerHTML = `<p class="error">❌ 代理播放失败: ${err ? err.message : '未知错误'}</p>`;
            };
        });
        
        // 获取视频信息
        document.getElementById('infoBtn').addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) { alert('请输入 URL'); return; }
            
            const resultDiv = document.getElementById('infoResult');
            resultDiv.innerHTML = '<p>正在获取...</p>';
            
            try {
                const response = await fetch(`${baseUrl}/info?url=${encodeURIComponent(url)}`);
                const data = await response.json();
                
                if (!response.ok) throw new Error(data.detail);
                
                resultDiv.innerHTML = `<pre>${JSON.stringify(data.info, null, 2)}</pre>`;
            } catch (err) {
                resultDiv.innerHTML = `<p class="error">❌ ${err.message}</p>`;
            }
        });
        
        // 获取字幕
        document.getElementById('subtitleBtn').addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) { alert('请输入 URL'); return; }
            
            const resultDiv = document.getElementById('subtitleResult');
            resultDiv.innerHTML = '<p>正在获取字幕...</p>';
            
            try {
                const response = await fetch(`${baseUrl}/subtitles?url=${encodeURIComponent(url)}`);
                const data = await response.json();
                
                if (!response.ok) throw new Error(data.detail);
                
                if (data.success) {
                    resultDiv.innerHTML = `
                        <p class="success">✅ 语言: ${data.language} | AI生成: ${data.ai_type ? '是' : '否'}</p>
                        <p>全文: ${data.full_text.substring(0, 200)}...</p>
                        <details>
                            <summary>查看分段 (${data.segments.length} 段)</summary>
                            <pre>${JSON.stringify(data.segments.slice(0, 10), null, 2)}...</pre>
                        </details>
                    `;
                } else {
                    resultDiv.innerHTML = `<p class="error">⚠️ ${data.message}</p>`;
                }
            } catch (err) {
                resultDiv.innerHTML = `<p class="error">❌ ${err.message}</p>`;
            }
        });
    </script>
</body>
</html>
    """
