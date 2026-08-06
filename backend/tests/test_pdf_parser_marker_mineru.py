"""marker/mineru 엔진의 블록 -> 텍스트/오버레이 변환 로직 단위 테스트.

marker(PyTorch 기반 레이아웃 모델)와 mineru(별도 전용 venv에서만 동작)는
무거운 모델을 실제로 구동해야 해서 일반 테스트 스위트에서 돌리기 부적합하다.
대신 두 엔진이 만들어내는 산출물의 스키마(JSONBlockOutput 트리 / content_list
dict)를 그대로 흉내 낸 가짜 데이터로, 그 산출물을 우리 텍스트/오버레이
포맷으로 변환하는 순수 로직(_marker_page_text, _marker_page_regions,
_mineru_item_text, _mineru_page_regions)만 검증한다.
"""
from services.pdf_parser import (
    _marker_page_text,
    _marker_page_regions,
    _mineru_item_text,
    _mineru_page_regions,
)


class FakeMarkerBlock:
    """marker JSONRenderer가 만드는 JSONBlockOutput을 흉내 낸 더미 객체.
    실제 pydantic 모델과 달리 속성 접근(block_type/html/bbox/children)만
    필요하므로 이 정도로 충분하다."""

    def __init__(self, block_type, html="", bbox=None, children=None):
        self.block_type = block_type
        self.html = html
        self.bbox = bbox
        self.children = children


def test_marker_page_text_skips_figures_keeps_text():
    page = FakeMarkerBlock(
        "Page",
        bbox=[0, 0, 1000, 1300],
        children=[
            FakeMarkerBlock("Text", html="<p>Introduction paragraph.</p>"),
            FakeMarkerBlock("FigureGroup", bbox=[100, 400, 600, 800], children=[
                FakeMarkerBlock("Figure", bbox=[100, 400, 600, 750]),
                FakeMarkerBlock("Caption", html="<p><strong>Figure 1.</strong> A test figure.</p>"),
            ]),
            FakeMarkerBlock("Text", html="<p>Conclusion paragraph.</p>"),
        ],
    )

    text = _marker_page_text(page)

    assert "Introduction paragraph." in text
    assert "Conclusion paragraph." in text
    # 그림/캡션은 본문 텍스트 스트림에서 빠져야 한다 (pymupdf 경로의 벡터
    # 그림 필터링과 동일한 의도)
    assert "A test figure" not in text


def test_marker_page_regions_detects_labeled_figure_group():
    page = FakeMarkerBlock(
        "Page",
        bbox=[0, 0, 1000, 1300],
        children=[
            FakeMarkerBlock("FigureGroup", bbox=[100, 400, 600, 800], children=[
                FakeMarkerBlock("Figure", bbox=[100, 400, 600, 750]),
                FakeMarkerBlock("Caption", html="<p>Figure 1: A test figure.</p>"),
            ]),
        ],
    )

    regions = _marker_page_regions(page)

    assert len(regions) == 1
    r = regions[0]
    assert r["label"] == "Figure 1"
    assert "A test figure" in r["caption"]
    # bbox [100,400,600,800] / page [0,0,1000,1300] -> left=10%, top≈30.8%
    assert abs(r["left"] - 10.0) < 0.01
    assert abs(r["width"] - 50.0) < 0.01


def test_marker_page_regions_numbers_equation():
    page = FakeMarkerBlock(
        "Page",
        bbox=[0, 0, 1000, 1300],
        children=[
            FakeMarkerBlock("Equation", html="<p>E = mc^2 (3)</p>", bbox=[100, 100, 400, 150]),
        ],
    )

    regions = _marker_page_regions(page)

    assert len(regions) == 1
    assert regions[0]["label"] == "Equation 3"


def test_mineru_item_text_uses_captions_not_raw_body():
    text_item = {"type": "text", "text": "Body paragraph."}
    image_item = {"type": "image", "image_caption": ["Figure 2: an image."], "img_path": "x.png"}
    table_item = {"type": "table", "table_caption": ["Table 1: a table."], "table_body": "<table></table>"}
    equation_item = {"type": "equation", "text": "y = mx + b (5)"}

    assert _mineru_item_text(text_item) == "Body paragraph."
    assert _mineru_item_text(image_item) == "Figure 2: an image."
    assert _mineru_item_text(table_item) == "Table 1: a table."
    assert _mineru_item_text(equation_item) == "y = mx + b (5)"


def test_mineru_page_regions_normalizes_bbox_and_matches_caption():
    content_list = (
        {
            "type": "image",
            "page_idx": 0,
            "bbox": [100, 200, 600, 700],
            "image_caption": ["Figure 3: normalized bbox test."],
        },
        {
            "type": "text",
            "page_idx": 0,
            "text": "irrelevant text block",
        },
    )

    regions_by_page = _mineru_page_regions(content_list)

    assert list(regions_by_page.keys()) == [0]
    regions = regions_by_page[0]
    assert len(regions) == 1
    r = regions[0]
    # bbox 0-1000 정규화 -> 퍼센트는 /10
    assert abs(r["left"] - 10.0) < 0.01
    assert abs(r["top"] - 20.0) < 0.01
    assert abs(r["width"] - 50.0) < 0.01
    assert r["label"] == "Figure 3"
