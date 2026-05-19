#!/usr/bin/env python3
"""Download spaCy language models for NLP word frequency system."""
import subprocess
import sys

MODELS = {
    "en": "en_core_web_sm",
}

def download_model(lang_code: str) -> bool:
    model = MODELS.get(lang_code)
    if not model:
        print(f"[SKIP] No model configured for '{lang_code}'")
        return False
    try:
        import spacy
        spacy.load(model)
        print(f"[OK] {model} already installed")
        return True
    except (ImportError, OSError):
        print(f"[DOWNLOAD] Installing {model}...")
        result = subprocess.run(
            [sys.executable, "-m", "spacy", "download", model],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"[OK] {model} installed successfully")
            return True
        print(f"[FAIL] {model} installation failed: {result.stderr}")
        return False

if __name__ == "__main__":
    langs = sys.argv[1:] if len(sys.argv) > 1 else list(MODELS.keys())
    success = all(download_model(l) for l in langs)
    sys.exit(0 if success else 1)
