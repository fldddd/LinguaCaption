"""WebSocket 端点 — 实时字幕流"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from transcription import AudioBuffer, WhisperEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ws", tags=["websocket"])

# 活跃连接追踪
active_connections: set[WebSocket] = set()


# ====================================================================
# 辅助函数
# ====================================================================


async def _send_json(ws: WebSocket, data: dict) -> None:
    """安全发送 JSON 消息（捕获断线异常）"""
    try:
        await ws.send_json(data)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket send error: %s", exc)


async def _handle_ping_pong(ws: WebSocket) -> None:
    """处理 WebSocket ping/pong 心跳

    FastAPI 的 starlette 通常自动响应 ping，这里保持兼容
    客户端发送 {"type": "ping"} 时回复 {"type": "pong"}
    """
    try:
        async for message in ws.iter_json():
            if isinstance(message, dict) and message.get("type") == "ping":
                await _send_json(ws, {"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as exc:
        logger.debug("Ping/pong error: %s", exc)


# ====================================================================
# 公共 WebSocket 端点
# ====================================================================


@router.websocket("/subtitle/simulate")
async def websocket_simulate(ws: WebSocket):
    """模拟字幕流（保留旧的模拟端点用于测试）"""
    await ws.accept()
    active_connections.add(ws)
    logger.info("Simulate WS connected")

    try:
        import random
        import string

        sample_texts = [
            "Hello, welcome to the real-time subtitle demonstration.",
            "This is a simulated subtitle stream for testing purposes.",
            "The quick brown fox jumps over the lazy dog.",
            "English is a global language spoken by millions.",
            "Learning a new language opens doors to new opportunities.",
        ]

        while True:
            # 检查 ping 并保持连接
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=1.0)
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await _send_json(ws, {"type": "pong"})
            except asyncio.TimeoutError:
                pass  # 继续发送模拟数据
            except WebSocketDisconnect:
                break
            except json.JSONDecodeError:
                pass

            text = random.choice(sample_texts)
            words = []
            start = 0.0
            for w in text.split():
                duration = random.uniform(0.15, 0.4)
                words.append({
                    "word": w.strip(string.punctuation),
                    "start": round(start, 2),
                    "end": round(start + duration, 2),
                    "probability": round(random.uniform(0.85, 1.0), 2),
                })
                start += duration

            await _send_json(ws, {
                "type": "subtitle",
                "data": {
                    "text": text,
                    "words": words,
                    "start_time": 0.0,
                    "end_time": round(start, 2),
                    "is_final": True,
                },
            })

            await asyncio.sleep(3.0)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("Simulate WS error: %s", exc)
    finally:
        active_connections.discard(ws)
        logger.info("Simulate WS disconnected")


# ====================================================================
# 实时转录端点（B3 核心）
# ====================================================================


@router.websocket("/subtitle/realtime")
async def websocket_realtime(ws: WebSocket):
    """实时 Whisper 转录 WebSocket 端点

    协议流程:
    1. 客户端连接
    2. 客户端发送 {"type": "start", "language": "en"}
    3. 服务端回复 {"type": "status", "data": {"state": "listening", "language": "en"}}
    4. 客户端持续发送二进制音频块（16kHz mono int16 PCM）
    5. 服务端持续推送 {"type": "subtitle", "data": {"text": "...", "words": [...], ...}}
    6. 客户端发送 {"type": "stop"} 或断线结束
    """
    await ws.accept()
    active_connections.add(ws)
    logger.info("Realtime WS connected")

    # ---- 初始化组件 ----
    engine: Optional[WhisperEngine] = None
    buffer: Optional[AudioBuffer] = None
    language: str = "en"
    stop_event = asyncio.Event()
    transcriptions_done = asyncio.Event()

    async def _transcription_loop():
        """后台转录循环：从 AudioBuffer 取段、转录、推送"""
        nonlocal engine, buffer

        if engine is None or buffer is None:
            logger.error("Transcription loop started without engine/buffer")
            return

        try:
            while not stop_event.is_set():
                segment = buffer.get_segment()
                if segment is None:
                    # 缓冲区不够一个窗口，短暂等待
                    await asyncio.sleep(0.2)
                    continue

                # 在后台线程中执行阻塞的转录
                try:
                    result = await asyncio.to_thread(
                        engine.transcribe_segment,
                        segment,
                        language,
                    )
                except Exception as exc:
                    logger.exception("Transcription failed: %s", exc)
                    await _send_json(ws, {
                        "type": "error",
                        "data": {"message": f"Transcription error: {exc}"},
                    })
                    continue

                if not result.text.strip():
                    continue

                # 推送字幕结果
                await _send_json(ws, {
                    "type": "subtitle",
                    "data": {
                        "text": result.text,
                        "words": [w.to_dict() for w in result.words],
                        "start_time": round(result.words[0].start, 2) if result.words else 0.0,
                        "end_time": round(result.words[-1].end, 2) if result.words else 0.0,
                        "duration": round(result.duration, 2),
                        "is_final": True,
                    },
                })

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("Transcription loop error: %s", exc)
        finally:
            transcriptions_done.set()

    try:
        # ---- Phase 1: 等待 start 指令 ----
        async for raw in ws.iter_json():
            if not isinstance(raw, dict):
                continue

            msg_type = raw.get("type", "")

            if msg_type == "start":
                language = raw.get("language", "en")
                model_size = raw.get("model", "base")

                logger.info(
                    "Realtime start: language=%s, model=%s",
                    language,
                    model_size,
                )

                # 初始化引擎和缓冲区
                engine = WhisperEngine(model_size=model_size)
                buffer = AudioBuffer()

                await _send_json(ws, {
                    "type": "status",
                    "data": {
                        "state": "listening",
                        "language": language,
                        "model": model_size,
                    },
                })

                # 启动后台转录任务
                transcribe_task = asyncio.create_task(_transcription_loop())
                break

            elif msg_type == "ping":
                await _send_json(ws, {"type": "pong"})

            else:
                await _send_json(ws, {
                    "type": "error",
                    "data": {"message": f"Expected 'start' command, got '{msg_type}'"},
                })

        else:
            # ws.iter_json 结束但没收到 start
            logger.warning("Realtime WS closed before start command")
            return

        # ---- Phase 2: 接收音频流 ----
        try:
            async for audio_chunk in ws.iter_bytes():
                if stop_event.is_set():
                    break

                if buffer is not None:
                    buffer.push(audio_chunk)

        except WebSocketDisconnect:
            logger.info("Realtime WS disconnected during audio streaming")

        # ---- 清理 ----
        stop_event.set()
        transcribe_task.cancel()
        try:
            await asyncio.wait_for(transcribe_task, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

    except WebSocketDisconnect:
        logger.info("Realtime WS disconnected during start phase")
    except Exception as exc:
        logger.exception("Realtime WS error: %s", exc)
    finally:
        active_connections.discard(ws)
        logger.info("Realtime WS disconnected")
