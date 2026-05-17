"""Video extraction API"""
import re
import json
import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/video")

async def extract_bilibili_video(url: str) -> str:
    """Extract video URL from Bilibili video page"""
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            # 获取视频页面HTML
            response = await client.get(url)
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
                            api_response = await client.get(api_url)
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
        async with httpx.AsyncClient(follow_redirects=True) as client:
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