"""
B2 音频管理 — Pydantic 请求/响应模型
包含：上传管理 + 音频源管理
"""

from typing import Optional
from pydantic import BaseModel, Field


# ══════════════════════════════════════════════════════════════
# 音频记录（旧 B2 上传管理）
# ══════════════════════════════════════════════════════════════

class AudioResponse(BaseModel):
    """音频记录响应"""
    id: int
    filename: str
    filepath: str
    filesize: int
    duration: Optional[float] = None
    format: str
    created_at: Optional[str] = None

    model_config = {"from_attributes": True}


class AudioListResponse(BaseModel):
    """音频列表分页响应"""
    items: list[AudioResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


# ══════════════════════════════════════════════════════════════
# B2-UPGRADE: 音频源管理
# ══════════════════════════════════════════════════════════════

class AudioDeviceInfo(BaseModel):
    """音频设备信息"""
    id: int = Field(..., description="设备索引")
    name: str = Field(..., description="设备名称")
    channels: int = Field(..., description="声道数")
    sample_rate: int = Field(..., description="默认采样率")
    is_loopback: bool = Field(False, description="是否为 WASAPI Loopback 设备")
    is_default: bool = Field(False, description="是否为系统默认设备")
    host_api: str = Field("", description="主机 API 名称 (MME/WASAPI)")


class AudioSourceStatus(BaseModel):
    """音频源状态"""
    source: str = Field(..., description="当前源: system / microphone / file / none")
    is_running: bool = Field(False, description="是否正在采集")
    device_id: int = Field(-1, description="当前设备 ID")
    device_name: str = Field("", description="当前设备名称")
    sample_rate: int = Field(0, description="当前采样率")
    channels: int = Field(0, description="当前声道数")
    volume_level: float = Field(0.0, description="当前音量电平 (0.0 - 1.0)")
    is_admin: Optional[bool] = Field(None, description="是否以管理员权限运行")
    message: str = Field("", description="状态消息/错误信息")


class AudioSourceSwitch(BaseModel):
    """音频源切换请求"""
    source: str = Field(..., description="目标源: system / microphone / file / none")
    device_id: int = Field(-1, description="指定设备 ID（-1 自动选择）")
    file_path: Optional[str] = Field(None, description="文件源路径（source=file 时必需）")


class AudioSourceInfo(BaseModel):
    """音频源可用性信息"""
    has_wasapi_loopback: bool = Field(False, description="是否有 WASAPI Loopback 支持")
    has_microphone: bool = Field(False, description="是否有麦克风可用")
    is_admin: bool = Field(False, description="是否以管理员权限运行")
    loopback_devices: list[AudioDeviceInfo] = Field(default_factory=list)
    microphone_devices: list[AudioDeviceInfo] = Field(default_factory=list)
    current_source: str = Field("none", description="当前音频源")
    message: str = Field("", description="状态消息")
