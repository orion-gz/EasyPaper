from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.auth import get_current_user
from services.db import db_get_language_settings, db_upsert_language_settings
from services.languages import (
    api_language_error,
    language_catalog,
    normalize_document_language,
    normalize_ui_locale,
)

router = APIRouter()


class LanguageSettingsRequest(BaseModel):
    ui_locale: Optional[str] = None
    default_source_language: str = "auto"
    target_language: str = "ko"


@router.get("/languages")
async def get_languages(current_user: str = Depends(get_current_user)):
    return {
        "languages": language_catalog(),
        "source_special_values": [
            {"code": "auto", "translation_key": "language.auto"},
            {"code": "mul", "translation_key": "language.mul"},
            {"code": "und", "translation_key": "language.und"},
        ],
    }


@router.get("/settings/language")
async def get_language_settings(current_user: str = Depends(get_current_user)):
    return db_get_language_settings(current_user)


@router.put("/settings/language")
async def save_language_settings(
    body: LanguageSettingsRequest,
    current_user: str = Depends(get_current_user),
):
    try:
        ui_locale = normalize_ui_locale(body.ui_locale) if body.ui_locale is not None else None
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "unsupported_ui_locale",
                "params": {"locale": body.ui_locale},
                "fallback": "The selected interface language is not supported.",
            },
        )
    try:
        source_language = normalize_document_language(body.default_source_language, allow_auto=True)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(body.default_source_language, source=True))
    try:
        target_language = normalize_document_language(body.target_language)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_language_error(body.target_language))
    return db_upsert_language_settings(current_user, ui_locale, source_language, target_language)
