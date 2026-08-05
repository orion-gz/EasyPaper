import pytest
import os
from config import get_pdf_parser_engine, update_system_settings
from services.pdf_parser import extract_pages

def test_pdf_parser_engine_config():
    # Test setting and retrieving pdf_parser_engine
    orig_engine = get_pdf_parser_engine()
    
    update_system_settings(
        ollama_host="http://localhost:11434",
        trans_provider="ollama",
        trans_model="gemma4:e4b",
        chat_provider="ollama",
        chat_model="gemma4:e4b",
        pdf_parser_engine="pdfplumber"
    )
    assert get_pdf_parser_engine() == "pdfplumber"

    # Restore original setting
    update_system_settings(
        ollama_host="http://localhost:11434",
        trans_provider="ollama",
        trans_model="gemma4:e4b",
        chat_provider="ollama",
        chat_model="gemma4:e4b",
        pdf_parser_engine=orig_engine
    )
    assert get_pdf_parser_engine() == orig_engine
