"""Safe, deterministic URL retrieval and readable HTML snapshot extraction."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import tempfile
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
    content: bytes | None = None
    temp_path: str | None = None
    encoding: str = "utf-8"

    def read_bytes(self) -> bytes:
        if self.content is not None:
            return self.content
        if not self.temp_path:
            return b""
        return Path(self.temp_path).read_bytes()

    def cleanup(self) -> None:
        if self.temp_path:
            try:
                Path(self.temp_path).unlink(missing_ok=True)
            except OSError:
                pass


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


def _validate_peer(response: httpx.Response) -> None:
    """Re-check the connected peer to close the DNS validation/connection gap."""
    stream = response.extensions.get("network_stream")
    peer = stream.get_extra_info("server_addr") if stream and hasattr(stream, "get_extra_info") else None
    if not peer:
        return  # Mock transports and some platform transports expose no socket metadata.
    ip = ipaddress.ip_address(peer[0])
    if not ip.is_global or ip.is_multicast or ip.is_unspecified:
        raise WebImportError("blocked_address", "실제 연결 대상이 사설 네트워크 주소입니다.")


def fetch_url(url: str, client: httpx.Client | None = None) -> FetchResult:
    own_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(30, connect=10), follow_redirects=False)
    current = url.strip()
    try:
        for redirect_count in range(MAX_REDIRECTS + 1):
            _validate_url(current)
            try:
                with client.stream("GET", current, headers={"User-Agent": "EasyPaper/1 URL Importer", "Accept": "application/pdf,text/html;q=0.9"}) as response:
                    _validate_peer(response)
                    if response.status_code in {301, 302, 303, 307, 308}:
                        if redirect_count >= MAX_REDIRECTS:
                            raise WebImportError("too_many_redirects", "리디렉션 횟수가 너무 많습니다.")
                        location = response.headers.get("location")
                        if not location:
                            raise WebImportError("invalid_redirect", "리디렉션 목적지가 없습니다.")
                        current = urljoin(current, location)
                        continue
                    if response.status_code in {401, 403}:
                        raise WebImportError("access_blocked", "로그인 또는 사이트 접근 권한이 필요합니다.")
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    fd, temp_path = tempfile.mkstemp(prefix="easypaper-url-", suffix=".download")
                    size = 0
                    prefix = b""
                    try:
                        with os.fdopen(fd, "wb") as output:
                            for chunk in response.iter_bytes(64 * 1024):
                                if not prefix:
                                    prefix = chunk[:4096]
                                size += len(chunk)
                                is_pdf_hint = content_type == "application/pdf" or prefix.startswith(b"%PDF-")
                                limit = MAX_PDF_BYTES if is_pdf_hint else MAX_HTML_BYTES
                                if size > limit:
                                    raise WebImportError("content_too_large", "가져올 문서가 허용 크기를 초과합니다.")
                                output.write(chunk)
                            output.flush(); os.fsync(output.fileno())
                        is_pdf = prefix.startswith(b"%PDF-")
                        if is_pdf:
                            return FetchResult("remote_pdf", str(response.url), content_type, dict(response.headers), temp_path=temp_path, encoding=response.encoding or "utf-8")
                        lower_prefix = prefix.lower()
                        is_html = content_type in {"text/html", "application/xhtml+xml"} or b"<html" in lower_prefix or b"<!doctype html" in lower_prefix
                        if not is_html:
                            raise WebImportError("unsupported_content", "PDF 또는 HTML 문서만 가져올 수 있습니다.")
                        with open(temp_path, "rb") as saved:
                            text_hint = saved.read(200000).decode(response.encoding or "utf-8", errors="ignore").lower()
                        if any(marker in text_hint for marker in ("cf-chl-", "captcha", "enable javascript to continue")):
                            raise WebImportError("challenge_page", "사이트의 봇 확인 페이지는 가져올 수 없습니다.")
                        if any(marker in text_hint for marker in ('type="password"', "type='password'", "sign in to continue", "log in to continue")):
                            raise WebImportError("login_required", "로그인이 필요한 페이지는 가져올 수 없습니다.")
                        return FetchResult("web_article", str(response.url), content_type, dict(response.headers), temp_path=temp_path, encoding=response.encoding or "utf-8")
                    except Exception:
                        Path(temp_path).unlink(missing_ok=True)
                        raise
            except WebImportError:
                raise
            except httpx.HTTPError as exc:
                raise WebImportError("fetch_failed", "URL에서 문서를 가져오지 못했습니다.") from exc
        raise WebImportError("too_many_redirects", "리디렉션 횟수가 너무 많습니다.")
    finally:
        if own_client:
            client.close()


def _frame_allowed(headers: dict[str, str]) -> bool:
    xfo = headers.get("x-frame-options", "").lower()
    csp = headers.get("content-security-policy", "").lower()
    match = re.search(r"(?:^|;)\s*frame-ancestors\s+([^;]+)", csp)
    return not xfo and (not match or "*" in match.group(1).split())


def _safe_href(value: str, base_url: str) -> str | None:
    absolute = urljoin(base_url, value)
    return absolute if urlparse(absolute).scheme in {"http", "https"} else None


def _download_image(client: httpx.Client, url: str, assets_dir: Path, index: int, remaining_bytes: int) -> tuple[str | None, int]:
    current = url
    try:
        for redirect_count in range(MAX_REDIRECTS + 1):
            _validate_url(current)
            with client.stream("GET", current, headers={"User-Agent": "EasyPaper/1 URL Importer"}) as response:
                _validate_peer(response)
                if response.status_code in {301, 302, 303, 307, 308}:
                    if redirect_count >= MAX_REDIRECTS or not response.headers.get("location"):
                        return None, 0
                    current = urljoin(current, response.headers["location"]); continue
                response.raise_for_status()
                ctype = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if ctype not in ALLOWED_IMAGE_TYPES:
                    return None, 0
                limit = min(MAX_IMAGE_BYTES, max(0, remaining_bytes))
                if limit <= 0:
                    return None, 0
                digest = hashlib.sha256(url.encode()).hexdigest()[:12]
                name = f"{index:03d}-{digest}{ALLOWED_IMAGE_TYPES[ctype]}"
                partial = assets_dir / f".{name}.part"; size = 0
                try:
                    with partial.open("wb") as output:
                        for chunk in response.iter_bytes(64 * 1024):
                            size += len(chunk)
                            if size > limit:
                                return None, 0
                            output.write(chunk)
                        output.flush(); os.fsync(output.fileno())
                    os.replace(partial, assets_dir / name)
                    return name, size
                finally:
                    partial.unlink(missing_ok=True)
        return None, 0
    except (httpx.HTTPError, WebImportError, OSError):
        return None, 0


def extract_article(result: FetchResult, article_dir: Path) -> tuple[dict, list[dict]]:
    encoding = "utf-8"
    encoding = result.encoding or "utf-8"
    raw = result.read_bytes().decode(encoding, errors="replace")
    source_soup = BeautifulSoup(raw, "html.parser")
    title = (source_soup.title.get_text(" ", strip=True) if source_soup.title else result.final_url)
    def meta_value(*names: str) -> str | None:
        for name in names:
            tag = source_soup.find("meta", attrs={"name": name}) or source_soup.find("meta", attrs={"property": name})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None
    author = meta_value("author", "article:author", "byl")
    published_at = meta_value("article:published_time", "datePublished", "date", "pubdate")
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
                local, size = _download_image(client, absolute, assets_dir, index, MAX_TOTAL_ASSET_BYTES - total_assets)
                if local and total_assets + size <= MAX_TOTAL_ASSET_BYTES:
                    total_assets += size
                    image["src"] = f"assets/{local}"
                else:
                    image["data-unavailable"] = "true"

    allowed = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img"}
    blocks, units, current = [], [], []
    original_offset = 0
    for child in soup.find_all(allowed):
        if child.find_parent(allowed):
            continue
        text = child.get_text(" ", strip=True)
        if not text and child.name != "img":
            continue
        if current and (child.name.startswith("h") or sum(len(item["text"]) for item in current) + len(text) > 6000):
            units.append(current); current = []
        block_id = f"block-{len(blocks) + 1}"
        element_id = f"{child.name}-{len(blocks) + 1}" if child.name in {"figure", "table", "img"} else None
        child["data-block-id"] = block_id
        if element_id:
            child["id"] = element_id
        links = [link.get("href") for link in child.find_all("a", href=True)]
        block = {"id": block_id, "type": child.name, "html": str(child), "text": text, "start_offset": original_offset, "end_offset": original_offset + len(text), "element_id": element_id, "links": links}
        original_offset += len(text) + 2
        blocks.append(block)
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
    toc = [{"unit_id": unit["id"], "index": unit["index"], "title": unit["title"]} for unit in manifest_units]
    manifest = {"schema_version": 1, "title": readable.short_title() or title, "author": author, "published_at": published_at, "source_url": result.final_url, "canonical_url": canonical or result.final_url, "fetched_at": datetime.now(timezone.utc).isoformat(), "embed_allowed": _frame_allowed(result.headers) and urlparse(result.final_url).scheme == "https", "blocks": blocks, "units": manifest_units, "toc": toc}
    article_dir.mkdir(parents=True, exist_ok=True)
    (article_dir / "article.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest, pages


def pages_from_manifest(path: str | Path) -> list[dict]:
    """Rebuild the shared document-unit representation without a cache."""
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    pages = []
    for unit in manifest.get("units", []):
        text = str(unit.get("text") or "")
        pages.append({
            "page_num": int(unit["index"]),
            "text": text,
            "paragraphs": [{"text": text}],
            "section": str(unit.get("title") or f"Section {unit['index']}"),
            "unit_id": str(unit.get("id") or f"section-{unit['index']}"),
            "parser_engine": "readability",
        })
    if not pages:
        raise ValueError("article_manifest_has_no_units")
    return pages
