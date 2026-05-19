# 转录字幕速度优化方案

> F4: 分析并优化实时 Whisper 转录字幕的速度瓶颈
> 撰写日期: 2026-05-19
> 所属分支: feat/f4-speed-optimization

---

## 1. 当前架构概览

```
┌──────────────┐    ┌──────────────────┐    ┌────────────────┐    ┌─────────────────┐
│ Audio Capture │───▶│ Source Manager   │───▶│ AudioBuffer    │───▶│ WhisperEngine   │
│ (WASAPI/Mic)  │    │ (convert+resample)│   │ (30s window)   │    │ (transcribe)    │
│ 48kHz stereo  │    │ 16kHz mono PCM   │    │ 15s hop (50%)  │    │ beam_size=5     │
│ 0.5s/chunk    │    │ 0.5s/chunk       │    │                │    │ word_timestamps │
└──────────────┘    └──────────────────┘    └────────────────┘    └─────────────────┘
                                                      │
                                                      ▼
                                              ┌─────────────────┐
                                              │ WebSocket       │
                                              │ /subtitle/realtime│
                                              └─────────────────┘
```

## 2. 关键文件

| 文件 | 路径 | 作用 |
|------|------|------|
| `whisper_engine.py` | `python-backend/transcription/whisper_engine.py` | faster-whisper 模型封装，核心转录逻辑 |
| `audio_buffer.py` | `python-backend/transcription/audio_buffer.py` | 滑窗缓冲区（30s window, 15s hop） |
| `websocket.py` | `python-backend/api/websocket.py` | WebSocket 实时转录端点 |
| `capture.py` | `python-backend/audio/capture.py` | WASAPI/Mic 音频采集 + 格式转换 |
| `source_manager.py` | `python-backend/audio/source_manager.py` | 统一音频源管理 + 采集循环 |
| `config.py` | `python-backend/config.py` | 全局配置 |

## 3. 瓶颈分析（按严重程度排序）

### 🚨 P0: AudioBuffer 窗口过大（首要瓶颈）

**当前配置**:
- `window_size = 30s`（需要积累 30 秒音频才触发首次转录）
- `hop_size = 15s`（之后每 15 秒转录一次）

**问题**: 用户需要等 **30 秒**才能看到第一条字幕！这完全不符合"实时"体验。

**定位**: `transcription/audio_buffer.py` 第 29-34 行

**影响范围**: 所有使用 WebSocket 实时转录的用户。

### 🚨 P1: beam_size 过大

**当前值**: `beam_size=5`

**影响**: beam search 规模直接决定推理时间。beam_size=5 比 beam_size=1 慢 3-5 倍。对于实时场景，beam_size=1 (greedy) 通常已足够。

**定位**: `whisper_engine.py` 第 152 行、第 235 行

### ⚠️ P2: word_timestamps 始终开启

**当前**: `word_timestamps=True` 强制启用

**影响**: 词级时间戳需要额外的 alignment 模型运行，增加约 20-30% 的推理时间。如果前端不需要词级高亮可以关闭，或改为按需开启。

**定位**: `whisper_engine.py` 第 153 行、第 236 行

### ⚠️ P3: VAD 过滤增加延迟

**当前**: `vad_filter=True`, `min_silence_duration_ms=500`

**影响**: VAD 预处理需要额外计算，且可能因为静音检测导致转录被延迟。在实时场景下，轻量级 VAD 更合适。

**定位**: `whisper_engine.py` 第 154-158 行

### ℹ️ P4: 每次转录都重新创建 numpy array

**当前**: `transcribe_segment()` 每次调用都执行 `np.frombuffer` + 类型转换

**影响**: 轻微。但 30s 的 16kHz mono PCM = 960,000 个 sample，大量重复的内存分配有累积开销。

**定位**: `whisper_engine.py` 第 147 行

### ℹ️ P5: 音频重采样使用 np.interp

**当前**: `convert_to_whisper_format()` 使用 `np.interp` 线性插值

**影响**: 功能正确但精度一般，且大块音频重采样有 CPU 开销。可考虑 librosa 或 scipy.signal.resample。

**定位**: `capture.py` 第 626-630 行

## 4. 优化方案（按优先级排列）

### 方案 A: 缩短 AudioBuffer 窗口（P0 — 必须做）

```python
# 修改 audio_buffer.py 默认值
AudioBuffer(
    window_size=3.0,    # 从 30s → 3s
    hop_size=2.0,       # 从 15s → 2s
)
```

**效果**: 用户 3 秒后就能看到第一条字幕，之后每 2 秒更新一次。
**风险**: 转录更短片段可能降低准确率（Whisper 在更长音频上表现更好）。可通过 `condition_on_previous_text=True` 缓解。

**备选方案 A2**: `window_size=5.0, hop_size=2.5`（更平衡）
**备选方案 A3**: 做成可配置参数，前端可以按需调整。

### 方案 B: 降低 beam_size（P1 — 建议做）

```python
# 修改 whisper_engine.py
beam_size=1,  # 从 5 → 1（greedy decoding）
# 或 beam_size=2 做轻度 beam search
```

**效果**: 推理速度提升 3-5 倍。
**风险**: beam_size=1 可能略微降低转录准确率，但对清晰语音影响极小。

### 方案 C: 按需启用 word_timestamps（P2 — 建议做）

