"""LinguaCaption 请求日志中间件"""

import logging
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("linguacaption.access")


class LoggerMiddleware(BaseHTTPMiddleware):
    """记录每个 HTTP 请求的方法、路径、状态码和处理时间"""

    async def dispatch(self, request: Request, call_next):
        start = time.time()
        response = await call_next(request)
        elapsed = time.time() - start
        logger.info(
            f"{request.method} {request.url.path} → {response.status_code} ({elapsed:.3f}s)"
        )
        return response
