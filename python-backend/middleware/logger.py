"""
请求日志中间件
记录每个 HTTP 请求的方法、路径、状态码和耗时。
"""
import time
import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = logging.getLogger("lingua-caption.access")


class RequestLoggerMiddleware(BaseHTTPMiddleware):
    """记录请求日志的中间件"""

    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()

        response = await call_next(request)

        elapsed = int((time.monotonic() - start) * 1000)
        logger.info(
            "%s %s → %d (%dms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed,
        )

        return response
