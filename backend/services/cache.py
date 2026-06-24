import json
import os
from typing import Optional
from config import CACHE_DIR


def _cache_path(session_id: str, page_num: int, suffix: str = "") -> str:
    suffix_part = f"_{suffix}" if suffix else ""
    return os.path.join(CACHE_DIR, f"{session_id}_page_{page_num}{suffix_part}.json")


def get_cached_translation(session_id: str, page_num: int, suffix: str = "") -> Optional[str]:
    """캐시된 번역 결과를 반환합니다. 없으면 None."""
    path = _cache_path(session_id, page_num, suffix)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("translation")
    except Exception:
        return None


def save_translation_cache(session_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    """번역 결과를 파일 캐시에 저장합니다."""
    path = _cache_path(session_id, page_num, suffix)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"translation": translation}, f, ensure_ascii=False)



def clear_session_cache(session_id: str) -> None:
    """세션의 모든 캐시 파일을 삭제합니다."""
    for fname in os.listdir(CACHE_DIR):
        if fname.startswith(session_id):
            os.remove(os.path.join(CACHE_DIR, fname))
