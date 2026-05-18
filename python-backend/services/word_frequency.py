"""
词频统计服务 — 内存缓存 + 批量刷新

提供单词频率的实时统计能力：
- 内存缓存高频更新，避免频繁数据库写入
- 批量刷新到数据库，减少IO开销
- 支持累计计数和会话计数两种维度
- 追踪单词来源（出处上下文）
"""

import logging
import re
import threading
from datetime import datetime, timezone
from typing import Optional

from database import session_scope
from database.models import WordFrequency, WordOccurrence

logger = logging.getLogger(__name__)

# 默认批量刷新间隔（秒）
DEFAULT_FLUSH_INTERVAL = 30

# 最小单词长度（过滤掉太短的词）
MIN_WORD_LENGTH = 2

# 单词正则（英文单词 + 连字符）
WORD_PATTERN = re.compile(r"\b[a-zA-Z]+(?:['-][a-zA-Z]+)*\b")


class WordFrequencyService:
    """词频统计服务（单例）"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True

        # 内存缓存: {word: {"cumulative": int, "session": int}}
        self._cache: dict[str, dict] = {}
        # 待刷新的来源记录
        self._occurrence_buffer: list[dict] = []
        # 缓存锁
        self._cache_lock = threading.Lock()
        # 定时器
        self._timer: Optional[threading.Timer] = None
        # 是否正在刷新
        self._flushing = False

        logger.info("WordFrequencyService 已初始化")

    # ── 公开 API ────────────────────────────────────────

    def record_text(
        self,
        text: str,
        source_type: str = "transcription",
        source_id: str = "",
        subtitle_text: Optional[str] = None,
        start_time: float = 0,
        end_time: float = 0,
    ) -> dict:
        """
        记录一段文本中所有单词的出现。
        返回本次新增/更新的词频统计摘要。
        """
        words = self._extract_words(text)
        if not words:
            return {"recorded": 0, "words": []}

        now = datetime.now(timezone.utc)
        summary = {"recorded": len(words), "words": []}

        with self._cache_lock:
            for word in words:
                if word not in self._cache:
                    self._cache[word] = {
                        "cumulative": 0,
                        "session": 0,
                        "first_seen": now,
                        "last_seen": now,
                    }
                entry = self._cache[word]
                entry["cumulative"] += 1
                entry["session"] += 1
                entry["last_seen"] = now

                summary["words"].append(word)

            # 缓存来源记录
            if subtitle_text:
                self._occurrence_buffer.append({
                    "word": words[0] if len(words) == 1 else text[:50],
                    "source_type": source_type,
                    "source_id": source_id,
                    "subtitle_text": subtitle_text,
                    "start_time": start_time,
                    "end_time": end_time,
                })

        # 启动延迟刷新定时器
        self._schedule_flush()

        return summary

    def get_frequency(self, word: str) -> Optional[dict]:
        """
        获取单个单词的词频统计。
        优先从缓存读取，缓存未命中则查数据库。
        """
        word = word.lower().strip()

        # 查缓存
        with self._cache_lock:
            if word in self._cache:
                entry = self._cache[word]
                return {
                    "word": word,
                    "cumulative_count": entry["cumulative"],
                    "session_count": entry["session"],
                    "first_seen_at": entry["first_seen"].isoformat(),
                    "last_seen_at": entry["last_seen"].isoformat(),
                }

        # 查数据库
        with session_scope() as session:
            record = (
                session.query(WordFrequency)
                .filter(WordFrequency.word == word)
                .first()
            )
            if record:
                return record.to_dict()

        return None

    def get_top_frequencies(self, limit: int = 50, sort_by: str = "cumulative") -> list[dict]:
        """
        获取词频排行榜。
        sort_by: 'cumulative' | 'session'
        """
        # 从内存缓存取
        with self._cache_lock:
            sorted_words = sorted(
                self._cache.items(),
                key=lambda x: x[1]["cumulative" if sort_by == "cumulative" else "session"],
                reverse=True,
            )[:limit]

            results = []
            for word, entry in sorted_words:
                results.append({
                    "word": word,
                    "cumulative_count": entry["cumulative"],
                    "session_count": entry["session"],
                    "first_seen_at": entry["first_seen"].isoformat(),
                    "last_seen_at": entry["last_seen"].isoformat(),
                })
            return results

    def get_word_occurrences(
        self, word: str, limit: int = 20, offset: int = 0
    ) -> list[dict]:
        """获取单词的出现记录（来源追踪）"""
        word = word.lower().strip()
        with session_scope() as session:
            records = (
                session.query(WordOccurrence)
                .filter(WordOccurrence.word == word)
                .order_by(WordOccurrence.occurred_at.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )
            return [r.to_dict() for r in records]

    def reset_session(self) -> int:
        """重置所有单词的会话计数，返回重置的单词数"""
        with self._cache_lock:
            count = len(self._cache)
            for word in self._cache:
                self._cache[word]["session"] = 0
            logger.info(f"会话计数已重置，共 {count} 个单词")
            return count

    def force_flush(self) -> int:
        """强制将内存缓存刷新到数据库"""
        return self._flush_to_db()

    # ── 内部方法 ─────────────────────────────────────────

    def _extract_words(self, text: str) -> list[str]:
        """从文本中提取小写单词"""
        if not text:
            return []
        words = WORD_PATTERN.findall(text.lower())
        return [w for w in words if len(w) >= MIN_WORD_LENGTH]

    def _schedule_flush(self):
        """安排延迟刷新（防抖）"""
        if self._timer and self._timer.is_alive():
            return
        self._timer = threading.Timer(DEFAULT_FLUSH_INTERVAL, self._flush_to_db)
        self._timer.daemon = True
        self._timer.start()

    def _flush_to_db(self) -> int:
        """批量刷新缓存到数据库"""
        if self._flushing:
            return 0
        self._flushing = True

        try:
            with self._cache_lock:
                cache_snapshot = dict(self._cache)
                occurrence_snapshot = list(self._occurrence_buffer)
                self._occurrence_buffer.clear()

            if not cache_snapshot:
                return 0

            now = datetime.now(timezone.utc)
            count = 0

            with session_scope() as session:
                for word, entry in cache_snapshot.items():
                    try:
                        record = (
                            session.query(WordFrequency)
                            .filter(WordFrequency.word == word)
                            .with_for_update()
                            .first()
                        )
                        if record:
                            record.cumulative_count += entry["cumulative"]
                            record.session_count += entry["session"]
                            record.last_seen_at = entry["last_seen"]
                            if record.first_seen_at is None:
                                record.first_seen_at = entry["first_seen"]
                            record.updated_at = now
                        else:
                            record = WordFrequency(
                                word=word,
                                cumulative_count=entry["cumulative"],
                                session_count=entry["session"],
                                first_seen_at=entry["first_seen"],
                                last_seen_at=entry["last_seen"],
                            )
                            session.add(record)

                        # 刷新缓存中的累计计数（减去已刷新的）
                        with self._cache_lock:
                            if word in self._cache:
                                self._cache[word]["cumulative"] = 0
                                self._cache[word]["session"] = 0

                        count += 1
                    except Exception as e:
                        logger.warning(f"刷新词频失败: {word} - {e}")

                # 写入来源记录
                for occ in occurrence_snapshot:
                    try:
                        occurrence = WordOccurrence(**occ)
                        session.add(occurrence)
                    except Exception as e:
                        logger.warning(f"写入来源记录失败: {e}")

            logger.info(f"词频刷新完成: {count} 个单词, {len(occurrence_snapshot)} 条来源记录")
            return count

        except Exception as e:
            logger.error(f"词频刷新异常: {e}")
            return 0
        finally:
            self._flushing = False


# 全局单例
word_frequency_service = WordFrequencyService()


def get_word_frequency_service() -> WordFrequencyService:
    """获取词频服务实例"""
    return word_frequency_service
