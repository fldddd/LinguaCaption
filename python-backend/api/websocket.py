"""WebSocket 端点 — 实时字幕流 + 音频源状态推送

集成 NLP 解析和会话生命周期管理（Phase 4.3）
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from audio.source_manager import source_manager
from database.crud import create_session, close_session, insert_fragment
from database import get_session
from services.nlp_service import nlp_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ws", tags=["websocket"])

# 延迟导入：避免 faster_whisper 未安装时阻止后端启动
_WHISPER_AVAILABLE = False


def _get_transcription_components():
    """延迟加载 transcription 模块"""
    global _WHISPER_AVAILABLE
    if _WHISPER_AVAILABLE:
        from transcription import AudioBuffer, WhisperEngine
        return AudioBuffer, WhisperEngine
    try:
        from transcription import AudioBuffer, WhisperEngine
        _WHISPER_AVAILABLE = True
        return AudioBuffer, WhisperEngine
    except Exception as exc:
        logger.warning("Whisper transcription unavailable: %s", exc)
        _WHISPER_AVAILABLE = False
        return None, None


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
# B2-UPGRADE: 音频源状态推送 WebSocket
# ====================================================================


@router.websocket("/audio/status")
async def websocket_audio_status(ws: WebSocket):
    """音频源状态实时推送 WebSocket

    每 0.5s 推送当前音频源状态：
    - 源类型
    - 音量电平
    - 设备信息
    - 运行状态

    客户端也可以发送命令：
    {"type": "switch", "source": "system", "device_id": -1}
    {"type": "stop"}
    {"type": "ping"}
    """
    await ws.accept()
    active_connections.add(ws)
    logger.info("Audio status WS connected")

    push_running = True

    async def _status_push_loop():
        """定期推送音频状态"""
        while push_running:
            try:
                status = source_manager.get_status()
                await _send_json(ws, {
                    "type": "audio_status",
                    "data": status,
                })
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break
            except Exception:
                break

    push_task = asyncio.create_task(_status_push_loop())

    try:
        async for raw in ws.iter_json():
            if not isinstance(raw, dict):
                continue

            msg_type = raw.get("type", "")

            if msg_type == "ping":
                await _send_json(ws, {"type": "pong"})

            elif msg_type == "switch":
                source = raw.get("source", "none")
                device_id = raw.get("device_id", -1)
                result = await source_manager.switch_source(source, device_id)
                status = source_manager.get_status()
                status["message"] = result.get("message", "")
                await _send_json(ws, {
                    "type": "audio_status",
                    "data": status,
                })

            elif msg_type == "stop":
                await source_manager.stop()
                status = source_manager.get_status()
                await _send_json(ws, {
                    "type": "audio_status",
                    "data": status,
                })

            elif msg_type == "devices":
                devices = source_manager.list_devices()
                await _send_json(ws, {
                    "type": "audio_devices",
                    "data": devices,
                })

    except WebSocketDisconnect:
        logger.info("Audio status WS disconnected")
    except Exception as exc:
        logger.exception("Audio status WS error: %s", exc)
    finally:
        push_running = False
        push_task.cancel()
        try:
            await asyncio.wait_for(push_task, timeout=1.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        active_connections.discard(ws)
        logger.info("Audio status WS cleanup done")


async def _nlp_and_store(
    text: str,
    language: str,
    session_id: int,
    start_time: float,
    end_time: float,
    source_type: str,
    source_name: str,
) -> None:
    """异步 NLP 解析 + 存储 TranscriptFragment（超时 5s 则跳过）"""
    try:
        # NLP 解析（异步执行，超时 5s）
        try:
            parsed = await asyncio.wait_for(
                asyncio.to_thread(nlp_service.parse, text, language),
                timeout=5.0,
            )
            logger.debug(
                "NLP parsed %d tokens, %d phrases for fragment",
                len(parsed.tokens),
                len(parsed.phrases),
            )
        except asyncio.TimeoutError:
            logger.warning("NLP parsing timed out (>5s), skipping for text: %.60s", text)
            parsed = None

        # 插入 TranscriptFragment
        db = get_session()
        try:
            frag = insert_fragment(
                db=db,
                session_id=session_id,
                text=text,
                language=language,
                start_time=start_time,
                end_time=end_time,
                source_type=source_type,
                source_name=source_name,
            )
            logger.debug("Fragment stored: id=%d, session=%d", frag.id, session_id)
        finally:
            db.close()
    except Exception as exc:
        logger.warning("NLP/store error (non-blocking): %s", exc)


# ====================================================================
# 实时转录端点（B3 核心）+ B2-UPGRADE 音频源集成 + Phase 4.3 NLP
# ====================================================================


@router.websocket("/subtitle/realtime")
async def websocket_realtime(ws: WebSocket):
    """实时 Whisper 转录 WebSocket 端点

    协议流程:
    1. 客户端连接
    2. 客户端发送 {"type": "start", "language": "en"}
    3. 服务端回复 {"type": "status", "data": {"state": "listening", "language": "en"}}
    4. 客户端持续发送二进制音频块（16kHz mono int16 PCM）
       或者使用 {"type": "use_source", "source": "system"} 使用系统音频源
    5. 服务端持续推送 {"type": "subtitle", "data": {"text": "...", "words": [...], ...}}
       以及 {"type": "audio_status", "data": {...}} 音频源状态
    6. 客户端发送 {"type": "stop"} 或断线结束
    """
    await ws.accept()
    active_connections.add(ws)
    logger.info("Realtime WS connected (B2-UPGRADE)")

    # ---- 初始化组件 ----
    engine = None
    buffer = None
    language: str = "en"
    stop_event = asyncio.Event()
    transcriptions_done = asyncio.Event()
    using_source_manager = False  # 是否使用音频源管理器输入
    session_id: Optional[int] = None  # 会话ID（Phase 4.3）

    # 当从音频源管理器收到 PCM chunk 时调用此回调
    def _on_source_chunk(pcm_bytes: bytes):
        nonlocal buffer
        if buffer is not None:
            buffer.push(pcm_bytes)

    async def _on_source_status(status: dict):
        await _send_json(ws, {
            "type": "audio_status",
            "data": status,
        })

    async def _transcription_loop():
        """后台转录循环：从 AudioBuffer 取段、转录、推送 + NLP 解析"""
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

                start_time = round(result.words[0].start, 2) if result.words else 0.0
                end_time = round(result.words[-1].end, 2) if result.words else 0.0

                # 推送字幕结果（先推送，不阻塞）
                await _send_json(ws, {
                    "type": "subtitle",
                    "data": {
                        "text": result.text,
                        "words": [w.to_dict() for w in result.words],
                        "start_time": start_time,
                        "end_time": end_time,
                        "duration": round(result.duration, 2),
                        "is_final": True,
                    },
                })

                # --- NLP 异步解析 + 片段存储（不阻塞字幕推送） ---
                if session_id is not None:
                    asyncio.create_task(
                        _nlp_and_store(
                            text=result.text,
                            language=language,
                            session_id=session_id,
                            start_time=start_time,
                            end_time=end_time,
                            source_type="realtime",
                            source_name="",
                        )
                    )

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

                # 延迟导入 transcription 组件
                AudioBuffer, WhisperEngine = _get_transcription_components()
                if AudioBuffer is None or WhisperEngine is None:
                    await _send_json(ws, {
                        "type": "error",
                        "data": {
                            "code": "WHISPER_UNAVAILABLE",
                            "message": "Whisper 转录引擎不可用，请安装 faster-whisper 依赖",
                        },
                    })
                    return

                # 初始化引擎和缓冲区
                engine = WhisperEngine(model_size=model_size)
                buffer = AudioBuffer()

                # ---- Phase 4.3: 创建会话 ----
                db = get_session()
                try:
                    session_obj = create_session(
                        db=db,
                        session_type="realtime",
                        language=language,
                        source_type="realtime",
                        source_name=f"ws_realtime_{language}",
                    )
                    session_id = session_obj.id
                    logger.info("Session created: id=%d, language=%s", session_id, language)
                finally:
                    db.close()

                # 检查是否要使用音频源管理器
                use_source = raw.get("use_source", None)
                if use_source and use_source != "none":
                    using_source_manager = True
                    source_manager.set_on_chunk(_on_source_chunk)
                    source_manager.set_on_status(_on_source_status)
                    await source_manager.switch_source(use_source)
                    logger.info("Realtime using source manager: %s", use_source)

                await _send_json(ws, {
                    "type": "status",
                    "data": {
                        "state": "listening",
                        "language": language,
                        "model": model_size,
                        "using_source": use_source or "client_stream",
                    },
                })

                # 通知前端会话已创建
                await _send_json(ws, {
                    "type": "session_started",
                    "session_id": session_id,
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
            if using_source_manager:
                # 使用音频源管理器的数据，等待 stop 信号
                async for raw in ws.iter_json():
                    if not isinstance(raw, dict):
                        continue
                    msg_type = raw.get("type", "")
                    if msg_type == "stop":
                        break
                    elif msg_type == "switch":
                        src = raw.get("source", "none")
                        dev_id = raw.get("device_id", -1)
                        await source_manager.switch_source(src, dev_id)
                    elif msg_type == "ping":
                        await _send_json(ws, {"type": "pong"})
            else:
                # 客户端直接发送音频 bytes
                async for audio_chunk in ws.iter_bytes():
                    if stop_event.is_set():
                        break
                    if buffer is not None:
                        buffer.push(audio_chunk)

        except WebSocketDisconnect:
            logger.info("Realtime WS disconnected during audio streaming")

        # ---- 清理 ----
        stop_event.set()

        if using_source_manager:
            await source_manager.stop()
            source_manager.set_on_chunk(None)
            source_manager.set_on_status(None)

        transcribe_task.cancel()
        try:
            await asyncio.wait_for(transcribe_task, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

        # 关闭会话
        if session_id is not None:
            db = get_session()
            try:
                closed = close_session(db, session_id)
                if closed:
                    logger.info("Session %d closed (stop)", session_id)
                else:
                    logger.warning("Session %d not found on close", session_id)
            finally:
                db.close()

    except WebSocketDisconnect:
        logger.info("Realtime WS disconnected during start phase")
    except Exception as exc:
        logger.exception("Realtime WS error: %s", exc)
    finally:
        # 确保清理
        if using_source_manager:
            await source_manager.stop()
            source_manager.set_on_chunk(None)
            source_manager.set_on_status(None)
        # 关闭会话（如果未在正常停止流程中关闭）
        if session_id is not None:
            db = get_session()
            try:
                closed = close_session(db, session_id)
                if closed:
                    logger.info("Session %d closed (finally)", session_id)
            finally:
                db.close()
        active_connections.discard(ws)
        logger.info("Realtime WS disconnected")
