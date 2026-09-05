"""Server-enforced document processing privacy policy."""
from __future__ import annotations

import ipaddress
from typing import Iterable
from urllib.parse import urlparse

from fastapi import HTTPException

VALID_PROCESSING_POLICIES = {"inherit", "local_only"}

_TRANSFER_ITEMS = {
    "translate": ["document_text", "page_image"],
    "chat": ["document_text", "chat_history", "page_image"],
    "insight": ["document_text"],
    "primer": ["document_text", "document_metadata", "page_image"],
    "recommendation": ["document_metadata", "notes", "chat_history"],
    "classification": ["document_text", "document_metadata"],
    "reparse": ["document_file"],
}


def normalize_processing_policy(value: str) -> str:
    policy = (value or "inherit").strip().lower()
    if policy not in VALID_PROCESSING_POLICIES:
        raise ValueError("processing_policy must be 'inherit' or 'local_only'")
    return policy


def is_loopback_ollama_host(host: str) -> bool:
    """Only an explicit loopback hostname/address counts as local processing."""
    try:
        parsed = urlparse((host or "").strip())
        hostname = (parsed.hostname or "").rstrip(".").lower()
    except ValueError:
        return False
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def provider_is_local(provider: str, ollama_host: str | None = None) -> bool:
    if (provider or "").strip().lower() != "ollama":
        return False
    if ollama_host is None:
        from config import get_ollama_host
        ollama_host = get_ollama_host()
    return is_loopback_ollama_host(ollama_host)


def provider_for_operation(operation: str) -> str:
    from config import (
        get_analysis_provider, get_chat_provider, get_library_provider,
        get_trans_provider,
    )
    if operation == "translate":
        return get_trans_provider()
    if operation == "chat":
        return get_chat_provider()
    if operation in {"insight", "primer"}:
        return get_analysis_provider()
    if operation == "recommendation":
        return get_library_provider()
    return get_analysis_provider()


def processing_disclosure(provider: str, operation: str) -> dict:
    local = provider_is_local(provider)
    return {
        "provider": provider,
        "local_processing": local,
        "badge": "local_processing" if local else "external_transfer",
        "transfer_items": [] if local else list(_TRANSFER_ITEMS.get(operation, ["document_text"])),
    }


def ensure_processing_allowed(document: dict, operation: str, provider: str | None = None) -> dict:
    """Raise before work/rate accounting starts when policy or classification blocks it."""
    if operation in {"translate", "insight", "primer"} and document.get("classification_status", "confirmed") != "confirmed":
        raise HTTPException(status_code=409, detail={
            "code": "classification_confirmation_required",
            "params": {"status": document.get("classification_status", "pending")},
            "fallback": "Confirm the document classification before starting AI processing.",
        })
    policy = normalize_processing_policy(document.get("processing_policy", "inherit"))
    selected_provider = (provider or provider_for_operation(operation)).strip().lower()
    disclosure = processing_disclosure(selected_provider, operation)
    if policy == "local_only" and not disclosure["local_processing"]:
        raise HTTPException(status_code=409, detail={
            "code": "external_processing_blocked",
            "params": {"provider": selected_provider, "operation": operation},
            "fallback": "This document allows local processing only. Select a loopback Ollama provider.",
        })
    return {"processing_policy": policy, **disclosure}


def ensure_documents_processing_allowed(
    documents: Iterable[dict], operation: str, provider: str | None = None,
) -> list[dict]:
    return [ensure_processing_allowed(doc, operation, provider) for doc in documents]


def document_processing_status(document: dict, operation: str | None = None) -> dict:
    policy = normalize_processing_policy(document.get("processing_policy", "inherit"))
    if operation is not None:
        disclosure = processing_disclosure(provider_for_operation(operation), operation)
    else:
        operations = ("translate", "chat", "insight", "recommendation")
        providers = {name: provider_for_operation(name) for name in operations}
        disclosures = {
            name: processing_disclosure(provider, name) for name, provider in providers.items()
        }
        external_operations = [name for name, value in disclosures.items() if not value["local_processing"]]
        transfer_items = list(dict.fromkeys(
            item for name in external_operations for item in disclosures[name]["transfer_items"]
        ))
        disclosure = {
            "provider": providers["chat"],
            "providers": providers,
            "local_processing": not external_operations,
            "badge": "external_transfer" if external_operations else "local_processing",
            "external_operations": external_operations,
            "transfer_items": transfer_items,
        }
    if policy == "local_only":
        disclosure["badge"] = "local_only"
        disclosure["blocked_external_operations"] = disclosure.get("external_operations", [])
        disclosure["transfer_items"] = []
    return {"processing_policy": policy, **disclosure}
