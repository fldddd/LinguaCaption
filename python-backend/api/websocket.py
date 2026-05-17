"""
WebSocket 实时字幕端点 — s1-s2 桥接组件

提供两个入口:
1. `/ws/subtitle/simulate` — 模拟字幕流（Phase 2 前的 demo/测试）
2. `/ws/subtitle/realtime` — 真实 Whisper 转录（Phase 1 实现）
"""

import asyncio
import json
import logging
import base64
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from transcription.simulator import SubtitleSimulator
from transcription.transcriber import transcriber

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ws", tags=["websocket"])

# ── 活跃连接跟踪 ────────────────────────────────────────────
active_connections: set[WebSocket] = set()


def _count_active() -> int:
    """返回当前活跃的 WebSocket 连接数（清理断开的）"""
    dead = {ws for ws in active_connections if ws.client_state.name == "DISCONNECTED"}
    active_connections.difference_update(dead)
    return len(active_connections)


# ── 模拟字幕流 ──────────────────────────────────────────────

@router.websocket("/subtitle/simulate")
async def websocket_simulate(
    ws: WebSocket,
    script: str = Query("daily", description="语料主题: greeting/daily/academic"),
    max_segments: int = Query(20, ge=1, le=100, description="最大字幕条数"),
    interval_min: float = Query(0.8, ge=0.3, description="推送间隔最小值(秒)"),
    interval_max: float = Query(2.5, ge=0.5, description="推送间隔最大值(秒)"),
):
    await ws.accept()
    active_connections.add(ws)
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    logger.info("WebSocket 模拟连接: %s (script=%s, segs=%d)", client, script, max_segments)
    active_count = _count_active()
    logger.info("当前活跃连接数: %d", active_count)

    try:
        # 发送欢迎/状态消息
        await ws.send_json({
            "type": "status",
            "data": {
                "state": "connected",
                "mode": "simulate",
                "script": script,
                "active_connections": active_count,
                "message": "字幕模拟器已连接，准备接收字幕流",
            },
        })

        simulator = SubtitleSimulator(script_key=script)

        async for message in simulator.stream(
            interval=(interval_min, interval_max),
            max_segments=max_segments,
        ):
            await ws.send_json(message)

    except WebSocketDisconnect:
        logger.info("WebSocket 客户端断开: %s", client)
    except Exception as e:
        logger.error("WebSocket 处理异常: %s", e, exc_info=True)
        try:
            await ws.send_json({"type": "error", "data": {"code": "WS_ERROR", "message": str(e)}})
        except Exception:
            pass
    finally:
        active_connections.discard(ws)
        logger.info("WebSocket 连接关闭: %s (剩余 %d)", client, _count_active())


# ── 实时字幕（Phase 1 — Whisper 转录） ──────────────────────

