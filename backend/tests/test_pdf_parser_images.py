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
