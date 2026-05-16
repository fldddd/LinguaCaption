"""
LinguaCaption 数据模型定义
三张核心表: vocab (生词), subtitles (字幕), learning_records (学习记录)
"""

from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Text, Float, Boolean, DateTime, ForeignKey
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class Vocab(Base):
    """生词表 — 存储用户标记的学习词汇"""
    __tablename__ = "vocab"

    id = Column(Integer, primary_key=True, autoincrement=True)
    word = Column(String(255), nullable=False, index=True, comment="单词原文")
    translation = Column(String(500), nullable=True, comment="中文翻译")
    phonetic = Column(String(255), nullable=True, comment="音标")
    part_of_speech = Column(String(50), nullable=True, comment="词性 (noun/verb/adj/adv...)")
    context = Column(Text, nullable=True, comment="上下文句子")
    source_subtitle_id = Column(
        Integer, ForeignKey("subtitles.id", ondelete="SET NULL"),
        nullable=True, comment="来源字幕ID"
    )
    created_at = Column(
        DateTime, default=lambda: datetime.now(timezone.utc), comment="创建时间"
    )
    updated_at = Column(
        DateTime, default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc), comment="更新时间"
    )

    # 关联
    learning_records = relationship(
        "LearningRecord", back_populates="vocab",
        cascade="all, delete-orphan"
    )
    source_subtitle = relationship("Subtitle", back_populates="vocabs")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "word": self.word,
            "translation": self.translation,
            "phonetic": self.phonetic,
            "part_of_speech": self.part_of_speech,
            "context": self.context,
            "source_subtitle_id": self.source_subtitle_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Subtitle(Base):
    """字幕表 — 存储转录的字幕片段"""
    __tablename__ = "subtitles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    text = Column(Text, nullable=False, comment="字幕文本")
    start_time = Column(Float, nullable=False, comment="开始时间 (秒)")
    end_time = Column(Float, nullable=False, comment="结束时间 (秒)")
    language = Column(String(10), default="en", comment="语言代码")
    created_at = Column(
        DateTime, default=lambda: datetime.now(timezone.utc), comment="创建时间"
    )

    # 关联
    vocabs = relationship("Vocab", back_populates="source_subtitle")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "language": self.language,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class LearningRecord(Base):
    """学习记录表 — 追踪生词的复习进度"""
    __tablename__ = "learning_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    vocab_id = Column(
        Integer, ForeignKey("vocab.id", ondelete="CASCADE"),
        nullable=False, index=True, comment="关联生词ID"
    )
    review_count = Column(Integer, default=0, comment="复习次数")
    correct_count = Column(Integer, default=0, comment="正确次数")
    last_reviewed_at = Column(DateTime, nullable=True, comment="上次复习时间")
    next_review_at = Column(DateTime, nullable=True, comment="下次复习时间 (间隔重复)")
    mastered = Column(Boolean, default=False, comment="是否已掌握")
    difficulty = Column(Integer, default=3, comment="难度评级 1-5")
    created_at = Column(
        DateTime, default=lambda: datetime.now(timezone.utc), comment="创建时间"
    )

    vocab = relationship("Vocab", back_populates="learning_records")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "vocab_id": self.vocab_id,
            "review_count": self.review_count,
            "correct_count": self.correct_count,
            "last_reviewed_at": (
                self.last_reviewed_at.isoformat() if self.last_reviewed_at else None
            ),
            "next_review_at": (
                self.next_review_at.isoformat() if self.next_review_at else None
            ),
            "mastered": self.mastered,
            "difficulty": self.difficulty,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
