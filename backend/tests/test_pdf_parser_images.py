"""services/pdf_parser.py의 extract_pdf_images() 테스트 - 그림/표/수식 좌표
및 캡션 라벨 추출."""

import fitz
import pytest

from services.pdf_parser import extract_pdf_images


def test_multi_panel_figure_merges_into_single_labeled_region(tmp_path):
    """하나의 그림이 좌/우 두 개의 서브플롯(sub-panel)으로 나뉘어 그려진
    경우(예: matplotlib의 두 서브플롯을 나란히 배치한 Figure), 각 패널이
    독립된 벡터 그래픽 영역으로 감지되어 같은 캡션에 개별적으로 매칭될 수
    있다. 이를 각각 별도 항목으로 내보내면 프론트엔드가 그중 하나만 골라
    써서 그림의 절반이 통째로 잘려나가는 버그가 있었다 - 같은 라벨로
    매칭된 사각형들은 하나로 합쳐져야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # 좌측 서브플롯 (테두리가 있는 벡터 사각형 - 흰 배경 채우기가 아니므로
    # 배경 필터에 걸리지 않음)
    left_rect = fitz.Rect(50, 100, 250, 300)
    page.draw_rect(left_rect, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(60, 150), fitz.Point(240, 250), color=(0, 0, 0), width=1)

    # 우측 서브플롯 - 좌측과 40pt 넘게 떨어져 있어(벡터 클러스터링 임계값
    # 10pt를 넘음) 별도 클러스터로 감지됨
    right_rect = fitz.Rect(340, 100, 540, 300)
    page.draw_rect(right_rect, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(350, 250), fitz.Point(530, 150), color=(0, 0, 0), width=1)

    # 두 패널 폭 전체에 걸친 캡션 한 줄 (두 사각형 모두와 가로로 겹치도록 충분히 길게)
    page.insert_text(
        (50, 320),
        "Figure 1: Left panel shows metric A across settings, right panel shows metric B for comparison.",
        fontsize=9,
    )

    path = tmp_path / "multi_panel.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    fig1_entries = [r for r in result if r.get("label") == "Figure 1"]

    assert len(fig1_entries) == 1, f"Figure 1이 하나로 합쳐져야 하는데 {len(fig1_entries)}개로 쪼개짐: {fig1_entries}"

    entry = fig1_entries[0]
    # 합쳐진 bbox가 좌측 패널의 왼쪽 끝부터 우측 패널의 오른쪽 끝까지를 모두 포함해야 함
    entry_left_pct = entry["left"]
    entry_right_pct = entry["left"] + entry["width"]
    page_width = 595
    assert entry_left_pct <= (left_rect.x0 / page_width) * 100 + 1
    assert entry_right_pct >= (right_rect.x1 / page_width) * 100 - 1


def test_stacked_panel_figure_absorbs_distant_unlabeled_panel(tmp_path):
    """"(a) DeiT.", "(b) TimeSformer."처럼 여러 행(row)의 서브패널이 위아래로
    쌓인 큰 그림은, 맨 아래 패널만 캡션과 가까워(40pt 이내) 매칭되고 맨 위
    패널은 캡션까지의 총 거리가 멀어 매칭에 실패할 수 있다. 이 경우에도
    아래 패널(라벨 있음)과 위 패널(라벨 없음) 사이 간격 자체는 좁으므로,
    위 패널이 흡수되어 최종적으로 그림 전체를 포함하는 하나의 bbox가
    나와야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # 위쪽 패널(라벨 없음이 될 것) - 캡션과는 멀리 떨어져 있음
    top_rect = fitz.Rect(50, 50, 500, 200)
    page.draw_rect(top_rect, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(60, 100), fitz.Point(480, 150), color=(0, 0, 0), width=1)
    page.insert_text((260, 215), "(a) Panel A.", fontsize=8)

    # 아래쪽 패널(캡션과 가까워 라벨이 매칭될 것) - 위쪽 패널과는 20pt 간격
    bottom_rect = fitz.Rect(50, 220, 500, 400)
    page.draw_rect(bottom_rect, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(60, 300), fitz.Point(480, 350), color=(0, 0, 0), width=1)
    page.insert_text((260, 415), "(b) Panel B.", fontsize=8)

    page.insert_text((50, 435), "Figure 3: Stacked panels showing two related results.", fontsize=9)

    path = tmp_path / "stacked_panel.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    fig3_entries = [r for r in result if r.get("label") == "Figure 3"]
    assert len(fig3_entries) == 1, f"Figure 3이 하나로 합쳐져야 하는데: {fig3_entries}"

    entry = fig3_entries[0]
    page_height = 842
    entry_top_pct = entry["top"]
    entry_bottom_pct = entry["top"] + entry["height"]
    # 합쳐진 bbox가 위쪽 패널의 위 끝부터 아래쪽 패널의 아래 끝까지 모두 포함해야 함
    assert entry_top_pct <= (top_rect.y0 / page_height) * 100 + 1
    assert entry_bottom_pct >= (bottom_rect.y1 / page_height) * 100 - 1


