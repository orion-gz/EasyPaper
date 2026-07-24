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
