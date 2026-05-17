"""
字幕流模拟器 — s1-s2 桥接组件

在 Phase 2（真实 Whisper 转录）就绪前，用预设句子模拟实时字幕输出。
每 1-3 秒推送一个字幕片段，模拟真实转录节奏。

用法:
    simulator = SubtitleSimulator()
    async for sub in simulator.stream(interval=(0.5, 2.0)):
        print(sub["text"])
"""

import asyncio
import logging
import random
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# ── 预设字幕语料（按主题分组） ──────────────────────────────

SCRIPTS: dict[str, list[str]] = {
    "greeting": [
        "Hello! Welcome to LinguaCaption.",
        "Today we're going to practice English listening.",
        "Please listen carefully and repeat after me.",
        "Are you ready to start the lesson?",
        "Let's begin with some common phrases.",
        "How are you doing today?",
        "I hope you're having a great day.",
        "Learning a new language takes time and practice.",
        "Don't be afraid to make mistakes.",
        "Every mistake is a learning opportunity.",
    ],
    "daily": [
        "I usually wake up at seven o'clock in the morning.",
        "After brushing my teeth, I have breakfast.",
        "I like to drink coffee while reading the news.",
        "Then I take the bus to work.",
        "The commute takes about thirty minutes.",
        "I work as a software engineer at a tech company.",
        "My team is working on a new mobile application.",
        "We have a stand-up meeting every morning at nine.",
        "During lunch, I often practice English with my colleagues.",
        "After work, I go to the gym or read a book.",
    ],
    "academic": [
        "The study of language is called linguistics.",
        "There are over seven thousand languages spoken in the world today.",
        "English is the most widely spoken second language.",
        "Vocabulary acquisition is a key part of language learning.",
        "Research shows that spaced repetition improves memory retention.",
        "The word 'serendipity' means a fortunate discovery by accident.",
        "Native speakers use many idioms and phrasal verbs in daily conversation.",
        "Understanding context is crucial for grasping meaning.",
        "Active listening helps improve both comprehension and pronunciation.",
        "Consistent practice is more effective than intensive cramming.",
    ],
}

FILLERS = [
    "Mm-hmm.",
    "I see.",
    "That's interesting.",
    "Let me think about that.",
    "For example,",
    "In other words,",
    "As a matter of fact,",
    "You know what I mean?",
]


class SubtitleSimulator:
    """字幕模拟器 — 模拟 Whisper 实时输出"""

    def __init__(self, script_key: str | None = None):
        self.script = SCRIPTS.get(script_key or "daily", SCRIPTS["daily"])
        self._index = 0
        self._current_time = 0.0

    def _pick_sentence(self) -> str:
        """轮流取句子，穿插 filler 增加真实感"""
        if self._index >= len(self.script):
            self._index = 0

        if self._index > 0 and random.random() < 0.15:
            return random.choice(FILLERS)

        sentence = self.script[self._index]
        self._index += 1
        return sentence

    async def stream(
        self,
        interval: tuple[float, float] = (0.8, 2.5),
        max_segments: int = 20,
    ):
        """
        生成模拟字幕流。

        Args:
            interval: 相邻字幕的间隔秒数范围 (min, max)
            max_segments: 最大推送条数，超出停止

        Yields:
            dict: {
                "type": "subtitle",
                "data": {
                    "text": str,
                    "start_time": float,
                    "end_time": float,
                    "is_final": bool,
                    "segment_index": int,
                }
            }
        """
        logger.info("字幕模拟器启动 (max_segments=%d)", max_segments)

        for i in range(max_segments):
            text = self._pick_sentence()
            duration = max(0.5, len(text.split()) * 0.35)  # 按词数估算时长
            start = self._current_time
            end = start + duration

            yield {
                "type": "subtitle",
                "data": {
                    "text": text,
                    "start_time": round(start, 2),
                    "end_time": round(end, 2),
                    "is_final": True,
                    "segment_index": i,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            }

            self._current_time = end
            delay = random.uniform(*interval)
            await asyncio.sleep(delay)

        # 流结束信号
        yield {"type": "end", "data": {"total_segments": max_segments}}
        logger.info("字幕模拟器结束，共推送 %d 条", max_segments)

    def reset(self):
        """重置到初始状态"""
        self._index = 0
        self._current_time = 0.0
