"""Run the server with: python -m python-backend"""

from .main import app

if __name__ == "__main__":
    import uvicorn
    from .config import settings

    uvicorn.run(
        "python-backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
