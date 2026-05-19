# F4 转录字幕速度优化方案

## 当前瓶颈分析

### 1. 模型大小（最大瓶颈）
- **问题**: 默认模型为 `base`（~1.5GB），推理速度较慢
- **影响**: base 模型在 CPU 上处理 1 分钟音频约需 30-60 秒
- **对比**: tiny 模型（~150MB）速度是 base 的 3-5 倍，质量损失可接受

### 2. Beam Search 参数
- **问题**: `beam_size=5`（默认值），波束搜索宽度过大
- **影响**: CPU 上 beam_size=5 vs beam_size=1 速度差约 3x
- **建议**: 默认使用 beam_size=1（贪心搜索），对大多数场景质量影响很小

### 3. 音频预处理
- **问题**: `whisper_engine.py` 的 `transcribe()` 方法使用 pydub 加载音频
- **影响**: pydub 需要将整个文件加载到内存后再重采样/转格式，对几百 MB 的大文件非常慢
- **对比**: ffmpeg 子进程处理效率高 5-10 倍，且内存占用低

### 4. 模型加载
- **问题**: 虽然 `_get_engine()` 实现了单例，但模型仍会在首次请求时加载
- **影响**: 第一次转录请求有约 5-30 秒（取决于模型大小）的额外加载时间
- **优化**: 服务启动时预加载 tiny 模型（快速），后续可按需热切换

### 5. 前端轮询
- **问题**: 固定 2 秒轮询间隔，无进度百分比显示
- **影响**: 用户无法感知进度，只能看到"正在转录..."的文字

### 6. 后端任务进度
- **问题**: 任务仅有 PENDING/PROCESSING/COMPLETED/FAILED 四种状态，无进度百分比

## 已实施的优化方案

### ✅ F4.1 配置优化 (config.py)
| 项目 | 修改前 | 修改后 | 加速比 |
|------|--------|--------|--------|
| 默认模型 | `base` | `tiny` | ~3-5x |
| beam_size | 5（硬编码） | 1（可配置） | ~3x |
| best_of | 5（隐式） | 1（可配置） | ~1.5x |
| **合计加速** | | | **~10-20x** |

### ✅ F4.2 音频预处理优化 (whisper_engine.py)
- 添加 `_ffmpeg_convert_to_pcm()` 方法，使用 ffmpeg 子进程转换音频
- ffmpeg 比 pydub 快 5-10 倍，且支持流式处理，内存占用更低
- 自动回落：ffmpeg 不存在时自动使用 pydub（兼容性保持）
- pydub 仍作为最后手段保留

### ✅ F4.3 模型缓存优化 (whisper_engine.py)
- 添加 `get_engine()` 全局函数，确保 WhisperEngine 只实例化一次
- 支持指定模型大小的热切换
- 在 API 层调用 `get_engine()` 而不是每次创建新实例

### ✅ F4.4 任务进度跟踪 (transcription.py)
| 阶段 | 进度 |
|------|------|
| 任务创建 | 0% |
| 开始处理 | 5% |
| 文件加载完成 | 10% |
| 转录完成 | 90% |
| 结果格式化 | 100% |

### ✅ F4.5 前端轮询优化 (player.js + http.js)
- 自适应轮询间隔：前 10 次 1 秒/次，之后 2 秒/次
- 实时显示进度百分比 `正在转录... 45%`
- 进度停滞检测：连续 5 次无进展时显示"处理中"
- 完成时显示 ✅ 100%

### ✅ F4.6 API 增强 (api.js + transcription.py)
- `POST /api/transcription/upload?model=tiny` 支持上传时指定模型
- `GET /api/transcription/task/{id}` 返回 `progress` 字段
- `POST /api/transcription/model/switch` 支持热切换模型

## 预期效果

### 速度对比（CPU, 1 分钟音频, 10MB MP3）

| 场景 | 优化前 (base, beam=5) | 优化后 (tiny, beam=1) | 加速 |
|------|----------------------|----------------------|------|
| 模型加载 | ~10s | ~3s | 3x |
| 音频预处理 | ~3s (pydub) | ~0.5s (ffmpeg) | 6x |
| 推理时间 | ~45s | ~5s | 9x |
| **总计** | **~58s** | **~8.5s** | **~7x** |

### 内存占用
- pydub 加载大文件：≈ 文件大小 × 3（临时缓冲）
- ffmpeg 流式处理：≈ 固定 64MB 缓冲
- tiny 模型内存：≈ 300MB（vs base 的 1.5GB）

## 后续可做的优化

### 1. GPU 加速（CUDA）
- 如果系统有 NVIDIA GPU（支持 CUDA），可将 `whisper_device` 改为 `"cuda"`
- 推理速度可再提升 5-10x
- 切换方式：
  ```python
  # config.py 或环境变量
  whisper_device: str = "cuda"  # 需要安装 cudatoolkit & cupy
  ```

### 2. faster-whisper 内置优化
- `compute_type="float16"` 在 CUDA 上可进一步加速
- `cpu_threads=8` 增加线程数（目前 4）

### 3. 大文件分段处理
- 对超过 30 分钟的音频，可分段转录并合并结果
- 前端可实时显示已处理的分段进度

### 4. 客户端缓存
- 对同一文件的重复转录请求直接返回缓存结果
- 基于文件 hash 做缓存 key

### 5. WebSocket 推送进度
- 现有实时转录已经使用 WebSocket
- 文件转录也可通过 WebSocket 推送实时进度

### 6. 模型蒸馏
- 使用 distil-whisper 模型（比 tiny 更快，质量接近 small）
- 需要额外安装：`pip install transformers torch`

### 7. 大文件分片上传
- 前端在 `player.js` 中实现分片上传（每片 10MB）
- 后端边接收边处理，降低首字节等待时间

## 评估指标

| 指标 | 目标值 | 测量方式 |
|------|--------|---------|
| 转录延迟 | 实时率的 < 0.5x | 1 分钟音频在 30 秒内完成 |
| 模型加载时间 | < 5 秒 | 首次请求计时 |
| 音频预处理 | < 1 秒/10MB | 大文件测试 |
| 前端轮询响应 | < 1 秒获取结果 | 网络请求计时 |
| 进度显示精度 | ±5% | 与实际进度对比 |

## 文件变更清单

```
python-backend/
├── config.py                              # [修改] 默认模型 tiny，添加 beam/best_of 配置
├── transcription/
│   └── whisper_engine.py                  # [重写] 添加 ffmpeg 预处理、全局单例、优化参数
├── api/
│   └── transcription.py                   # [重写] 添加进度跟踪、模型参数、热切换

electron/src/scripts/
├── api.js                                 # [修改] uploadAudio 支持 model 参数
├── http.js                                # [修改] pollTask 支持进度回调和自适应间隔
├── player.js                              # [修改] 自适应轮询、进度百分比显示

docs/
└── TRANSCRIPTION_SPEED.md                 # [新建] 本优化文档
```
