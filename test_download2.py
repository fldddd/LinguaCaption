"""Test download function in server's context"""
import sys
sys.path.insert(0, "D:/projects/LinguaCaption/python-backend")
from api.video import _download_bilibili_sync

bvid = "BV1r25R68EUq"
try:
    path = _download_bilibili_sync(bvid)
    print(f"SUCCESS: {path}")
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
