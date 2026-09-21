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
    assert r["label"] == "Figure 3"


def test_find_cross_page_split_with_comma_boundary():
    """리뷰어 재현 사례: 쉼표가 포함된 다음 페이지 첫 문단이 올바르게 경계에서 분할되는지 검증."""
    from services.pdf_parser import _find_cross_page_split

    current = "We measured the response under several controlled conditions."
    following = "The results, however, indicate a significant change in behavior."

    split_res = _find_cross_page_split(current + " " + following, current, following)
    assert split_res is not None
    part_curr, part_next = split_res
    assert part_curr == current
    assert part_next == following


def test_find_cross_page_split_repeating_words():
    """'the'나 공통 어휘가 앞뒤 문단 모두에 반복 등장할 때 앞쪽 단어로 오분할되지 않는지 검증."""
    from services.pdf_parser import _find_cross_page_split

    current = "The model achieves significant gains across all evaluation benchmarks in the test set."
    following = "The model parameters were optimized using the standard Adam optimizer with decay."

    split_res = _find_cross_page_split(current + " " + following, current, following)
    assert split_res is not None
    part_curr, part_next = split_res
    assert part_curr == current
    assert part_next == following


def test_find_cross_page_split_hyphen_newline():
    """하이픈 줄바꿈(예: experi-\\n mental)이 포함된 경우에도 원문 오프셋 대응을 유지하는지 검증."""
    from services.pdf_parser import _find_cross_page_split

    current = "We measured the response under several experi-\nmental conditions."
    following = "The results, however, indicate a significant change in behavior."

    split_res = _find_cross_page_split(current + " " + following, current, following)
    assert split_res is not None
    part_curr, part_next = split_res
    assert part_curr == current
    assert part_next == following


def test_find_cross_page_split_normal_paragraph_no_split():
    """현재 페이지에만 완전히 속한 일반 문단은 분할하지 않고 None을 반환해야 함."""
    from services.pdf_parser import _find_cross_page_split

    current = "We measured the response under several controlled conditions and verified accuracy."
    following = "A completely different section begins on the next page discussing future work."

    split_res = _find_cross_page_split(current, current, following)
    assert split_res is None


def test_sanitize_mineru_pages_idempotent(monkeypatch):
    """sanitize_mineru_pages()를 2회 이상 반복 적용해도 결과가 동일하게 유지되는지(멱등성) 검증."""
    import fitz
    import os
    from services.pdf_parser import sanitize_mineru_pages

    p0_text = "We measured the response under several controlled conditions."
    p1_text = "The results, however, indicate a significant change in behavior."

    class FakePage:
        def __init__(self, text):
            self.text = text
        def get_text(self):
            return self.text

    class FakeDoc:
        def __init__(self, pages):
            self.pages = [FakePage(t) for t in pages]
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def __len__(self):
            return len(self.pages)
        def __getitem__(self, i):
            return self.pages[i]

    monkeypatch.setattr(fitz, "open", lambda path: FakeDoc([p0_text, p1_text]))
    monkeypatch.setattr(os.path, "exists", lambda path: True)

    initial_pages = [
        {
            "page_idx": 0,
            "blocks": [
                {"type": 0, "text": f"{p0_text} {p1_text}", "bbox": [0, 0, 1000, 1000]}
            ],
            "text": f"{p0_text} {p1_text}"
        },
        {
            "page_idx": 1,
            "blocks": [],
            "text": ""
        }
    ]

    import copy
    first_pass = sanitize_mineru_pages(copy.deepcopy(initial_pages), "dummy.pdf")
    assert len(first_pass[0]["blocks"]) == 1
    assert first_pass[0]["blocks"][0]["text"] == p0_text
    assert len(first_pass[1]["blocks"]) == 1
    assert first_pass[1]["blocks"][0]["text"] == p1_text

    second_pass = sanitize_mineru_pages(copy.deepcopy(first_pass), "dummy.pdf")
    assert len(second_pass[0]["blocks"]) == 1
    assert second_pass[0]["blocks"][0]["text"] == p0_text
    assert len(second_pass[1]["blocks"]) == 1
    assert second_pass[1]["blocks"][0]["text"] == p1_text



def test_marker_three_columns_sorted_across_nested_groups():
    def paragraph(x, y, label):
        return FakeMarkerBlock('Text', html=f'<p><b>{label}</b> ' + 'body text ' * 30 + '</p>',
                               bbox=[x, y, x + 163, y + 80])

    page = FakeMarkerBlock('Page', bbox=[0, 0, 585, 783], children=[
        paragraph(388, 50, 'RIGHT'),
        FakeMarkerBlock('TextGroup', children=[
            paragraph(42, 65, 'LEFT'), paragraph(215, 55, 'MIDDLE'),
        ]),
        paragraph(42, 160, 'LEFT_END'),
    ])
    text = _marker_page_text(page)
    labels = ['**LEFT**', '**LEFT_END**', '**MIDDLE**', '**RIGHT**']
    positions = [text.index(label) for label in labels]
    assert positions == sorted(positions)
    assert text.count('body text') == 120


def test_marker_missing_coordinates_preserves_model_order_and_all_text():
    page = FakeMarkerBlock('Page', bbox=[0, 0, 585, 783], children=[
        FakeMarkerBlock('Text', html='<p>First</p>'),
        FakeMarkerBlock('Text', html='<p>Second</p>', bbox=[42, 60, 205, 140]),
    ])
    assert _marker_page_text(page) == 'First\n\nSecond'
