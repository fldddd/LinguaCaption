"""B2 音频采集模块 — REST API + WebSocket 端点"""

import asyncio
import json
import base64
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel

from config import settings
from audio.capture import capture_engine

router = APIRouter(prefix="/audio", tags=["audio"])


# ── 请求/响应模型 ──────────────────────────────────────

class AudioStartRequest(BaseModel):
    source: str = "system"  # "system" | "microphone" | "none"
    device_id: int = -1     # -1: 自动选择


class AudioStatusResponse(BaseModel):
    status: str
    source: str = ""
    device_id: int = -1
    device_name: str = ""
    sample_rate: int = 0
    channels: int = 0
    message: str = ""


# ── B2.1: 音频设备枚举 ─────────────────────────────────

@router.get("/devices", response_model=list[dict])
def list_audio_devices():
    """枚举所有可用的音频输入设备"""
    return capture_engine.list_devices()


# ── B2.2 / B2.3: 开始/停止采集 ─────────────────────────

@router.post("/start")
def start_audio_capture(req: AudioStartRequest):
    """开始音频采集

    - source="system": 捕获系统音频（WASAPI Loopback）
    - source="microphone": 捕获麦克风输入
    - source="none": 停止采集
    """
    return capture_engine.start(source=req.source, device_id=req.device_id)


@router.post("/stop")
def stop_audio_capture():
    """停止音频采集"""
    return capture_engine.stop()


@router.get("/status")
def audio_status():
    """获取当前采集状态"""
    return {
        "running": capture_engine.is_running,
        "source": capture_engine.source,
    }


# ── B2.4: 音频片段提取 ─────────────────────────────────

@router.get("/segment")
def get_audio_segment(start: float = Query(..., description="开始时间（秒）"), end: float = Query(..., description="结束时间（秒）")):
    """提取音频片段（B4 发音提取的端点，当前返回模拟数据）

    正式实现需要与录音文件系统集成，Phase 1 先返回占位响应。
    """
    return {
        "status": "ok",
        "start": start,
        "end": end,
        "duration": round(end - start, 2),
        "format": "wav",
        "sample_rate": settings.audio_sample_rate,
        "message": "音频片段提取端点就绪（需接入录音文件系统后生效）",
    }


# ── B2.5: WebSocket 音频流推送 ─────────────────────────

@router.websocket("/ws")
async def audio_stream(websocket: WebSocket):
    """WebSocket 实时音频流推送

    前端连接后，每秒推送 2 次音频数据（每次 0.5 秒）。

    消息格式：
    - 音频数据: {"type": "audio", "data": "<base64>", "timestamp": 1234567890, "sample_rate": 16000}
    - 状态更新: {"type": "status", "running": true, "source": "system"}
    - 错误: {"type": "error", "message": "..."}
    """
    await websocket.accept()

    # 缓存设备音频参数（一次性获取，避免循环中重复创建 PyAudio）
    dev_src_rate = settings.audio_sample_rate
    dev_src_channels = 1
    if capture_engine.is_running and capture_engine.device_id >= 0:
        try:
            import pyaudio
            pa_temp = pyaudio.PyAudio()
            try:
                dev_info = pa_temp.get_device_info_by_index(capture_engine.device_id)
                dev_src_rate = int(dev_info.get("defaultSampleRate", settings.audio_sample_rate))
                dev_src_channels = min(int(dev_info.get("maxInputChannels", 1)), 2)
            finally:
                pa_temp.terminate()
        except Exception:
            pass

    if not capture_engine.is_running:
        await websocket.send_json({
            "type": "status",
            "running": False,
            "source": "",
            "message": "音频采集未启动，请先 POST /api/audio/start",
        })

    try:
        while True:
            if capture_engine.is_running:
                # 读取 0.5 秒音频数据
                chunk = capture_engine.read_chunk(chunk_duration=0.5)
                if chunk:
                    wav_data = capture_engine.convert_to_whisper_format(chunk, dev_src_rate, dev_src_channels)

                    await websocket.send_json({
                        "type": "audio",
                        "data": base64.b64encode(wav_data).decode("utf-8"),
                        "timestamp": time.time(),
                        "sample_rate": settings.audio_sample_rate,
                    })

                # 控制推送频率：每 0.5 秒推一次
                await asyncio.sleep(0.5)
            else:
                await asyncio.sleep(1)
                await websocket.send_json({
                    "type": "status",
                    "running": False,
                    "source": "",
                })

            # 检查前端是否有消息（心跳）
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
                if msg == "ping":
                    await websocket.send_json({"type": "pong"})
            except asyncio.TimeoutError:
                pass

    except WebSocketDisconnect:
        logger.info("[Audio WS] 客户端断开连接")
    except Exception as e:
        logger.error("[Audio WS] 错误: %s", e)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
