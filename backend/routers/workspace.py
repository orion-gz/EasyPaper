from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.auth import get_current_user
from services.db import db_get_workspace_settings, db_upsert_workspace_settings
from services.document_policy import DOCUMENT_MODES, feature_enabled, registry_payload


router = APIRouter()
CURRENT_ONBOARDING_VERSION = 1


class WorkspaceSettingsPatch(BaseModel):
    onboarding_version: Optional[int] = Field(default=None, ge=0)
    preferred_workspace_mode: Optional[str] = None
    document_type_options: Optional[dict] = None


@router.get("/document-types")
async def get_document_types():
    return registry_payload()


@router.get("/settings/workspace")
async def get_workspace_settings(current_user: str = Depends(get_current_user)):
    settings = db_get_workspace_settings(current_user)
    settings["current_onboarding_version"] = CURRENT_ONBOARDING_VERSION
    return settings


@router.patch("/settings/workspace")
async def patch_workspace_settings(
    body: WorkspaceSettingsPatch,
    current_user: str = Depends(get_current_user),
):
    current = db_get_workspace_settings(current_user)
    mode = body.preferred_workspace_mode
    if mode is not None and mode not in DOCUMENT_MODES:
        raise HTTPException(status_code=400, detail=f"workspace_mode must be one of {DOCUMENT_MODES}")
    if mode == "general" and not feature_enabled("general_document_mode"):
        raise HTTPException(status_code=403, detail="일반 문서 모드가 아직 활성화되지 않았습니다.")

    onboarding_version = (
        body.onboarding_version
        if body.onboarding_version is not None
        else current["onboarding_version"]
    )
    if onboarding_version > CURRENT_ONBOARDING_VERSION:
        raise HTTPException(status_code=400, detail="지원하지 않는 onboarding_version입니다.")

    if mode is not None and mode != current.get("preferred_workspace_mode"):
        from services.observability import record_document_mode_event
        record_document_mode_event(current_user, "workspace_switch", mode, status="selected")

    result = db_upsert_workspace_settings(
        current_user,
        onboarding_version,
        mode if mode is not None else current["preferred_workspace_mode"],
        body.document_type_options
        if body.document_type_options is not None
        else current["document_type_options"],
    )
    result["current_onboarding_version"] = CURRENT_ONBOARDING_VERSION
    return result


class DocumentClassificationPatch(BaseModel):
    document_mode: str
    document_type: str


@router.get("/metrics/document-modes")
async def get_document_mode_metrics(current_user: str = Depends(get_current_user)):
    from services.observability import summarize_document_mode_metrics
    return {"metrics": summarize_document_mode_metrics(current_user)}


@router.patch("/library/{doc_id}/classification")
async def patch_document_classification(
    doc_id: str, body: DocumentClassificationPatch,
    current_user: str = Depends(get_current_user),
):
    from services.db import db_document_has_mode_sensitive_data, db_update_document_classification
    from services.document_policy import MODE_SCHEMA_VERSION, validate_classification
    from services.ownership import require_owned_document

    doc = require_owned_document(doc_id, current_user)
    try:
        validate_classification(body.document_mode, body.document_type, allow_deprecated=False)
        if body.document_mode == "general" and not feature_enabled("general_document_mode"):
            raise ValueError("일반 문서 모드가 아직 활성화되지 않았습니다.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if doc.get("document_mode") == body.document_mode and doc.get("document_type") == body.document_type:
        return doc

    if db_document_has_mode_sensitive_data(doc_id):
        raise HTTPException(
            status_code=409,
            detail="번역 또는 인사이트가 생성된 문서는 분류를 변경할 수 없습니다. 새 분류로 다시 업로드해 주세요.",
        )

    db_update_document_classification(
        doc_id, body.document_mode, body.document_type, MODE_SCHEMA_VERSION,
    )
    updated = dict(doc)
    updated.update({
        "document_mode": body.document_mode,
        "document_type": body.document_type,
        "mode_schema_version": MODE_SCHEMA_VERSION,
        "translated_pages": [],
    })
    return updated


class DocumentClassificationConfirmation(BaseModel):
    document_mode: str
    document_type: str


@router.get("/library/{doc_id}/classification")
async def get_document_classification(doc_id: str, current_user: str = Depends(get_current_user)):
    from services.document_classification import classification_payload
    from services.ownership import require_owned_document
    return classification_payload(require_owned_document(doc_id, current_user))


@router.post("/library/{doc_id}/classification/confirm")
async def confirm_document_classification(doc_id: str, body: DocumentClassificationConfirmation, current_user: str = Depends(get_current_user)):
    from services.document_policy import MODE_SCHEMA_VERSION, validate_classification
    from services.db import db_update_document_classification
    from services.ownership import require_owned_document
    from routers.upload import ensure_session, sessions
    try:
        validate_classification(body.document_mode, body.document_type, allow_deprecated=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    doc = require_owned_document(doc_id, current_user)
    if doc.get("classification_status") == "confirmed":
        return {"status": "confirmed", "document_mode": doc["document_mode"], "document_type": doc["document_type"]}
    if not ensure_session(doc_id):
        raise HTTPException(status_code=409, detail="문서 원문을 복원할 수 없습니다.")
    db_update_document_classification(doc_id, body.document_mode, body.document_type, MODE_SCHEMA_VERSION)
    sessions[doc_id]["document_mode"] = body.document_mode
    sessions[doc_id]["document_type"] = body.document_type
    from services.parse_job import start_processing_after_classification
    start_processing_after_classification(doc_id, sessions)
    return {"status": "confirmed", "document_mode": body.document_mode, "document_type": body.document_type}
