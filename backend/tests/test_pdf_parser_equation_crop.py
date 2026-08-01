"""extract_pdf_images()가 만드는 "Equation N" 항목의 크롭 영역 회귀 테스트.

_find_page_equations()의 진화 과정에서 실제로 관찰된 네 가지 오탐지를 각각
막는다:
1. 문단 여백까지 통째로 캡처되어 실제 수식보다 훨씬 넓어지는 문제(가장 먼저
   고친 버그).
2. 반대로, 한 시각적 줄이 PyMuPDF에 의해 여러 line 객체로 쪼개져 번호가 붙은
   조각만 잡히고 수식 앞부분이 잘리는 문제(위 수정이 야기한 회귀).
3. (22)/(23)처럼 촘촘히 쌓인 서로 다른 수식이 하나로 합쳐지는 문제.
4. 분수/피스와이즈(case)처럼 여러 행에 걸친 수식에서 번호 자신의 작은
   bbox만 잡혀 숫자만 확대되어 잘리는 문제.
5. 2단 레이아웃에서 번호처럼 보이는 오탐지(예: "(MI)")가 좌/우 컬럼을
   가리지 않고 양쪽 문단을 통째로 삼키는 문제.
"""

import fitz

from services.pdf_parser import extract_pdf_images


def _pt(entry, page_width=595, page_height=842):
    x0 = entry["left"] / 100 * page_width
    x1 = x0 + entry["width"] / 100 * page_width
    y0 = entry["top"] / 100 * page_height
    y1 = y0 + entry["height"] / 100 * page_height
    return x0, y0, x1, y1


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


def test_equation_split_across_lines_captures_full_row(tmp_path):
    """"u_n = ... (   -2b ... + I_n)   (22)"처럼 한 시각적 줄이 여러 개의
    insert_text 호출(=PyMuPDF line 객체)로 나뉘어 있어도, 번호가 붙은 조각만
    잡히지 않고 같은 행 전체가 캡처돼야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((150, 200), "u_n = u_(n-1) + dt (", fontsize=11)
    page.insert_text((350, 200), "-2b u_n_tilde - w0^2 v_(n-1) + I_n)", fontsize=11)
    page.insert_text((520, 200), "(22)", fontsize=11)
    path = tmp_path / "split_row.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation 22"]
    assert len(entries) == 1
    x0, _, x1, _ = _pt(entries[0])
    # 맨 앞 조각("u_n = ...")의 시작 위치(150pt) 근처까지 왼쪽 경계가
    # 확장돼야 한다 - 번호("(22)", x=520)만 잡히면 안 된다.
    assert x0 < 160
    assert x1 > 530


def test_stacked_equations_do_not_merge_into_each_other(tmp_path):
    """연속으로 촘촘히 쌓인 별개의 두 수식 (22)/(23)은 서로 합쳐지지 않고
    각자 자기 행만 캡처해야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((150, 200), "u_n = u_(n-1) + dt (", fontsize=11)
    page.insert_text((350, 200), "-2b u_n_tilde - w0^2 v_(n-1) + I_n)", fontsize=11)
    page.insert_text((520, 200), "(22)", fontsize=11)
    page.insert_text((250, 222), "v_n = v_(n-1) + dt u_n", fontsize=11)
    page.insert_text((520, 222), "(23)", fontsize=11)
    path = tmp_path / "stacked.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    eq22 = [r for r in result if r.get("label") == "Equation 22"][0]
    eq23 = [r for r in result if r.get("label") == "Equation 23"][0]
    _, _, _, eq22_y1 = _pt(eq22)
    _, eq23_y0, _, _ = _pt(eq23)
    # (22)의 크롭이 (23)의 행 전체를 집어삼킬 만큼 아래로 번지면 안 된다.
    # 각 항목에 독립적으로 붙는 4pt 패딩(_emit) 때문에 경계에서 약간(최대
    # ~8pt) 겹치는 것은 정상이므로, 실제 병합(수십 pt 이상 침범)만 잡도록
    # 넉넉한 허용치를 둔다.
    assert eq22_y1 <= eq23_y0 + 10
    eq23_x0, _, _, _ = _pt(eq23)
    assert eq23_x0 < 260


def test_piecewise_equation_captures_all_case_lines(tmp_path):
    """분수/피스와이즈(case)처럼 수식이 여러 행에 걸쳐 있고 번호가 그 사이에
    자기 행으로 떠 있는 경우, 번호 자신의 작은 bbox만 잡혀 숫자만 확대되어
    잘리면 안 되고 위/아래 case 행이 모두 포함돼야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((220, 150), "A e^(-t/tau)   cond_1,  A > 0", fontsize=10)
    page.insert_text((520, 158), "(1)", fontsize=11)
    page.insert_text((220, 168), "B e^(-t/tau)   cond_2,  B < 0", fontsize=10)
    path = tmp_path / "piecewise.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation 1"]
    assert len(entries) == 1
    _, y0, _, y1 = _pt(entries[0])
    # 두 case 행(139~171pt 부근)이 모두 포함될 만큼 세로로 넓어야 한다 -
    # 번호 자신의 작은 bbox(약 15pt)만 잡히면 안 된다.
    assert y1 - y0 > 30


def test_false_positive_equation_number_does_not_bridge_columns(tmp_path):
    """2단 레이아웃에서 로마 숫자로 오인식될 수 있는 괄호 약어(예: "(MI)")가
    실제 수식이 아니더라도, 좌/우 컬럼을 가로질러 양쪽 문단을 통째로
    삼키면 안 된다."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    # 왼쪽 컬럼 - 여러 줄의 본문 문단(2단 레이아웃 감지를 위해 충분한 글자 수 필요)
    left_lines = [
        "Subsequently the simple classifier module based on fully connected",
        "layers is followed to predict the categories for EEG signals here we",
        "also devise a visualization strategy to project the class activation",
        "mapping onto the brain topography finally we have conducted many",
    ]
    for i, text in enumerate(left_lines):
        page.insert_text((50, 100 + i * 14), text, fontsize=9)
    # 오른쪽 컬럼 - "(MI)"로 끝나는 줄을 포함
    right_lines = [
        "these methods extract features and perform classification for",
        "different tasks for example common spatial pattern csp is used",
        "to enhance spatial features for motor imagery tasks called (MI)",
        "the filter bank is further embedded for frequency rhythms here",
    ]
    for i, text in enumerate(right_lines):
        page.insert_text((320, 100 + i * 14), text, fontsize=9)
    path = tmp_path / "two_column.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation MI"]
    assert len(entries) == 1
    x0, _, x1, _ = _pt(entries[0], page_width=612, page_height=792)
    # 왼쪽 컬럼(약 50~300pt)까지 번져서는 안 된다 - 오른쪽 컬럼(약 320pt~) 안에만 있어야 한다.
    assert x0 > 300
