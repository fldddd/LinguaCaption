"""
WebSocket 实时字幕端点 — s1-s2 桥接组件

提供两个入口:
1. `/ws/subtitle/simulate` — 模拟字幕流（Phase 2 前的 demo/测试）
2. `/ws/subtitle/realtime` — 真实 Whsiper 转录（Phase 2 实现）

模拟模式直接在 ws handler 中启动 SubtitleSimulator，
真实模式等待 Whisper 模块就绪后替换。
"""

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from transcription.simulator import SubtitleSimulator

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ws", tags=["websocket"])

# ── 活跃连接跟踪 ────────────────────────────────────────────
active_connections: set[WebSocket] = set()


def _count_active() -> int:
    """返回当前活跃的 WebSocket 连接数（清理断开的）"""
    dead = {ws for ws in active_connections if ws.client_state.name == "DISCONNECTED"}
    active_connections.difference_update(dead)
    return len(active_connections)


def _send_json(ws: WebSocket, data: dict):
    """安全发送 JSON 消息"""
    import anyio
    try:
        # FastAPI 的 WebSocket.send_json 是协程
        pass
    except Exception:
        pass


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


# ── 实时字幕（Phase 2 桩） ──────────────────────────────────

@router.websocket("/subtitle/realtime")
async def websocket_realtime(ws: WebSocket):
    """占位：Phase 2 接入真实 Whisper 转录"""
    await ws.accept()
    active_connections.add(ws)
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    logger.info("WebSocket 实时连接 (占位): %s", client)

    try:
        await ws.send_json({
            "type": "status",
            "data": {
                "state": "idle",
                "mode": "realtime",
                "message": "实时转录模式（Phase 2 待实现）",
                "note": "请使用 /ws/subtitle/simulate 测试，或等待 Phase 2 发布",
            },
        })

        # 等待客户端指令（Phase 2 实现真正的音频流处理）
        async for raw in ws.iter_json():
            logger.info("收到客户端消息: %s", raw)
            msg = raw if isinstance(raw, dict) else json.loads(raw)
            cmd = msg.get("type", "")

            if cmd == "ping":
                await ws.send_json({"type": "pong"})
            elif cmd == "start":
                await ws.send_json({
                    "type": "status",
                    "data": {"state": "listening", "message": "Phase 2 功能"},
                })
            else:
                await ws.send_json({
                    "type": "error",
                    "data": {"code": "UNKNOWN_CMD", "message": f"未知指令: {cmd}"},
                })

    except WebSocketDisconnect:
        logger.info("实时 WebSocket 客户端断开: %s", client)
    except Exception as e:
        logger.error("实时 WebSocket 异常: %s", e, exc_info=True)
    finally:
        active_connections.discard(ws)


# ── 管理端点 ─────────────────────────────────────────────────

@router.get("/subtitle/status")
async def ws_status():
    """查询 WebSocket 服务状态"""
    return {
        "active_connections": _count_active(),
        "simulate_available": True,
        "realtime_available": False,  # Phase 2
        "simulate_scripts": ["greeting", "daily", "academic"],
    }
