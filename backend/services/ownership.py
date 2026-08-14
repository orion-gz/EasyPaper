"""사용자별 문서 접근 경계를 일관되게 검증한다."""

from typing import Iterable, Optional

from fastapi import HTTPException

from services.library import get_document


def require_owned_document(doc_id: str, current_user: str, doc: Optional[dict] = None) -> dict:
    """문서 존재 여부와 소유권을 같은 404 응답으로 검증한다.

    권한 없는 문서에 403을 반환하면 doc_id 존재 여부가 노출되므로, 존재하지 않는
    문서와 동일한 응답을 유지한다. 이미 조회한 문서는 ``doc``으로 전달할 수 있다.
    """
    if doc is None:
        doc = get_document(doc_id)
    if not doc or doc.get("username") != current_user:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return doc


def require_owned_documents(doc_ids: Iterable[str], current_user: str) -> list[dict]:
    """복수 문서를 입력 순서대로 검증해 반환한다."""
    return [require_owned_document(doc_id, current_user) for doc_id in doc_ids]
