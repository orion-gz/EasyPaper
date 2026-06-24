from pydantic import BaseModel
from typing import Optional


class UploadResponse(BaseModel):
    session_id: str
    filename: str
    total_pages: int
    file_size_mb: float
    metadata: dict


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
