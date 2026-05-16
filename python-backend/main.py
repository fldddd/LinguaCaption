"""
LinguaCaption FastAPI 应用入口
"""
import logging
import sys
import os

# 确保项目根目录在 path 中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from middleware.logger import RequestLoggerMiddleware
from api.health import router as health_router

# 日志配置
logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("lingua-caption")

# FastAPI 实例
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/api/docs" if settings.DEBUG else None,
    redoc_url=None,
)

# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 请求日志中间件
app.add_middleware(RequestLoggerMiddleware)

# 注册路由
app.include_router(health_router, prefix="/api", tags=["Health"])


@app.on_event("startup")
async def startup():
    logger.info("%s v%s 启动中...", settings.APP_NAME, settings.APP_VERSION)


@app.on_event("shutdown")
async def shutdown():
    logger.info("%s 已关闭", settings.APP_NAME)


# uvicorn 入口
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
    )
