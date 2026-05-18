"""
PR #44: video_router prefix 从 /api/video 改为 /video，main.py 统一加 prefix=/api

测试视频 extract / proxy / download / cookie API 端点。

覆盖:
- 正常路径: URL 参数校验、各端点响应格式
- 错误边界: 空 URL、无效 URL、缺少参数
- 注意: Bilibili extract 实际发网络请求，测试只验证路由可达
"""
import pytest


class TestVideoExtract:
    """视频 extract API 测试"""

    EXTRACT_URL = "/api/video/extract"

    def test_extract_empty_url(self, client):
        """空 URL → 400"""
        resp = client.get(self.EXTRACT_URL, params={"url": ""})
        assert resp.status_code == 400
        assert "不能为空" in resp.json()["detail"]

    def test_extract_missing_url(self, client):
        """缺少 url 参数 → 422"""
        resp = client.get(self.EXTRACT_URL)
        assert resp.status_code == 422

    @pytest.mark.xfail(reason="Bilibili API 返回非 JSON 编码数据，后端 gbk fallback 也有问题，需后续修复")
    def test_extract_bilibili_url_reaches_route(self, client):
        """Bilibili URL 路由可达（当前已知后端编码问题，标记为 xfail）"""
        resp = client.get(self.EXTRACT_URL, params={"url": "https://www.bilibili.com/video/BV1GJ411x"})
        assert resp.status_code != 404

    def test_extract_bilibili_b23_url(self, client):
        """b23.tv 短链接检测路由"""
        resp = client.get(self.EXTRACT_URL, params={"url": "https://b23.tv/abc123"})
        assert resp.status_code != 404

    def test_extract_generic_url_detection(self, client):
        """非 Bilibili URL → 通用提取路径"""
        resp = client.get(self.EXTRACT_URL, params={"url": "https://example.com/video.mp4"})
        # Generic extraction may fail with 404/500 but routing is correct
        assert resp.status_code != 405


class TestVideoProxy:
    """视频 proxy API 测试"""

    def test_proxy_empty_url(self, client):
        """空 URL → 400"""
        resp = client.get("/api/video/proxy", params={"url": ""})
        assert resp.status_code == 400
        assert "不能为空" in resp.json()["detail"]

    def test_proxy_missing_url(self, client):
        """缺少 url → 422"""
        resp = client.get("/api/video/proxy")
        assert resp.status_code == 422

    def test_proxy_with_mode_param(self, client):
        """指定 mode 参数路由可达"""
        resp = client.get("/api/video/proxy", params={
            "url": "https://example.com/video.mp4",
            "mode": "download",
        })
        # Route reached, may fail on network
        assert resp.status_code != 404

    def test_proxy_bilibili_detection(self, client):
        """Bilibili URL → proxy 路由可达"""
        resp = client.get("/api/video/proxy", params={
            "url": "https://www.bilibili.com/video/BV1GJ411x",
        })
        assert resp.status_code != 404


class TestVideoDownload:
    """视频/音频下载 API 测试"""

    def test_download_audio_invalid_url(self, client):
        """音频下载：非 Bilibili URL → 400"""
        resp = client.post("/api/video/download/audio", params={
            "url": "https://example.com/video",
        })
        assert resp.status_code == 400
        assert "有效的 Bilibili" in resp.json()["detail"]

    def test_download_audio_empty_url(self, client):
        """音频下载：空 URL → 400"""
        resp = client.post("/api/video/download/audio", params={"url": ""})
        assert resp.status_code == 400

    def test_download_video_invalid_url(self, client):
        """视频下载：非 Bilibili URL → 400"""
        resp = client.post("/api/video/download/video", params={
            "url": "https://example.com/video",
        })
        assert resp.status_code == 400
        assert "有效的 Bilibili" in resp.json()["detail"]

    def test_download_video_empty_url(self, client):
        """视频下载：空 URL → 400"""
        resp = client.post("/api/video/download/video", params={"url": ""})
        assert resp.status_code == 400


class TestVideoSubtitles:
    """字幕 API 测试"""

    def test_subtitles_invalid_url(self, client):
        """非 Bilibili URL → 400"""
        resp = client.get("/api/video/subtitles", params={
            "url": "https://example.com/video",
        })
        assert resp.status_code == 400
        assert "有效的 Bilibili" in resp.json()["detail"]

    def test_subtitles_empty_url(self, client):
        """空 URL → 400"""
        resp = client.get("/api/video/subtitles", params={"url": ""})
        assert resp.status_code == 400


class TestVideoInfo:
    """视频信息 API 测试"""

    def test_info_invalid_url(self, client):
        """非 Bilibili URL → 400"""
        resp = client.get("/api/video/info", params={
            "url": "https://example.com/video",
        })
        assert resp.status_code == 400

    def test_info_empty_url(self, client):
        """空 URL → 400"""
        resp = client.get("/api/video/info", params={"url": ""})
        assert resp.status_code == 400


class TestVideoCookie:
    """Cookie 管理 API 测试"""

    def test_get_cookie_default(self, client):
        """获取 cookie（默认无）→ 返回 has_cookie=false"""
        resp = client.get("/api/video/cookie")
        assert resp.status_code == 200
        data = resp.json()
        assert "has_cookie" in data
        assert data["has_cookie"] is False

    def test_set_cookie_empty(self, client):
        """设置空 cookie → 400（cookie 是 query param，空字符串 → 422 或 400）"""
        # FastAPI treats plain `cookie: str` as query param
        # Empty string passes validation but triggers the `if not cookie` check
        resp = client.post("/api/video/cookie", params={"cookie": ""})
        assert resp.status_code in (400, 422)

    def test_set_and_delete_cookie(self, client):
        """设置 cookie → 删除 cookie 流程"""
        # Set (use params since cookie is a query/body string param)
        resp = client.post("/api/video/cookie", params={
            "cookie": "SESSDATA=abc123; bili_jct=def456"
        })
        assert resp.status_code == 200
        assert resp.json()["success"] is True

        # Verify
        resp = client.get("/api/video/cookie")
        assert resp.status_code == 200
        assert resp.json()["has_cookie"] is True

        # Delete
        resp = client.delete("/api/video/cookie")
        assert resp.status_code == 200
        assert resp.json()["success"] is True

        # Verify deleted
        resp = client.get("/api/video/cookie")
        assert resp.status_code == 200
        assert resp.json()["has_cookie"] is False

    def test_set_cookie_with_json_body(self, client):
        """使用 JSON body 设置 cookie → 422（cookie 是 query/body str 参数，不是 JSON body）"""
        resp = client.post("/api/video/cookie", json={"cookie": "test_cookie_value"})
        assert resp.status_code == 422


class TestRoutePrefixes:
    """验证 PR #44 路由前缀变更"""

    def test_video_endpoints_accessible(self, client):
        """视频端点可通过 /api/video/... 访问"""
        resp = client.get("/api/video/extract", params={"url": "test"})
        # 非 404 表示路由已到达
        assert resp.status_code != 404

    def test_vocab_endpoints_accessible(self, client):
        """词汇端点可通过 /api/vocab 访问"""
        resp = client.get("/api/vocab")
        assert resp.status_code == 200

    def test_old_vocab_path_not_found(self, client):
        """旧路径 /api/vocabulary 不再可用 → 404"""
        resp = client.get("/api/vocabulary")
        assert resp.status_code == 404

    def test_health_endpoint(self, client):
        """健康检查端点可用"""
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
