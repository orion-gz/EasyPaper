"""services/pdf_parser.py의 extract_pages() 테스트 - 벡터 그래픽으로 그려진
그림(matplotlib 등) 내부의 텍스트(축 라벨/범례 등)가 번역 대상 본문에
섞여 들어가지 않는지 확인."""

import fitz

from services.pdf_parser import extract_pages


def test_text_inside_vector_diagram_is_excluded_from_translation_text(tmp_path):
    """벡터 사각형(차트 프레임) 안에 삽입된 축 라벨 텍스트는 본문에서 제외되어야
    하고, 그림 밖의 일반 본문 문단과 캡션은 그대로 남아야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    body_text = "This paper proposes a novel method for evaluating model performance across benchmarks."
    page.insert_text((50, 60), body_text, fontsize=11)

    # 벡터 그래픽으로 그려진 차트 프레임 (테두리 있는 사각형 - 흰 배경 채우기가
    # 아니므로 배경 필터에 걸리지 않음)
    chart_rect = fitz.Rect(80, 150, 500, 400)
    page.draw_rect(chart_rect, color=(0, 0, 0), width=1.5)
    page.draw_line(fitz.Point(100, 350), fitz.Point(480, 200), color=(0, 0, 0), width=1)

    axis_label = "Accuracy (%)"
    page.insert_text((90, 380), axis_label, fontsize=8)
    legend_label = "Ours vs. Baseline"
    page.insert_text((350, 170), legend_label, fontsize=8)

    caption_text = "Figure 1: Accuracy comparison between our method and the baseline across settings."
    page.insert_text((50, 430), caption_text, fontsize=9)

    path = tmp_path / "diagram_with_labels.pdf"
    doc.save(str(path))
    doc.close()

    pages = extract_pages(str(path))
    assert len(pages) == 1
    page_text = pages[0]["text"]

    assert body_text in page_text
    assert "Figure 1" in page_text
    assert axis_label not in page_text, f"차트 내부 축 라벨이 본문에 섞여 들어감: {page_text!r}"
    assert legend_label not in page_text, f"차트 내부 범례 텍스트가 본문에 섞여 들어감: {page_text!r}"


def test_normal_page_without_diagrams_is_unaffected(tmp_path):
    """벡터 그림이 전혀 없는 페이지는 필터링 로직의 영향을 받지 않고 모든
    본문 텍스트가 그대로 추출되어야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    paragraph_1 = "Introduction. This section describes the motivation behind our approach."
    paragraph_2 = "Related Work. Prior methods have explored similar directions in the literature."
    page.insert_text((50, 60), paragraph_1, fontsize=11)
    page.insert_text((50, 100), paragraph_2, fontsize=11)

    path = tmp_path / "plain_text.pdf"
    doc.save(str(path))
    doc.close()

    pages = extract_pages(str(path))
    page_text = pages[0]["text"]

    assert paragraph_1 in page_text
    assert paragraph_2 in page_text
