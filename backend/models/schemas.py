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
