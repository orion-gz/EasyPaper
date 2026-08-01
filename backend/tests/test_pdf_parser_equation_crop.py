"""extract_pdf_images()가 만드는 "Equation N" 항목의 가로 폭 회귀 테스트.

_find_page_equations()는 예전엔 번호 매겨진 수식 줄 주변(세로 40pt 이내)의
다른 텍스트 줄들 중 가장 왼쪽 x0을 찾아 좌측으로 폭을 넓혔다. 그런데 수식이
문단 본문의 왼쪽 여백보다 안쪽에서 시작하는 흔한 경우(들여쓰기/중앙 정렬된
수식)엔, 위아래 문단 줄의 여백까지 통째로 캡처되어 실제 수식보다 훨씬 넓은
영역이 잘리는 문제가 있었다. 이 테스트는 그 회귀를 막는다 - 크롭 영역의
왼쪽 경계가 수식 자신의 시작 위치를 벗어나지 않아야 한다."""

import fitz

from services.pdf_parser import extract_pdf_images


def test_equation_crop_does_not_widen_to_paragraph_margin(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    # 문단 본문 줄들 - 왼쪽 여백(x=50)에서 시작하고, 수식 위/아래 40pt 이내에 위치
    page.insert_text((50, 200), "This paragraph line sits above the equation and starts at the left margin.", fontsize=9)
    page.insert_text((50, 260), "This paragraph line sits below the equation and also starts at the left margin.", fontsize=9)

    # 수식은 문단 여백보다 훨씬 안쪽(x=220)에서 시작 - 들여쓰기/중앙 정렬된 수식 흉내
    page.insert_text((220, 230), "x = y + z    (3)", fontsize=11)

    path = tmp_path / "equation.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    eq_entries = [r for r in result if r.get("label") == "Equation 3"]
    assert len(eq_entries) == 1
    entry = eq_entries[0]

    page_width = 595
    paragraph_left_pct = (50 / page_width) * 100
    # 수식 자신의 시작 위치(x=220 부근)보다 왼쪽으로는 확장되지 않아야 한다 -
    # 특히 문단 왼쪽 여백(50pt)까지 통째로 캡처되면 안 된다.
    assert entry["left"] > paragraph_left_pct + 10
