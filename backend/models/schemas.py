from pydantic import BaseModel
from typing import Optional


class UploadResponse(BaseModel):
    session_id: str
    filename: str
    total_pages: int
    file_size_mb: float
    metadata: dict
    document_mode: str = "research"
    document_type: str = "research_paper"
    source_language: str = "auto"
    detected_source_language: str = "und"
    source_language_confidence: Optional[float] = None
    preferred_target_language: Optional[str] = None
    translation_skipped_reason: Optional[str] = None
    source_origin: str = "local"
    content_kind: str = "pdf"
    source_url: Optional[str] = None
    canonical_url: Optional[str] = None
    fetched_at: Optional[str] = None
    total_units: Optional[int] = None
    capabilities: dict = {}

class UploadAcceptedResponse(BaseModel):
    session_id: str
    task_id: str
    status: str = "queued"
    filename: str
    file_size_mb: float


class UrlImportRequest(BaseModel):
    url: str
    upload_id: Optional[str] = None
    target_lang: str = "ko"
    source_lang: str = "auto"
    style: str = "academic"
    ignore_math: bool = False
    ignore_table: bool = True
    ignore_refs: bool = False
    translation_mode: str = "auto"
    keyword_mode: str = "manual"
    summary_mode: str = "manual"
    document_mode: str = "research"
    document_type: str = "research_paper"


class PageInfo(BaseModel):
    page_num: int
    text_length: int
    has_translation: bool


class SessionInfo(BaseModel):
    session_id: str
    filename: str
    total_pages: int
    pages: list[PageInfo]


class TranslationChunk(BaseModel):
    page_num: int
    chunk_index: int
    content: str
    done: bool


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
