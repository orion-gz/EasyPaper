import pytest
from unittest.mock import patch
from services.llm_client import classify_paper_category

@pytest.mark.asyncio
async def test_classify_paper_category_deduplication():
    with patch("services.llm_client.get_trans_provider", return_value="antigravity"):
        async def fake_stream(*args, **kwargs):
            yield "LLM, VLM, llm,  LLM , Transformer, VLM"

        with patch("services.llm_client.stream_antigravity", side_effect=fake_stream):
            tags = await classify_paper_category("Sample Title", "Sample Text")
            assert tags == ["LLM", "VLM", "Transformer"]


@pytest.mark.asyncio
async def test_metadata_categories_deduplication():
    from routers.library import update_doc_metadata
    
    mock_doc = {
        "id": "doc123",
        "user_id": "testuser",
        "metadata": {"categories": ["AI", "LLM"]}
    }
    
    with patch("routers.library._require_owned_document", return_value=mock_doc), \
         patch("routers.library.update_document_metadata"):
        
        result = await update_doc_metadata(
            doc_id="doc123",
            payload={"categories": ["AI", "llm", "AI", "NLP", " nlp "]},
            current_user="testuser"
        )
        assert result["metadata"]["categories"] == ["AI", "llm", "NLP"]
