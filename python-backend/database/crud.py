"""LinguaCaption 数据库 CRUD 操作
为 Vocab、Subtitle、LearningRecord 提供完整的增删改查接口。
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from .models import Vocab, Subtitle, LearningRecord
from . import session_scope

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
# Vocab CRUD
# ══════════════════════════════════════════════════════════════

def create_vocab(
    word: str,
    translation: str | None = None,
    phonetic: str | None = None,
    part_of_speech: str | None = None,
    context: str | None = None,
    source_subtitle_id: int | None = None,
) -> Vocab:
    """创建生词记录"""
    try:
        with session_scope() as session:
            vocab = Vocab(
                word=word,
                translation=translation,
                phonetic=phonetic,
                part_of_speech=part_of_speech,
                context=context,
                source_subtitle_id=source_subtitle_id,
            )
            session.add(vocab)
            session.flush()  # 获取 id

            # 自动创建学习记录
            record = LearningRecord(vocab_id=vocab.id)
            session.add(record)

            logger.info(f"生词已创建: {word} (id={vocab.id})")
            return vocab.to_dict()
    except IntegrityError:
        logger.warning(f"生词已存在，跳过创建: {word}")
        return None


def get_vocab(vocab_id: int) -> dict | None:
    """按 ID 查询生词"""
    with session_scope() as session:
        vocab = session.get(Vocab, vocab_id)
        return vocab.to_dict() if vocab else None


def get_vocab_by_word(word: str) -> dict | None:
    """按单词原文查询"""
    with session_scope() as session:
        vocab = session.query(Vocab).filter(Vocab.word == word).first()
        return vocab.to_dict() if vocab else None


def list_vocabs(
    page: int = 1,
    page_size: int = 20,
    mastered: bool | None = None,
    search: str | None = None,
) -> dict:
    """分页列出生词，可按掌握状态和搜索词过滤"""
    with session_scope() as session:
        query = session.query(Vocab).outerjoin(
            LearningRecord, Vocab.id == LearningRecord.vocab_id
        )

        if mastered is not None:
            query = query.filter(LearningRecord.mastered.is_(mastered))

        if search:
            query = query.filter(Vocab.word.ilike(f"%{search}%"))

        total = query.count()
        vocabs = (
            query.order_by(Vocab.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        return {
            "items": [v.to_dict() for v in vocabs],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        }


def update_vocab(vocab_id: int, **kwargs) -> dict | None:
    """更新生词字段"""
    with session_scope() as session:
        vocab = session.get(Vocab, vocab_id)
        if not vocab:
            return None

        allowed = {
            "word", "translation", "phonetic",
            "part_of_speech", "context", "source_subtitle_id"
        }
        for key, value in kwargs.items():
            if key in allowed:
                setattr(vocab, key, value)

        vocab.updated_at = datetime.now(timezone.utc)
        session.flush()
        logger.info(f"生词已更新: id={vocab_id}")
        return vocab.to_dict()


def delete_vocab(vocab_id: int) -> bool:
    """删除生词（级联删除学习记录）"""
    with session_scope() as session:
        vocab = session.get(Vocab, vocab_id)
        if not vocab:
            return False
        session.delete(vocab)
        logger.info(f"生词已删除: id={vocab_id}")
        return True


def count_vocabs(mastered: bool | None = None) -> int:
    """统计生词数量"""
    with session_scope() as session:
        if mastered is not None:
            return (
                session.query(func.count(LearningRecord.id))
                .filter(LearningRecord.mastered.is_(mastered))
                .scalar()
            )
        return session.query(func.count(Vocab.id)).scalar()


# ══════════════════════════════════════════════════════════════
# Subtitle CRUD
# ══════════════════════════════════════════════════════════════

def create_subtitle(
    text: str,
    start_time: float,
    end_time: float,
    language: str = "en",
) -> dict:
    """创建字幕记录"""
    with session_scope() as session:
        subtitle = Subtitle(
            text=text,
            start_time=start_time,
            end_time=end_time,
            language=language,
        )
        session.add(subtitle)
        session.flush()
        logger.info(f"字幕已创建: id={subtitle.id}, [{start_time:.1f}s-{end_time:.1f}s]")
        return subtitle.to_dict()


def bulk_create_subtitles(subtitles: list[dict]) -> list[dict]:
    """批量创建字幕 (每个 dict 含 text/start_time/end_time/language)"""
    with session_scope() as session:
        results = []
        for item in subtitles:
            sub = Subtitle(
                text=item["text"],
                start_time=item["start_time"],
                end_time=item["end_time"],
                language=item.get("language", "en"),
            )
            session.add(sub)
            session.flush()
            results.append(sub.to_dict())
        logger.info(f"批量创建 {len(results)} 条字幕")
        return results


def get_subtitle(subtitle_id: int) -> dict | None:
    with session_scope() as session:
        sub = session.get(Subtitle, subtitle_id)
        return sub.to_dict() if sub else None


def list_subtitles(
    page: int = 1,
    page_size: int = 50,
    time_range: tuple[float, float] | None = None,
) -> dict:
    """分页列出字幕，可按时间范围过滤"""
    with session_scope() as session:
        query = session.query(Subtitle)

        if time_range:
            query = query.filter(
                Subtitle.start_time >= time_range[0],
                Subtitle.end_time <= time_range[1],
            )

        total = query.count()
        items = (
            query.order_by(Subtitle.start_time.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        return {
            "items": [s.to_dict() for s in items],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        }


def search_subtitles(keyword: str, limit: int = 20) -> list[dict]:
    """按关键字搜索字幕"""
    with session_scope() as session:
        subs = (
            session.query(Subtitle)
            .filter(Subtitle.text.ilike(f"%{keyword}%"))
            .order_by(Subtitle.start_time.asc())
            .limit(limit)
            .all()
        )
        return [s.to_dict() for s in subs]


def delete_subtitle(subtitle_id: int) -> bool:
    with session_scope() as session:
        sub = session.get(Subtitle, subtitle_id)
        if not sub:
            return False
        session.delete(sub)
        return True


# ══════════════════════════════════════════════════════════════
# LearningRecord CRUD
# ══════════════════════════════════════════════════════════════

def get_learning_record(record_id: int) -> dict | None:
    with session_scope() as session:
        rec = session.get(LearningRecord, record_id)
        return rec.to_dict() if rec else None


def get_record_by_vocab(vocab_id: int) -> dict | None:
    with session_scope() as session:
        rec = (
            session.query(LearningRecord)
            .filter(LearningRecord.vocab_id == vocab_id)
            .first()
        )
        return rec.to_dict() if rec else None


def record_review(vocab_id: int, correct: bool = True, difficulty: int = 3) -> dict | None:
    """记录一次复习结果，更新复习次数和下次复习时间"""
    from datetime import timedelta

    with session_scope() as session:
        rec = (
            session.query(LearningRecord)
            .filter(LearningRecord.vocab_id == vocab_id)
            .first()
        )
        if not rec:
            return None

        now = datetime.now(timezone.utc)
        rec.review_count += 1
        rec.last_reviewed_at = now
        rec.difficulty = max(1, min(5, difficulty))

        if correct:
            rec.correct_count += 1
            # 间隔递增：从配置读取
            from config import settings
            intervals = settings.srs_intervals
            idx = min(rec.correct_count - 1, len(intervals) - 1)
            rec.next_review_at = now + timedelta(days=intervals[idx])
        else:
            # 答错重置间隔
            rec.next_review_at = now + timedelta(days=1)

        # 连续正确达到阈值 → mastered
        if rec.correct_count >= settings.srs_mastered_threshold:
            rec.mastered = True

        session.flush()
        logger.info(f"复习记录: vocab_id={vocab_id}, correct={correct}, mastered={rec.mastered}")
        return rec.to_dict()


def get_due_reviews(limit: int = 20) -> list[dict]:
    """获取到期待复习的生词"""
    with session_scope() as session:
        now = datetime.now(timezone.utc)
        recs = (
            session.query(LearningRecord)
            .join(Vocab)
            .filter(
                LearningRecord.mastered.is_(False),
                LearningRecord.next_review_at <= now,
            )
            .order_by(LearningRecord.next_review_at.asc())
            .limit(limit)
            .all()
        )
        return [
            {"record": r.to_dict(), "vocab": r.vocab.to_dict()}
            for r in recs
        ]


def get_learning_stats() -> dict:
    """学习统计概览"""
    with session_scope() as session:
        total = session.query(func.count(LearningRecord.id)).scalar()
        mastered = (
            session.query(func.count(LearningRecord.id))
            .filter(LearningRecord.mastered.is_(True))
            .scalar()
        )
        due = (
            session.query(func.count(LearningRecord.id))
            .filter(
                LearningRecord.mastered.is_(False),
                LearningRecord.next_review_at <= datetime.now(timezone.utc),
            )
            .scalar()
        )
        return {
            "total_vocabs": total or 0,
            "mastered": mastered or 0,
            "learning": (total or 0) - (mastered or 0),
            "due_reviews": due or 0,
        }
