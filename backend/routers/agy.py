"""
Antigravity 사용량 조회 및 agy 모델 목록 API
"""

import asyncio
from fastapi import APIRouter

router = APIRouter()


@router.get("/agy/usage")
async def get_agy_usage():
    """Antigravity CLI 사용량 통계 반환 (오늘/이번주/이번달)"""
    try:
        from services.usage_tracker import get_usage_stats, init_usage_table
        init_usage_table()
        stats = get_usage_stats()
        return {"ok": True, **stats}
    except Exception as e:
        return {"ok": False, "error": str(e), "today": 0, "this_week": 0,
                "this_month": 0, "total": 0, "daily_limit": 1000,
                "daily_remaining": 1000, "daily_used_pct": 0}


@router.get("/agy/models")
async def get_agy_models():
    """agy models 명령으로 실제 지원 모델 목록 반환"""
    import os
    agy_path = "/home/ubuntu/.local/bin/agy"
    if not os.path.exists(agy_path):
        agy_path = "agy"
    try:
        proc = await asyncio.create_subprocess_exec(
            agy_path, "models",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        models = [
            line.strip() for line in stdout.decode("utf-8", errors="replace").splitlines()
            if line.strip() and not line.startswith("\r")
        ]
        return {"ok": True, "models": models}
    except Exception as e:
        # fallback: 하드코딩된 목록 반환
        return {
            "ok": True,
            "models": [
                "Gemini 3.5 Flash (Medium)",
                "Gemini 3.5 Flash (High)",
                "Gemini 3.5 Flash (Low)",
                "Gemini 3.1 Pro (Low)",
                "Gemini 3.1 Pro (High)",
                "Claude Sonnet 4.6 (Thinking)",
                "Claude Opus 4.6 (Thinking)",
                "GPT-OSS 120B (Medium)",
            ],
            "fallback": True,
            "error": str(e)
        }
