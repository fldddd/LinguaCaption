# B3/B4/S2 实现方案

> 版本: v1.0 · 2026-05-17 · 作者: 🏗️ Architect

---

## 一、现状分析（已完成部分）

| 组件 | 状态 | 说明 |
|------|:----:|------|
| B2 音频采集 | ✅ 已合并 (PR#4) | WASAPI loopback + 麦克风 + 16kHz mono 格式转换 |
| S1 WebSocket 基础设施 | ✅ 已合并 (PR#4) | websocket.py (/ws/subtitle/simulate + /ws/subtitle/realtime) |
| F3 单词点击 UI | ✅ 已合并 (PR#5) | 分词渲染 + TTS 发音 + 播放高亮（发音段调用为 Mock） |
| F4 悬浮词卡 | ✅ 已合并 (PR#5) | dictionaryapi.dev 外部 API 获取释义 |
| B5/B6 后端 | ✅ 已在 develop | Vocab CRUD + SQLite 数据库 |

**未完成短板：**
- B3 Whisper 转录 — 替换模拟字幕流的真实引擎
- B4 发音API — 替换 F3 的 Mock `/api/audio/segment` 为真实音频裁剪
- S2 全栈联调 — 串联 B2→B3→F3/F4/F5

---

## 二、B3 Whisper 转录模块

### B3.1 模型加载 — 推荐 faster-whisper

**推荐方案：faster-whisper**

| 维度 | openai-whisper | **faster-whisper** ✅ | whisper.cpp |
|:----|:--------------:|:--------------------:|:-----------:|
| 推理速度 | ❌ 慢（需 GPU） | ✅ CTranslate2 4x 加速 | ✅ 最快 |
| Python API | ✅ 原生 | ✅ 原生 | ⚠️ 需 bindings |
| 安装复杂度 | ✅ pip install | ✅ pip install | ❌ 需编译 |
| Windows 支持 | ✅ | ✅ | ⚠️ 需 MSVC |
| word-level timestamps | ✅ | ✅ (v2+) | ✅ |
| 模型大小 | ~1.5GB (base) | ~1.5GB (base) | ~1.5GB (base) |

**选择 faster-whisper 的理由：**
1. pip 一键安装，Windows 友好
2. CPU 推理速度是原版的 4 倍（满足实时需求）
3. 原生支持 word-level timestamps（B3.4 必须）
4. 与当前 requirements.txt 兼容性好

**文件结构：**
```python
python-backend/transcription/
├── __init__.py          # ✅ 已有
├── simulator.py         # ✅ 已有（保留用于测试）
├── whisper_engine.py    # ❌ 新建 — Whisper 模型管理 + 转录引擎
└── config.py            # ❌ 新建 — 模型路径/参数配置
```

**实现方案：**
```python
# transcription/whisper_engine.py （核心约 150 行）

from faster_whisper import WhisperModel

class WhisperEngine:
    def __init__(self, model_size: str = "base"):
        self.model_size = model_size
        self._model = None
        self._load_model()

    def _load_model(self):
        """按需加载模型（首次下载后缓存）"""
        model_path = settings.whisper_model_dir / self.model_size
        self._model = WhisperModel(
            model_size_or_path=str(model_path),
            device="cpu",
            compute_type="int8",  # CPU 量化加速
            download_root=str(settings.whisper_model_dir),
        )

    def transcribe_segment(self, audio: bytes, language: str = "en") -> TranscribeResult:
        """转录一段音频（16kHz mono WAV 格式）"""
        segments, info = self._model.transcribe(
            audio,
            language=language,
            beam_size=5,
            word_timestamps=True,  # ← B3.4 需要
            vad_filter=True,        # 语音活动检测
        )
        return TranscribeResult(
            segments=list(segments),
            duration=info.duration,
            language=info.language,
        )

    def switch_model(self, model_size: str):
        """切换模型大小（B3.6）"""
        self.model_size = model_size
        self._load_model()
```

### B3.2 音频分段转录 — 滑窗策略

**输入源：** B2 音频模块通过 WebSocket `/api/audio/ws` 推送的 0.5s PCM chunk

**滑窗策略：**
```
时间轴:  0s    15s    30s    45s    60s
Chunk:   |####|####|####|####|####|####|...
         |←── 转录窗口 30s ──→|
                 |←── 重叠 15s ──→|
                         |←── 窗口 ──→|
```

**Buffer 实现：**
```python
# transcription/audio_buffer.py （约 80 行）

class AudioBuffer:
    def __init__(self, window_size: float = 30.0, hop_size: float = 15.0, sample_rate: int = 16000):
        self.window_frames = int(window_size * sample_rate)
        self.hop_frames = int(hop_size * sample_rate)
        self.buffer = bytearray()

    def push(self, chunk: bytes):
        """添加音频块到缓冲区（0.5s 的 16kHz mono PCM = 16000 字节）"""
        self.buffer.extend(chunk)
        # 保留最近 window_size 的数据
        if len(self.buffer) > self.window_frames * 2:
            self.buffer = self.buffer[-self.window_frames * 2:]

    def get_segment(self) -> Optional[bytes]:
        """获取下一个待转录的窗口数据"""
        if len(self.buffer) >= self.window_frames:
            segment = bytes(self.buffer[:self.window_frames])
            # 步进（保留 hop 大小的重叠部分）
            self.buffer = self.buffer[self.hop_frames:]
            return segment
        return None
```

**滑窗优势：** 避免句首/句尾截断，Whisper 在上下文中识别更准确。

### B3.3 流式转录引擎 — WebSocket 集成

**对接点位：** `websocket.py` 中 `/ws/subtitle/realtime` 占位端点

```python
# api/websocket.py 修改 — 替换 Phase 2 占位代码（约 +80 行）

@router.websocket("/subtitle/realtime")
async def websocket_realtime(ws: WebSocket):
    await ws.accept()
    active_connections.add(ws)

    engine = WhisperEngine(model_size="base")
    buffer = AudioBuffer()

    try:
        # 等待 start 指令
        async for raw in ws.iter_json():
            if raw.get("type") == "start":
                await ws.send_json({
                    "type": "status",
                    "data": {"state": "listening", "language": raw.get("language", "en")}
                })
                break
    except WebSocketDisconnect:
        return

    # 开始接收 B2 音频流
    try:
        async for audio_chunk in ws.iter_bytes():  # 二进制音频帧
            buffer.push(audio_chunk)
            segment = buffer.get_segment()
            if segment:
                result = await asyncio.to_thread(  # 异步执行阻塞转录
                    engine.transcribe_segment, segment
                )
                for seg in result.segments:
                    await ws.send_json({
                        "type": "subtitle",
                        "data": {
                            "text": seg.text,
                            "start_time": seg.start,
                            "end_time": seg.end,
                            "words": [
                                {"word": w.word, "start": w.start, "end": w.end}
                                for w in (seg.words or [])
                            ],
                            "is_final": True,
                        }
                    })
    except WebSocketDisconnect:
        pass
```

**架构关系（数据流）：**
```
前端 Mock → (F2 实时模式) → WebSocket Client
  │
  ├─ 旧路（模拟）: /ws/subtitle/simulate  ← SubtitleSimulator
  │
  └─ 新路（真实）: /ws/subtitle/realtime
       │
       ├── 接收 B2 音频流 → AudioBuffer → WhisperEngine
       │
       └── 推送转录结果 → (type: "subtitle", words: [...])
```

### B3.4 时间戳提取 — word-level timestamps

faster-whisper 的 `word_timestamps=True` 输出格式：

```json
{
  "words": [
    {"word": "Hello",  "start": 0.12, "end": 0.35, "probability": 0.98},
    {"word": "world",  "start": 0.36, "end": 0.62, "probability": 0.95},
    {"word": "This",   "start": 0.80, "end": 0.95, "probability": 0.97},
    {"word": "is",     "start": 0.96, "end": 1.05, "probability": 0.99},
    ...
  ]
}
```

**F3 桥接：** 前端 F3 点击单词时携带 `word` 和 `start_time`，调用：
```
GET /api/audio/segment?word=Hello&source_audio=uuid&start=0.12&end=0.35
```
即桥接到 B4 发音API。

### B3.5 模型切换 API

```python
# api/transcription.py 新增端点

@router.post("/model/switch")
def switch_model(model_size: str = Query("base", regex="^(tiny|base|small|medium|large)$")):
    """切换 Whisper 模型大小"""
    whisper_engine.switch_model(model_size)
    return {"status": "ok", "model": model_size, "message": f"已切换到 {model_size} 模型"}

@router.get("/model/status")
def model_status():
    """查询当前模型和可用模型"""
    return {
        "current": whisper_engine.model_size,
        "available": ["tiny", "base", "small"],  # large/medium 太大不建议
        "loaded": whisper_engine.is_loaded,
    }
```

---

## 三、B4 发音提取 API

### 设计方案

**端点：** `GET /api/audio/segment`

**替换当前 Mock 实现：**
```python
# api/audio.py — 替换 get_audio_segment 函数

@router.get("/segment")
async def get_audio_segment(
    word: str = Query(..., description="单词"),
    source_audio: str = Query(..., description="源音频文件 UUID"),
    start: float = Query(..., description="单词起始时间"),
    end: float = Query(..., description="单词结束时间"),
):
    """从录音文件中裁剪单词音频段"""
    audio_path = Path(settings.audio_upload_dir) / f"{source_audio}.wav"
    if not audio_path.exists():
        return JSONResponse(
            status_code=404,
            content={"detail": f"音频文件不存在: {source_audio}"}
        )

    # 使用 pydub 或 ffmpeg 裁剪（推荐 pydub — pure Python）
    from pydub import AudioSegment

    audio = AudioSegment.from_file(str(audio_path))
    segment = audio[start * 1000: end * 1000]  # pydub 用毫秒

    # 输出 16kHz mono WAV
    segment = segment.set_frame_rate(16000).set_channels(1)

    import io
    buf = io.BytesIO()
    segment.export(buf, format="wav")
    buf.seek(0)

    return Response(content=buf.read(), media_type="audio/wav")
```

### 依赖
```
# requirements.txt 新增
faster-whisper>=1.1.0
pydub>=0.25.1
```

---

## 四、S2 全栈联调步骤

### Step 1 — F3 替换 Mock 发音API
- **动作：** 修改 `api.js::getAudioSegment()` 调用真实端点
- **验证：** 点击单词 → 播放真实的单词发音（从录音裁剪）
- **估计：** 0.5h

### Step 2 — F2 实时字幕模式对接 WebSocket
- **动作：** 修改 F2 `startRealtimeMode()` 从 `setInterval(mock)` 改为 WebSocket 连接
- **WebSocket 地址：** `ws://localhost:8000/api/ws/subtitle/realtime`
- **验证：** 选择系统音频播放视频 → 字幕区实时显示转录文本
- **估计：** 1h

### Step 3 — 端到端测试
- **测试流程：** 启动应用 → 选择系统音频 → 播放英语视频 → 实时字幕 → 点击单词 → 发音 → 收藏生词
- **延迟验收：** 从说话到字幕显示 < 5s
- **估计：** 1h

### Step 4 — 错误处理增强
- B2 启动时未选择音频源 → 提示用户
- Whisper 模型加载失败 → 降级到模拟模式
- WebSocket 断线重连 → 自动重连 + 状态提示
- **估计：** 1h

---

## 五、工作量与分工

| 任务 | 工时 | 建议负责人 | 优先级 |
|:----|:----:|:----------:|:------:|
| B3.1 Whisper 模型加载 | 2h | Developer | P0 |
| B3.2 音频缓冲 (AudioBuffer) | 1h | Developer | P0 |
| B3.3 流式转录引擎 (WebSocket 集成) | 3h | Developer | P0 |
| B3.4 时间戳提取 | 1h | Developer | P0 |
| B3.5 模型切换 API | 1h | Developer | P1 |
| B4 发音提取 API | 2h | Developer | P1 |
| S2.1 F3 Mock→真实 | 0.5h | Developer | P1 |
| S2.2 F2 Mock→WebSocket | 1h | Developer | P1 |
| S2.3 端到端测试 | 1h | QA / Reviewer | P1 |
| S2.4 错误处理 | 1h | Developer | P2 |
| **合计** | **13.5h** | Developer (主) | |

### 里程碑建议

```
Phase 2.1 (8h) — B3 核心通路
  ├── B3.1 模型加载 ✅
  ├── B3.2 音频缓冲 ✅
  └── B3.3 流式转录 ✅ → 实时字幕从 sim 切换为真实

Phase 2.2 (4.5h) — 发音 + 联调
  ├── B3.4 时间戳 + B4 发音API ✅
  └── S2.1 + S2.2 前后端对接 ✅

Phase 2.3 (2h) — 收尾
  ├── B3.5 模型切换 API
  └── S2.3 + S2.4 测试 + 错误处理
```

---

## 六、风险项

| 风险 | 影响 | 概率 | 应对 |
|:----|:----|:----:|:----|
| faster-whisper 首次模型下载慢（~1.5GB） | 启动时间长 | 高 | 提供预下载脚本（`npm run download-models`） |
| CPU 转录延迟 > 5s | 字幕不及时 | 中 | 使用 `tiny` 模型验证延迟，优化窗口大小 |
| 音频流双 WS 连接复杂（B2→B3→前端） | 调试困难 | 中 | S2 阶段先走 B2 本地 Buffer + 单 WS 通路 |
| pydub/ffmpeg 依赖问题 | B4 不可用 | 低 | 备选：直接用 wave + numpy 裁剪 |