def test_upper_table_does_not_match_lower_tables_caption(tmp_path):
    """세로로 가깝게 붙은 두 표(예: TABLE III 바로 아래 TABLE IV)가 있으면,
    위쪽 표(TABLE III) 입장에서 자기 자신의 캡션(위쪽)보다 아래쪽 표
    (TABLE IV)의 캡션이 절대 거리상 오히려 더 가까울 수 있다. 방향을
    구분하지 않고 최소 거리만으로 캡션을 고르면 위쪽 표가 아래쪽 표의
    캡션에 잘못 매칭되어, 두 표가 하나의 bbox로 합쳐져 버리는 버그가
    있었다(Table IV를 클릭하면 TABLE III까지 통째로 크롭되어 보임).
    Table 캡션은 표 위에 있을 때만 후보로 인정해야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # TABLE III: 캡션이 표 위 지점에 있음(자기 자신과의 거리는 40pt 이내로,
    # 그러나 TABLE IV 캡션과의 거리(아래 참고)보다는 더 멀게)
    page.insert_text((250, 45), "TABLE III", fontsize=9)
    page.draw_line(fitz.Point(50, 75), fitz.Point(545, 75), color=(0, 0, 0), width=1)
    page.insert_text((60, 90), "datasets methods average kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 100), fitz.Point(545, 100), color=(0, 0, 0), width=1)
    page.insert_text((60, 112), "Conformer 88.19 0.7155", fontsize=7)
    page.draw_line(fitz.Point(50, 155), fitz.Point(545, 155), color=(0, 0, 0), width=1)

    # TABLE IV: TABLE III 바로 아래, 폭이 더 좁은 표. TABLE III 사각형에서
    # TABLE IV 캡션까지의 거리가 TABLE III 자신의 캡션까지 거리보다 오히려 더 짧다.
    page.insert_text((150, 180), "TABLE IV", fontsize=9)
    page.draw_line(fitz.Point(50, 218), fitz.Point(290, 218), color=(0, 0, 0), width=1)
    page.insert_text((60, 232), "datasets methods accuracy kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 240), fitz.Point(290, 240), color=(0, 0, 0), width=1)
    page.insert_text((60, 252), "Conformer 95.30 0.9295", fontsize=7)
    page.draw_line(fitz.Point(50, 315), fitz.Point(290, 315), color=(0, 0, 0), width=1)

    path = tmp_path / "adjacent_tables.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    labels = sorted(r.get("label") or "" for r in result)
    assert labels == ["Table III", "Table IV"], f"두 표가 별도 항목으로 남아야 하는데: {result}"

    table3 = next(r for r in result if r["label"] == "Table III")
    table4 = next(r for r in result if r["label"] == "Table IV")
    page_height = 842
    # Table III의 크롭 범위가 Table IV 영역(y=218 이후)까지 침범하면 안 된다
    table3_bottom_pct = table3["top"] + table3["height"]
    assert table3_bottom_pct < (218 / page_height) * 100


def test_lower_table_does_not_match_upper_tables_caption_when_convention_is_below(tmp_path):
    """test_upper_table_does_not_match_lower_tables_caption의 반대 방향 버전.

    Table 캡션이 표 "아래"에 있는 문서(예: UniFormer 확장판 논문,
    arXiv:2201.09450의 Table 8/Table 9)에서 두 표가 세로로 가깝게 붙어
    있으면, 아래쪽 표(Table 9) 입장에서 자기 자신의 캡션(아래쪽)보다 위에
    있는 앞 표(Table 8)의 캡션이 관례 방향(위)에 맞는다는 이유만으로
    먼저 매칭되어 버리는 회귀 버그가 있었다(Table 8의 오버레이가 Table 9
    데이터까지 통째로 삼켜, Table 9는 별도 오버레이가 아예 안 만들어짐).
    문서 전체의 캡션 방향을 먼저 통계적으로 확정한 뒤 그 한 방향만
    일관되게 적용해야 이런 교차 오염이 방지된다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # Table 8: 캡션이 표 "아래"에 있음
    page.draw_line(fitz.Point(50, 60), fitz.Point(545, 60), color=(0, 0, 0), width=1)
    page.insert_text((60, 75), "method accuracy kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 85), fitz.Point(545, 85), color=(0, 0, 0), width=1)
    page.insert_text((60, 97), "Ours 88.19 0.7155", fontsize=7)
    page.draw_line(fitz.Point(50, 110), fitz.Point(545, 110), color=(0, 0, 0), width=1)
    page.insert_text((50, 125), "Table 8: Semantic segmentation with semantic FPN.", fontsize=9)

    # Table 9: Table 8 캡션 바로 아래(24pt 간격, 40pt 캡션 매칭 임계값 이내)에
    # 시작하는 두 번째 표. 자기 자신의 캡션은 표 데이터보다 훨씬 아래에 있다.
    page.draw_line(fitz.Point(50, 149), fitz.Point(545, 149), color=(0, 0, 0), width=1)
    page.insert_text((60, 164), "method mIoU MS-mIoU", fontsize=7)
    page.draw_line(fitz.Point(50, 174), fitz.Point(545, 174), color=(0, 0, 0), width=1)
    page.insert_text((60, 186), "Ours 47.0 48.5", fontsize=7)
    page.draw_line(fitz.Point(50, 199), fitz.Point(545, 199), color=(0, 0, 0), width=1)
    page.insert_text((50, 214), "Table 9: Semantic segmentation with Upernet.", fontsize=9)

    path = tmp_path / "stacked_below_caption_tables.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    labels = sorted(r.get("label") or "" for r in result)
    assert labels == ["Table 8", "Table 9"], f"두 표가 별도 항목으로 남아야 하는데: {result}"

    table8 = next(r for r in result if r["label"] == "Table 8")
    table9 = next(r for r in result if r["label"] == "Table 9")
    page_height = 842
    # Table 8의 크롭 범위가 Table 9 영역(y=149 이후)까지 침범하면 안 된다
    table8_bottom_pct = table8["top"] + table8["height"]
    assert table8_bottom_pct < (149 / page_height) * 100, (
        f"Table 8이 Table 9까지 흡수함: {table8}"
    )
    # Table 9의 크롭 범위도 Table 8 영역(y=110 이전)을 침범하면 안 된다
    table9_top_pct = table9["top"]
    assert table9_top_pct > (110 / page_height) * 100, (
        f"Table 9가 Table 8까지 침범함: {table9}"
    )


def test_wide_table_does_not_absorb_unrelated_figure_below(tmp_path):
    """페이지 폭 전체를 차지하는 표(Table) 바로 아래 40pt 이내에, 그 표와는
    무관하게 옆 칸에 나란히 놓인 다른 그림/차트가 있을 수 있다. 서브패널
    흡수 로직(_PANEL_ABSORB_*)은 겹침 비율을 더 좁은 쪽(흡수 대상) 폭
    기준으로 계산하므로, 폭이 넓은 표는 그 아래 있는 어떤 좁은 요소와도
    "가로로 많이 겹치는" 것으로 오판되어 무관한 그림까지 표 안으로
    흡수해버리는 버그가 있었다. 이 흡수는 Figure 전용으로 제한되어야
    하고, Table은 무관한 아래쪽 요소를 흡수하면 안 된다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # 페이지 폭 전체를 차지하는 표
    page.insert_text((250, 45), "Table 1", fontsize=9)
    page.draw_line(fitz.Point(50, 75), fitz.Point(545, 75), color=(0, 0, 0), width=1)
    page.insert_text((60, 90), "datasets methods average kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 100), fitz.Point(545, 100), color=(0, 0, 0), width=1)
    page.draw_line(fitz.Point(50, 155), fitz.Point(545, 155), color=(0, 0, 0), width=1)

    # 표 바로 아래(39pt 간격), 표 폭의 오른쪽 절반에만 걸치는 무관한 차트
    # (자기 캡션은 이 페이지에 없음 - 다른 페이지의 Figure에 속한다고 가정)
    chart_rect = fitz.Rect(330, 194, 545, 340)
    page.draw_rect(chart_rect, color=(0, 0, 0), width=1.2)
    page.draw_line(fitz.Point(340, 330), fitz.Point(500, 210), color=(0.3, 0.3, 0.8), width=3)

    path = tmp_path / "wide_table_unrelated_chart.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    table_entries = [r for r in result if r.get("label") == "Table 1"]
    assert len(table_entries) == 1
    table_entry = table_entries[0]

    page_height = 842
    table_bottom_pct = table_entry["top"] + table_entry["height"]
    # 표의 크롭 범위가 차트 시작 지점(y=194) 아래까지 뻗어나가면 안 된다
    assert table_bottom_pct < (194 / page_height) * 100 + 2, (
        f"Table 1이 무관한 차트를 흡수해 크롭 범위가 커짐: {table_entry}"
    )

    # 차트는 별도의 라벨 없는 항목으로 남아야 한다
    unlabeled = [r for r in result if not r.get("label")]
    assert len(unlabeled) == 1


def test_table_caption_below_table_is_recognized(tmp_path):
    """일부 논문(예: ICLR 포맷의 일부)은 Table 캡션을 관례와 반대로 표
    "아래"에 싣는다. 관례적 방향(Table=위)으로만 매칭을 시도하면 이런
    표는 끝내 라벨 없이 남아 참조 오버레이(본문 "Table 1" 클릭 시 미리보기)
    대상에서 빠지는 실사용 버그가 있었다(Uniformer 논문(arXiv:2201.04676)
    다수 표에서 재현). 관례적 방향에서 못 찾으면 반대 방향도 허용해야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.draw_line(fitz.Point(50, 80), fitz.Point(545, 80), color=(0, 0, 0), width=1)
    page.insert_text((60, 95), "method accuracy kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 105), fitz.Point(545, 105), color=(0, 0, 0), width=1)
    page.insert_text((60, 117), "Ours 88.19 0.7155", fontsize=7)
    page.draw_line(fitz.Point(50, 130), fitz.Point(545, 130), color=(0, 0, 0), width=1)

    # 캡션이 표 바로 "아래"에 위치 (표 아래 캡션 관례)
    page.insert_text((50, 150), "Table 1: Comparison to different methods.", fontsize=9)

    path = tmp_path / "caption_below.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    table1_entries = [r for r in result if r.get("label") == "Table 1"]
    assert len(table1_entries) == 1, f"캡션이 아래에 있어도 Table 1로 매칭되어야 하는데: {result}"


def test_body_sentence_starting_with_table_number_is_not_treated_as_caption(tmp_path):
    """"Table 1 shows the results in detail for readers to see clearly."처럼
    본문 문단이 우연히 "Table N" 뒤에 구두점 없이 소문자 동사로 이어지는
    문장으로 시작하면, 캡션 정규식이 이를 실제 캡션으로 오인해 별개의
    가짜 캡션 후보를 만들어내는 버그가 있었다(Uniformer 논문에서 "Table 5
    shows more results...", "Figure 6, we present..." 등으로 재현). 진짜
    캡션("Table 1: ...", 구두점 있음)과 별도로 이런 문장이 있어도 실제
    표는 여전히 정상적으로 하나만 매칭되어야 하고, 가짜 캡션 문단 자체가
    새로운 표/그림으로 감지되면 안 된다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.draw_line(fitz.Point(50, 80), fitz.Point(545, 80), color=(0, 0, 0), width=1)
    page.insert_text((60, 95), "method accuracy kappa", fontsize=7)
    page.draw_line(fitz.Point(50, 105), fitz.Point(545, 105), color=(0, 0, 0), width=1)
    page.insert_text((60, 117), "Ours 88.19 0.7155", fontsize=7)
    page.draw_line(fitz.Point(50, 130), fitz.Point(545, 130), color=(0, 0, 0), width=1)
    page.insert_text((50, 150), "Table 1: Comparison to different methods.", fontsize=9)

    # 표와는 멀리 떨어진 본문 문단 - "Table 1"로 시작하지만 구두점 없이
    # 소문자 동사로 이어지는 일반 문장일 뿐, 캡션이 아니다.
    page.insert_text(
        (50, 400),
        "Table 1 shows the results in detail for readers to see clearly.",
        fontsize=11,
    )

    path = tmp_path / "false_positive_caption.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    table1_entries = [r for r in result if r.get("label") == "Table 1"]
    assert len(table1_entries) == 1, f"가짜 캡션 문장 때문에 Table 1이 중복/오매칭되면 안 되는데: {result}"

    # 표 자체의 bbox가 멀리 떨어진 가짜 캡션 문단 쪽으로 늘어나면 안 된다
    page_height = 842
    entry = table1_entries[0]
    entry_bottom_pct = entry["top"] + entry["height"]
    assert entry_bottom_pct < (200 / page_height) * 100, (
        f"Table 1의 bbox가 가짜 캡션 문단까지 뻗어나감: {entry}"
    )


def test_long_wrapped_caption_still_matches_distant_table(tmp_path):
    """Table 캡션이 여러 줄에 걸쳐 길게 줄바꿈되는 경우(실제 The Flexibility
    Trap 논문에서 재현 - 설명이 긴 캡션이 6~7줄까지 이어짐), 캡션의 "첫 줄"
    bbox만 기준으로 표까지의 거리를 재면 실제로는 캡션이 아직 끝나지 않은
    지점을 "캡션 끝"으로 오인해 거리가 실제보다 훨씬 크게 계산된다. 이
    거리가 매칭 임계값(40pt)을 넘으면 바로 아래 있는 진짜 표조차 캡션과
    매칭되지 못하고 라벨 없이 남아버렸다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    caption_rect = fitz.Rect(50, 80, 545, 200)
    long_caption = (
        "Table 1: A very long and detailed caption describing the experimental "
        "setup, baselines, and evaluation protocol used throughout this study in "
        "extensive detail so that the caption wraps across several physical "
        "lines before the actual table content begins right below it."
    )
    page.insert_textbox(caption_rect, long_caption, fontsize=9)

    # 표 규칙선은 캡션의 "첫 줄" 끝에서는 40pt 넘게 떨어져 있지만, 캡션
    # 전체(마지막 줄)가 끝나는 지점에서는 40pt 이내다.
    page.draw_line(fitz.Point(50, 145), fitz.Point(545, 145), color=(0, 0, 0), width=1)
    page.insert_text((60, 158), "method accuracy", fontsize=7)
    page.draw_line(fitz.Point(50, 168), fitz.Point(545, 168), color=(0, 0, 0), width=1)
    page.insert_text((60, 181), "Ours 88.1", fontsize=7)
    page.draw_line(fitz.Point(50, 191), fitz.Point(545, 191), color=(0, 0, 0), width=1)

    path = tmp_path / "wrapped_caption.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    table1_entries = [r for r in result if r.get("label") == "Table 1"]
    assert len(table1_entries) == 1, f"여러 줄로 줄바꿈된 캡션 때문에 Table 1 매칭에 실패함: {result}"


def test_sparse_booktabs_table_captures_distant_bottom_rule(tmp_path):
    """구분선이 거의 없는 booktabs 스타일 표(상단 규칙-헤더 구분선만 서로
    가깝고, 데이터 행 사이에는 선이 없어 맨 아래 규칙까지 100pt 넘게
    떨어진 경우 - 실제 The Flexibility Trap 논문의 Table 3에서 재현)는
    맨 아래 규칙이 별도의 1줄짜리 group으로 떨어져 나가 완전히 버려지고,
    표의 세로 범위가 상단 규칙-헤더 구분선 사이의 얇은 띠 하나로만 잡혀
    실제 표 본문(데이터 행 전체)이 오버레이 범위에서 빠지던 문제가 있었다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.insert_text((50, 90), "Table 1: Sparse booktabs style table with many data rows.", fontsize=9)
    page.draw_line(fitz.Point(50, 100), fitz.Point(545, 100), color=(0, 0, 0), width=1)
    page.insert_text((60, 112), "method accuracy", fontsize=7)
    page.draw_line(fitz.Point(50, 115), fitz.Point(545, 115), color=(0, 0, 0), width=1)
    # 데이터 행 다수 - booktabs 스타일답게 행 사이에 구분선 없음
    for i in range(12):
        page.insert_text((60, 130 + i * 12), f"Row{i} value{i}", fontsize=7)
    page.draw_line(fitz.Point(50, 280), fitz.Point(545, 280), color=(0, 0, 0), width=1)

    path = tmp_path / "sparse_booktabs.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    table1_entries = [r for r in result if r.get("label") == "Table 1"]
    assert len(table1_entries) == 1, f"맨 아래 규칙이 멀리 떨어져 있어 표 자체가 감지되지 않음: {result}"
    entry = table1_entries[0]
    entry_bottom_pt = (entry["top"] + entry["height"]) / 100 * 842
    # 표의 아래 경계가 맨 아래 규칙(y=280) 근처까지 내려와야 한다 - 상단
    # 규칙-헤더 구분선 사이(y=100~115)의 얇은 띠 하나로만 잡히면 안 된다.
    assert entry_bottom_pt > 260, f"표 하단이 맨 아래 규칙까지 확장되지 않음: {entry}"


def test_unrelated_unlabeled_regions_are_not_merged(tmp_path):
    """캡션에 매칭되지 않는(라벨이 없는) 영역들은 서로 다른 그림/표의 잔여
    조각일 수 있으므로 하나로 합쳐지면 안 되고, 감지된 개수만큼 개별
    항목으로 남아야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    r1 = fitz.Rect(50, 100, 250, 300)
    page.draw_rect(r1, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(60, 150), fitz.Point(240, 250), color=(0, 0, 0), width=1)

    r2 = fitz.Rect(340, 500, 540, 700)
    page.draw_rect(r2, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(350, 550), fitz.Point(530, 650), color=(0, 0, 0), width=1)
    # 캡션을 넣지 않아 두 영역 모두 라벨이 없는 상태로 남는다

    path = tmp_path / "unlabeled.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    unlabeled = [r for r in result if not r.get("label")]
    assert len(unlabeled) == 2