@router.websocket("/subtitle/realtime")
async def websocket_realtime(
    ws: WebSocket,
    model: str = Query("base", description="Whisper 模型: tiny/base/small/medium"),
    source: str = Query("system", description="音频源: system/microphone"),
    device_id: int = Query(-1, description="音频设备 ID（-1 自动选择）"),
    chunk_seconds: float = Query(3.0, ge=1.0, le=10.0, description="转录窗口时长(秒)"),
    overlap: float = Query(0.5, ge=0.0, le=2.0, description="窗口重叠(秒)"),
):
    """实时 Whisper 转录 WebSocket

    工作流程:
    1. 客户端连接后自动启动音频采集
    2. 服务端实时转录音频流
    3. 字幕段通过 WebSocket 推送

    消息格式（同模拟器）:
    - 字幕: {"type": "subtitle", "data": {"text": "...", "start_time": 0, "end_time": 2.5, ...}}
    - 状态: {"type": "status", "data": {"state": "listening", ...}}
    - 错误: {"type": "error", "data": {"code": "...", "message": "..."}}
    - 心跳: 收到 "ping" 回复 "pong"
    """
    await ws.accept()
    active_connections.add(ws)
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    logger.info("WebSocket 实时转录连接: %s (model=%s, source=%s)", client, model, source)

    # 更新模型配置（如果客户端指定了不同模型）
    from config import settings
    if model and model != settings.whisper_model:
        logger.info("客户端请求不同模型: %s (当前: %s)", model, settings.whisper_model)

    # 加载 Whisper 模型
    try:
        await transcriber.load_model()
    except Exception as e:
        logger.error("Whisper 模型加载失败: %s", e)
        await ws.send_json({
            "type": "error",
            "data": {
                "code": "MODEL_LOAD_FAILED",
                "message": f"Whisper 模型加载失败: {e}。请确认已安装 openai-whisper。",
            },
        })
        active_connections.discard(ws)
        return

    # 通知客户端准备就绪
    await ws.send_json({
        "type": "status",
        "data": {
            "state": "ready",
            "mode": "realtime",
            "model": model,
            "source": source,
            "message": "Whisper 转录已就绪，正在启动音频采集...",
        },
    })

    # ── 音频采集 + 转录循环 ─────────────────────────────

    transcription_task: asyncio.Task | None = None
    capture_active = False

    try:
        # 启动音频采集
        from audio.capture import capture_engine

        start_result = capture_engine.start(source=source, device_id=device_id)
        capture_active = capture_engine.is_running

        # 缓存设备音频参数（从 capture_engine 获取，避免重复创建 PyAudio）
        dev_id = capture_engine.device_id
        if dev_id >= 0:
            src_rate = capture_engine.input_rate
            src_channels = capture_engine.input_channels
        else:
            src_rate = settings.audio_sample_rate
            src_channels = 1

        await ws.send_json({
            "type": "status",
            "data": {
                "state": "listening" if capture_active else "idle",
                "source": source,
                "message": start_result.get("message", ""),
            },
        })

        if not capture_active:
            logger.warning("音频采集未能启动: %s", start_result)
            await ws.send_json({
                "type": "error",
                "data": {
                    "code": "CAPTURE_FAILED",
                    "message": f"音频采集启动失败: {start_result.get('message', '未知错误')}",
                },
            })
        else:
            logger.info("音频采集已启动: source=%s", source)

        # ── 转录循环 ─────────────────────────────────────
        while True:
            # 检查前端是否有消息（心跳/停止指令）
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=0.05)
                data = json.loads(msg) if isinstance(msg, str) and msg.startswith("{") else {"type": msg}
                cmd = data.get("type", "")

                if cmd == "ping":
                    await ws.send_json({"type": "pong"})
                elif cmd == "stop":
                    logger.info("客户端请求停止转录")
                    capture_engine.stop()
                    capture_active = False
                    await ws.send_json({
                        "type": "status",
                        "data": {"state": "stopped", "message": "转录已停止"},
                    })
                    break
                elif cmd == "start":
                    if not capture_active:
                        capture_engine.start(source=source, device_id=device_id)
                        capture_active = capture_engine.is_running
                        await ws.send_json({
                            "type": "status",
                            "data": {"state": "listening" if capture_active else "idle"},
                        })
                else:
                    await ws.send_json({
                        "type": "error",
                        "data": {"code": "UNKNOWN_CMD", "message": f"未知指令: {cmd}"},
                    })
            except asyncio.TimeoutError:
                pass

            if not capture_active:
                await asyncio.sleep(0.5)
                continue

            # 从 capture_engine 读取音频块
            try:
                raw_chunk = capture_engine.read_chunk(chunk_duration=0.5)
            except Exception:
                await asyncio.sleep(0.1)
                continue

            if raw_chunk is None or len(raw_chunk) == 0:
                await asyncio.sleep(0.1)
                continue

            # 转换为 Whisper 格式并送入转录器
            try:
                wav_data = capture_engine.convert_to_whisper_format(raw_chunk, src_rate, src_channels)
            except Exception as e:
                logger.debug("音频格式转换失败: %s", e)
                await asyncio.sleep(0.1)
                continue

            # 送入转录器缓冲区
            await transcriber.feed_audio(wav_data)

            # 尝试转录
            segments = await transcriber.transcribe_chunk(
                chunk_duration=chunk_seconds,
                overlap=overlap,
            )
            if segments:
                for seg in segments:
                    await ws.send_json(seg)

                # 通知前端有新语音活动
                await ws.send_json({
                    "type": "status",
                    "data": {"state": "transcribing"},
                })

            # 控制循环频率
            await asyncio.sleep(0.25)

    except WebSocketDisconnect:
        logger.info("WebSocket 实时客户端断开: %s", client)
    except Exception as e:
        logger.error("实时转录异常: %s", e, exc_info=True)
        try:
            await ws.send_json({
                "type": "error",
                "data": {"code": "TRANSCRIBE_ERROR", "message": str(e)},
            })
        except Exception:
            pass
    finally:
        active_connections.discard(ws)
        # 停止音频采集
        try:
            if capture_active:
                from audio.capture import capture_engine
                capture_engine.stop()
        except Exception:
            pass
        logger.info("WebSocket 实时连接关闭: %s (剩余 %d)", client, _count_active())


# ── 管理端点 ─────────────────────────────────────────────────

@router.get("/subtitle/status")
async def ws_status():
    """查询 WebSocket 服务状态"""
    return {
        "active_connections": _count_active(),
        "simulate_available": True,
        "realtime_available": transcriber.is_loaded,
        "simulate_scripts": ["greeting", "daily", "academic"],
        "whisper_loaded": transcriber.is_loaded,
        "whisper_model": transcriber.model_name,
    }
