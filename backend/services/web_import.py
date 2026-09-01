"""Safe, deterministic URL retrieval and readable HTML snapshot extraction."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag
from readability import Document

MAX_REDIRECTS = 5
MAX_HTML_BYTES = 10 * 1024 * 1024
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024
MAX_IMAGES = 100
ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}
BLOCKED_HOSTS = {"localhost", "localhost.localdomain"}


class WebImportError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class FetchResult:
    kind: str
    final_url: str
    content_type: str
    headers: dict[str, str]
    content: bytes


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise WebImportError("invalid_url", "HTTP 또는 HTTPS URL을 입력하세요.")
    if parsed.username or parsed.password:
        raise WebImportError("invalid_url", "인증 정보가 포함된 URL은 지원하지 않습니다.")
    if parsed.port not in {None, 80, 443}:
        raise WebImportError("blocked_port", "기본 HTTP/HTTPS 포트만 사용할 수 있습니다.")
    if parsed.hostname.lower().rstrip(".") in BLOCKED_HOSTS:
        raise WebImportError("blocked_address", "로컬 또는 사설 네트워크 주소에는 접근할 수 없습니다.")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise WebImportError("dns_failed", "URL의 호스트를 확인할 수 없습니다.") from exc
    for item in addresses:
        ip = ipaddress.ip_address(item[4][0])
        if not ip.is_global or ip.is_multicast or ip.is_unspecified:
            raise WebImportError("blocked_address", "로컬 또는 사설 네트워크 주소에는 접근할 수 없습니다.")


def fetch_url(url: str, client: httpx.Client | None = None) -> FetchResult:
    own_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(30, connect=10), follow_redirects=False)
    current = url.strip()
    try:
        for _ in range(MAX_REDIRECTS + 1):
            _validate_url(current)
            try:
                with client.stream("GET", current, headers={"User-Agent": "EasyPaper/1 URL Importer", "Accept": "application/pdf,text/html;q=0.9"}) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise WebImportError("invalid_redirect", "리디렉션 목적지가 없습니다.")
                        current = urljoin(current, location)
                        continue
                    if response.status_code in {401, 403}:
                        raise WebImportError("access_blocked", "로그인 또는 사이트 접근 권한이 필요합니다.")
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    limit = MAX_PDF_BYTES if content_type == "application/pdf" else MAX_HTML_BYTES
                    chunks, size = [], 0
                    for chunk in response.iter_bytes(64 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise WebImportError("content_too_large", "가져올 문서가 허용 크기를 초과합니다.")
                        chunks.append(chunk)
                    content = b"".join(chunks)
                    is_pdf = content.startswith(b"%PDF-")
                    if is_pdf:
                        return FetchResult("remote_pdf", str(response.url), content_type, dict(response.headers), content)
                    prefix = content[:4096].lower()
                    is_html = content_type in {"text/html", "application/xhtml+xml"} or b"<html" in prefix or b"<!doctype html" in prefix
                    if not is_html:
                        raise WebImportError("unsupported_content", "PDF 또는 HTML 문서만 가져올 수 있습니다.")
                    text_hint = content[:200000].decode(response.encoding or "utf-8", errors="ignore").lower()
                    if any(marker in text_hint for marker in ("cf-chl-", "captcha", "enable javascript to continue")):
                        raise WebImportError("challenge_page", "사이트의 봇 확인 페이지는 가져올 수 없습니다.")
                    return FetchResult("web_article", str(response.url), content_type, dict(response.headers), content)
            except httpx.HTTPError as exc:
                raise WebImportError("fetch_failed", "URL에서 문서를 가져오지 못했습니다.") from exc
        raise WebImportError("too_many_redirects", "리디렉션 횟수가 너무 많습니다.")
    finally:
        if own_client:
            client.close()


def _frame_allowed(headers: dict[str, str]) -> bool:
    xfo = headers.get("x-frame-options", "").lower()
    csp = headers.get("content-security-policy", "").lower()
    return not xfo and not re.search(r"frame-ancestors\s+(?:'none'|'self')", csp)


def _safe_href(value: str, base_url: str) -> str | None:
    absolute = urljoin(base_url, value)
    return absolute if urlparse(absolute).scheme in {"http", "https"} else None


def _download_image(client: httpx.Client, url: str, assets_dir: Path, index: int) -> tuple[str | None, int]:
    _validate_url(url)
    try:
        with client.stream("GET", url, headers={"User-Agent": "EasyPaper/1 URL Importer"}) as response:
            response.raise_for_status()
            ctype = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if ctype not in ALLOWED_IMAGE_TYPES:
                return None, 0
            chunks, size = [], 0
            for chunk in response.iter_bytes(64 * 1024):
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    return None, 0
                chunks.append(chunk)
            digest = hashlib.sha256(url.encode()).hexdigest()[:12]
            name = f"{index:03d}-{digest}{ALLOWED_IMAGE_TYPES[ctype]}"
            (assets_dir / name).write_bytes(b"".join(chunks))
            return name, size
    except (httpx.HTTPError, WebImportError):
        return None, 0


def extract_article(result: FetchResult, article_dir: Path) -> tuple[dict, list[dict]]:
    encoding = "utf-8"
    raw = result.content.decode(encoding, errors="replace")
    source_soup = BeautifulSoup(raw, "html.parser")
    title = (source_soup.title.get_text(" ", strip=True) if source_soup.title else result.final_url)
    canonical_tag = source_soup.find("link", rel=lambda value: value and "canonical" in value)
    canonical = _safe_href(canonical_tag.get("href", ""), result.final_url) if canonical_tag else result.final_url
    readable = Document(raw)
    soup = BeautifulSoup(readable.summary(html_partial=True), "html.parser")
    for tag in soup.select("script,style,iframe,form,object,embed,svg,canvas,noscript"):
        tag.decompose()
    for tag in soup.find_all(True):
        for attr in list(tag.attrs):
            if attr.lower().startswith("on") or attr.lower() in {"style", "srcdoc"}:
                del tag.attrs[attr]
        if tag.name == "a" and tag.get("href"):
            safe = _safe_href(tag["href"], result.final_url)
            tag.attrs = {"href": safe, "rel": "noopener noreferrer"} if safe else {}

    assets_dir = article_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    total_assets = 0
    with httpx.Client(timeout=httpx.Timeout(30, connect=10), follow_redirects=False) as client:
        for index, image in enumerate(soup.find_all("img")[:MAX_IMAGES], 1):
            candidate = image.get("data-src") or image.get("data-lazy-src") or image.get("src")
            if not candidate and image.get("srcset"):
                candidate = image["srcset"].split(",")[-1].strip().split(" ")[0]
            absolute = _safe_href(candidate or "", result.final_url)
            image.attrs = {"alt": image.get("alt", ""), "data-original-url": absolute or ""}
            if absolute and total_assets < MAX_TOTAL_ASSET_BYTES:
                local, size = _download_image(client, absolute, assets_dir, index)
                if local and total_assets + size <= MAX_TOTAL_ASSET_BYTES:
                    total_assets += size
                    image["src"] = f"assets/{local}"
                else:
                    image["data-unavailable"] = "true"

    allowed = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img"}
    blocks, units, current = [], [], []
    for child in soup.find_all(allowed):
        if child.find_parent(allowed):
            continue
        text = child.get_text(" ", strip=True)
        if not text and child.name != "img":
            continue
        block_id = f"block-{len(blocks) + 1}"
        child["data-block-id"] = block_id
        block = {"id": block_id, "type": child.name, "html": str(child), "text": text}
        blocks.append(block)
        if child.name.startswith("h") and current:
            units.append(current); current = []
        current.append(block)
    if current:
        units.append(current)
    if not blocks or sum(len(b["text"]) for b in blocks) < 100:
        raise WebImportError("article_not_found", "페이지에서 읽을 수 있는 본문을 찾지 못했습니다.")
    manifest_units, pages = [], []
    for idx, unit in enumerate(units, 1):
        heading = next((b["text"] for b in unit if b["type"].startswith("h")), f"구간 {idx}")
        text = "\n\n".join(b["text"] for b in unit if b["text"])
        manifest_units.append({"index": idx, "id": f"section-{idx}", "title": heading, "block_ids": [b["id"] for b in unit], "text": text})
        pages.append({"page_num": idx, "text": text, "paragraphs": [{"text": text}], "section": heading, "parser_engine": "readability"})
    manifest = {"schema_version": 1, "title": readable.short_title() or title, "source_url": result.final_url, "canonical_url": canonical or result.final_url, "fetched_at": datetime.now(timezone.utc).isoformat(), "embed_allowed": _frame_allowed(result.headers), "blocks": blocks, "units": manifest_units}
    article_dir.mkdir(parents=True, exist_ok=True)
    (article_dir / "article.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest, pages
