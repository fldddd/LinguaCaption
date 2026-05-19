#!/usr/bin/env python3
"""
命令行转录工具 - 模拟前端"转录字幕"按钮功能

用法:
    python cli_transcribe.py <音频文件路径> [--model base]
    python cli_transcribe.py https://example.com/audio.mp3 [--model base]

示例:
    python cli_transcribe.py ./test.mp3
    python cli_transcribe.py ./test.mp3 --model small
    python cli_transcribe.py https://example.com/audio.mp3 --output ./subtitles.srt
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent))

from config import settings
from transcription import WhisperEngine


def download_audio(url: str, output_dir: str = "data/audio") -> str:
    """下载网络音频文件"""
    os.makedirs(output_dir, exist_ok=True)
    
    # 从 URL 提取文件名
    filename = url.split('/')[-1].split('?')[0] or 'downloaded_audio.mp3'
    filepath = os.path.join(output_dir, filename)
    
    print(f"📥 正在下载音频: {url}")
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    with httpx.Client(follow_redirects=True, timeout=60.0) as client:
        response = client.get(url, headers=headers)
        response.raise_for_status()
        
        with open(filepath, 'wb') as f:
            f.write(response.content)
    
    print(f"✅ 下载完成: {filepath} ({os.path.getsize(filepath)} bytes)")
    return filepath


def transcribe_audio(
    audio_path: str,
    model_size: str = "base",
    language: Optional[str] = None,
    show_progress: bool = True
) -> dict:
    """
    转录音频文件 - 模拟前端转录流程
    
    Args:
        audio_path: 音频文件路径
        model_size: Whisper 模型大小 (tiny/base/small/medium/large)
        language: 语言代码 (如 'en', 'zh', None 则自动检测)
        show_progress: 是否显示进度
    
    Returns:
        转录结果字典
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"音频文件不存在: {audio_path}")
    
    if show_progress:
        print(f"🎯 开始转录: {audio_path}")
        print(f"🤖 使用模型: {model_size}")
        print(f"🌐 语言设置: {language or '自动检测'}")
        print("-" * 50)
    
    # 初始化 Whisper 引擎
    engine = WhisperEngine(model_size=model_size)
    
    # 执行转录
    start_time = time.time()
    result = engine.transcribe(audio_path, language=language)
    elapsed = time.time() - start_time
    
    if show_progress:
        print(f"\n✅ 转录完成！耗时: {elapsed:.2f}秒")
        print(f"📝 识别语言: {result.get('language', 'unknown')}")
        print(f"⏱️  音频时长: {result.get('duration', 0):.2f}秒")
        print(f"📊 字幕段数: {len(result.get('segments', []))}")
        print(f"🔤 单词数: {len(result.get('words', []))}")
    
    return result


def save_srt(segments: list, output_path: str):
    """保存为 SRT 字幕格式"""
    def format_time(seconds: float) -> str:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        millis = int((seconds % 1) * 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
    
    with open(output_path, 'w', encoding='utf-8') as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{format_time(seg['start'])} --> {format_time(seg['end'])}\n")
            f.write(f"{seg['text']}\n\n")
    
    print(f"💾 SRT 字幕已保存: {output_path}")


def save_json(result: dict, output_path: str):
    """保存为 JSON 格式"""
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"💾 JSON 结果已保存: {output_path}")


def print_segments(segments: list, max_lines: int = 10):
    """打印字幕片段预览"""
    print("\n" + "=" * 50)
    print("字幕预览 (前 {} 段):".format(min(max_lines, len(segments))))
    print("=" * 50)
    
    for i, seg in enumerate(segments[:max_lines], 1):
        start = seg.get('start', 0)
        end = seg.get('end', 0)
        text = seg.get('text', '').strip()
        print(f"[{i}] {start:.2f}s - {end:.2f}s: {text}")
    
    if len(segments) > max_lines:
        print(f"... 还有 {len(segments) - max_lines} 段 ...")


def main():
    parser = argparse.ArgumentParser(
        description="命令行音频转录工具 - 模拟前端转录字幕功能",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 转录本地音频文件
  python cli_transcribe.py ./audio/test.mp3
  
  # 使用 small 模型转录
  python cli_transcribe.py ./audio/test.mp3 --model small
  
  # 转录网络音频
  python cli_transcribe.py https://example.com/audio.mp3
  
  # 保存 SRT 字幕文件
  python cli_transcribe.py ./audio/test.mp3 --output ./subtitles.srt
  
  # 保存完整 JSON 结果
  python cli_transcribe.py ./audio/test.mp3 --json ./result.json
        """
    )
    
    parser.add_argument(
        "input",
        help="音频文件路径或 URL"
    )
    
    parser.add_argument(
        "--model", "-m",
        default="base",
        choices=["tiny", "base", "small", "medium", "large"],
        help="Whisper 模型大小 (默认: base)"
    )
    
    parser.add_argument(
        "--language", "-l",
        default=None,
        help="语言代码 (如 'en', 'zh')，不指定则自动检测"
    )
    
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="输出 SRT 字幕文件路径"
    )
    
    parser.add_argument(
        "--json", "-j",
        default=None,
        help="输出 JSON 结果文件路径"
    )
    
    parser.add_argument(
        "--no-preview",
        action="store_true",
        help="不显示字幕预览"
    )
    
    args = parser.parse_args()
    
    # 检查输入是 URL 还是本地文件
    input_path = args.input
    is_url = input_path.startswith(('http://', 'https://'))
    
    try:
        # 如果是 URL，先下载
        if is_url:
            input_path = download_audio(input_path)
        
        # 执行转录
        result = transcribe_audio(
            audio_path=input_path,
            model_size=args.model,
            language=args.language,
            show_progress=True
        )
        
        segments = result.get('segments', [])
        
        # 显示字幕预览
        if not args.no_preview and segments:
            print_segments(segments)
        
        # 保存 SRT 文件
        if args.output and segments:
            save_srt(segments, args.output)
        
        # 保存 JSON 文件
        if args.json:
            save_json(result, args.json)
        
        # 如果是下载的临时文件，清理
        if is_url and os.path.exists(input_path):
            os.remove(input_path)
            print(f"🗑️  已清理临时文件: {input_path}")
        
        print("\n🎉 全部完成！")
        
    except FileNotFoundError as e:
        print(f"❌ 错误: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ 转录失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