```python
# 修改 whisper_engine.py，允许调用方控制
word_timestamps=False,  # 默认关闭

# 当前端需要词级高亮时单独传入参数
def transcribe_segment(self, audio_bytes, language="en", word_timestamps=False):
```

**效果**: 减少约 20-30% 推理时间。

### 方案 D: 改用 tiny 模型作为实时默认

| 模型 | 参数量 | 速度 (相对) | 准确率 | 内存 |
|------|--------|-------------|--------|------|
| tiny | 39M | **10x base** | 略低 | ~150MB |
| base | 74M | 1x (基准) | 基准 | ~300MB |
| small | 244M | ~0.3x | 更高 | ~1GB |

**建议**: 实时模式默认使用 `tiny`，离线文件转录使用 `base` 或 `small`。

**实现**: 在 `websocket.py` 中修改默认值 `model_size = raw.get("model", "tiny")`（原为 `"base"`），或根据 `use_source` 自动选择。

### 方案 E: 添加 condition_on_previous_text

当前 faster-whisper 没有显式设置此参数，默认行为可能因上下文不足导致重复/遗漏。

```python
# 保持简短的窗口时，用之前的结果作为 prompt
prompt = previous_text if previous_text else None

self._model.transcribe(
    raw,
    language=language,
    beam_size=beam_size,
    word_timestamps=word_timestamps,
    vad_filter=vad_filter,
    initial_prompt=prompt,  # 传递前一段文本保持连贯
)
```

### 方案 F: VAD 参数调优

```python
vad_parameters=dict(
    min_silence_duration_ms=300,  # 从 500 降低
    threshold=0.3,                 # 从 0.5 降低（更敏感）
)
```

或在实时模式干脆禁用 VAD（音频采集层本身已有静音检测）。

### 方案 G: 模型预加载 + 预热（首次转录优化）

当前首次加载模型 + 首次转录都比较慢，因为模型需要 JIT 编译。

```python
# 在应用启动时预热模型
def warmup(self):
    """用一段静音音频预热模型，减少首次转录延迟"""
    dummy = np.zeros(16000 * 3, dtype=np.float32)  # 3秒静音
    self._model.transcribe(dummy, language="en", beam_size=1)
```

### 方案 H: 使用流式转录（faster-whisper 原生支持）

faster-whisper 支持 `VADFilter` + `WhisperModel` 的流式处理。可探索使用 `ctranslate2` 的 `StreamingState` 实现真正的逐帧转录，而非固定窗口。

但是，这需要较大的架构变更，目前阶段**不推荐**。先优化参数即可获得 5-10 倍速度提升。

## 5. 预期效果

| 优化项 | 预计提升 | 实现难度 |
|--------|---------|---------|
| AudioBuffer 窗口 30s→3s | 首条字幕延迟从 30s→3s (10x) | 低 (改默认值) |
| beam_size 5→1 | 推理速度 3-5x | 低 (改参数) |
| word_timestamps 按需 | 推理速度 1.2-1.3x | 低 (加参数) |
| tiny 替代 base | 推理速度 3-5x | 低 (改默认值) |
| 模型预热 | 首次转录快 2-3s | 低 (加预热调用) |
| **合计（叠加）** | **首字幕 < 3s, 后续每 2s 更新** | — |

**注意**: 如果只做方案 A（窗口缩短）而不做方案 B/C，虽然首字幕快了，但每 3s 转录一次 3s 窗口的开销比原来每 15s 转录一次 30s 窗口更大。**建议 A+B+C 一起做以获得最佳实时体验。**

## 6. 实现建议

### 立即可以做的低风险改动

1. `audio_buffer.py`: 改默认 `window_size=3.0, hop_size=2.0`
2. `whisper_engine.py`: `beam_size=1`
3. `whisper_engine.py`: `word_timestamps=False`（默认关闭）
4. `websocket.py`: 默认模型改为 `"tiny"`

### 中等风险改动

5. `whisper_engine.py`: 添加 `condition_on_previous_text` 支持
6. `whisper_engine.py`: 添加预热方法 `warmup()`
7. `config.py`: 添加 AudioBuffer 窗口配置项

### 高风险/未来方向

8. 探索 faster-whisper 原生流式 API
9. 使用 ONNX Runtime / OpenVINO 推理后端加速
10. GPU 加速（CUDA 支持，如果用户有 NVIDIA GPU）

## 7. 测试方法

```bash
# 在优化前后分别测试
cd python-backend

# 1. 使用模拟器测试延迟
# 连接 WebSocket → 发送 start → 发送音频 → 测量首条字幕时间

# 2. 单元测试
pytest tests/ -v -k "transcription"

# 3. 基准测试
python -c "
from transcription import WhisperEngine
import time
e = WhisperEngine('tiny')
# 测试 3s 音频转录耗时
import numpy as np
audio = np.zeros(16000*3, dtype=np.int16).tobytes()
t0 = time.time()
result = e.transcribe_segment(audio)
print(f'3s 音频转录耗时: {time.time()-t0:.3f}s')
"
```

## 8. 验证指标

| 指标 | 当前 (base, 30s) | 预期 (tiny, 3s) |
|------|------------------|-----------------|
| 首条字幕延迟 | ~30-35s | **~3-5s** |
| 后续更新间隔 | 15s | **2-3s** |
| 单次转录耗时 (3s音频) | ~1.5-2s (30s音频) | **~0.3-0.5s** |
| CPU 占用 | 高 | 中 |
