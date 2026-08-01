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
6. 유난히 위/아래로 큰 bbox를 가진 줄(억양 부호 등)이 자기 수식뿐 아니라
   바로 아래/위 다른 수식의 번호와도 겹쳐, 두 수식 모두에 중복으로
   흡수되는 문제(실제 관찰 - (22)의 본문 줄이 (23)에도 잘못 흡수됨).
7. Figure/Table 캡션처럼 페이지 폭 대부분을 차지하는 줄이 "문단 줄 폭
   추정치"를 부풀려, 정상 크기의 문단 줄까지 "수식만큼 좁다"고 잘못
   판단해 흡수해버리는 문제.
8. 억양 부호·합/적분 기호 렌더링 등으로 세로로 유난히 큰 bbox를 가진
   줄이 흡수되면서 growing rect가 급격히 커지고, 그 순간 위/아래 문단
   줄과도 겹침 비율 임계값을 넘겨 연쇄적으로 흡수되는 도미노 문제
   (실제 논문 PDF 전수 조사로 재발견, 3차 수정 이후에도 남아있었음).
9. 수식 직전/직후의 짧은 도입·설명 문장이 폭이 좁아 기존 폭 비율
   가드를 통과해 gap 조건만으로 거의 항상 흡수되는 문제(위와 같은
   조사로 재발견).
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
    삼키면 안 된다.

    insert_textbox()로 각 컬럼을 한 문단(하나의 PyMuPDF 블록에 여러 줄이
    자동 줄바꿈되어 들어감)으로 만든다 - insert_text()를 줄마다 따로
    호출하면 줄마다 별도 블록이 생겨 실제 PDF의 문단 블록 구조(여러 줄이
    한 블록으로 묶임)와 달라지고, "(MI)"로 끝나는 줄이 속한 문단의 나머지
    줄들이 2단 감지에 기여하지 못해 테스트가 실제 동작을 반영하지 못한다."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    left_text = (
        "Subsequently the simple classifier module based on fully connected "
        "layers is followed to predict the categories for EEG signals here we "
        "also devise a visualization strategy to project the class activation "
        "mapping onto the brain topography finally we have conducted many experiments."
    )
    # "(MI)"로 끝나는 줄바꿈이 자연스럽게 생기도록 자동 줄바꿈에 맡긴다.
    right_text = (
        "these methods extract features and perform classification for "
        "different tasks for example common spatial pattern csp is used "
        "to enhance spatial features for motor imagery tasks called (MI) "
        "the filter bank is further embedded for frequency rhythms here."
    )
    page.insert_textbox(fitz.Rect(50, 90, 300, 200), left_text, fontsize=9)
    page.insert_textbox(fitz.Rect(320, 90, 570, 200), right_text, fontsize=9)
    path = tmp_path / "two_column.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation MI"]
    assert len(entries) == 1
    x0, _, x1, _ = _pt(entries[0], page_width=612, page_height=792)
    # 왼쪽 컬럼(약 50~300pt)까지 번져서는 안 된다 - 오른쪽 컬럼(약 320pt~) 안에만 있어야 한다.
    assert x0 > 300


def test_tall_shared_line_is_not_double_claimed_by_two_equations(tmp_path):
    """억양 부호 등으로 인해 유난히 위/아래로 큰 bbox를 가진 줄은, 자기
    수식뿐 아니라 바로 아래 다른 수식의 번호와도 겹칠 수 있다. 이런 줄은
    "자기 자신의 원래 후보 줄"과 겹침이 더 강한 쪽에만 귀속돼야 하고, 두
    수식 모두에 중복으로 흡수되면 안 된다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((150, 200), "x = y (", fontsize=11)
    # 큰 폰트로 그린 조각 - PyMuPDF가 "x = y (" 옆줄과 합쳐 유난히 키가 큰
    # line을 만든다(억양 부호가 있는 실제 글리프의 bbox 오버슈트를 흉내).
    page.insert_text((200, 205), "TALLBIT", fontsize=26)
    page.insert_text((520, 200), "(1)", fontsize=11)
    # 바로 아래, 촘촘히 쌓인 별개의 수식
    page.insert_text((250, 218), "p = q", fontsize=11)
    page.insert_text((520, 218), "(2)", fontsize=11)
    path = tmp_path / "tall_shared_line.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    eq1 = [r for r in result if r.get("label") == "Equation 1"][0]
    eq2 = [r for r in result if r.get("label") == "Equation 2"][0]
    eq1_x0, _, _, _ = _pt(eq1)
    eq2_x0, _, _, _ = _pt(eq2)
    # 키 큰 조각("x = y (TALLBIT", x=150 부근)은 Equation 1에만 속해야 한다.
    # Equation 2는 자기 자신의 본문("p = q", x=250 부근)에서만 시작해야
    # 하고, 위로 번져서 Equation 1의 내용까지 포함하면 안 된다.
    assert eq1_x0 < 160
    assert eq2_x0 > 240


def test_equation_does_not_cascade_via_tall_glyph_line(tmp_path):
    """억양 부호·합/적분 기호 렌더링 등으로 세로로 유난히 큰 bbox를 가진
    줄 하나가 1단계에서 먼저 흡수되면, growing rect의 세로 범위가 급격히
    커지면서 그 순간 위/아래 문단 줄과도 새로 겹침 비율 임계값을 넘겨
    다음 반복에서 또 흡수되는 도미노가 실제 논문 PDF(Kingma & Welling
    VAE 논문)에서 재현되었다 - 섹션 제목+문단 두 개가 통째로 캡처됨.
    여기서는 위/아래 문단 줄과 세로로 겹치는 큰 폰트 기호("BIGSYM")를
    수식 옆에 배치해 같은 조건을 재현한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 200), "This paragraph line sits above the equation naturally.", fontsize=9)
    page.insert_text((220, 225), "x = y", fontsize=11)
    page.insert_text((260, 220), "BIGSYM", fontsize=24)
    page.insert_text((400, 225), "(1)", fontsize=11)
    page.insert_text((50, 270), "This paragraph line sits below the equation naturally.", fontsize=9)
    path = tmp_path / "tall_glyph_domino.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation 1"]
    assert len(entries) == 1
    x0, _, _, _ = _pt(entries[0])
    # 문단 왼쪽 여백(x=50)까지 흡수되면 안 된다 - 흡수 전이라면 수식 자신의
    # 시작 위치(x=220 부근)에서 크게 벗어나지 않아야 한다.
    assert x0 > 150, f"위쪽 문단 줄이 도미노로 흡수되어 좌측 경계가 넓어짐: {entries[0]}"


def test_equation_does_not_absorb_short_lead_in_sentence(tmp_path):
    """수식 바로 위의 짧은 도입 문장("The process can be expressed as")은
    폭이 좁아 기존 폭 비율 가드(_EQ_ABSORB_MAX_WIDTH_RATIO)만으로는
    걸러지지 않고 gap 조건까지 통과해 거의 항상 흡수되는 문제가 실제
    논문 PDF(EEG Conformer 논문 등) 다수에서 재현되었다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # 정상적인 컬럼 폭 추정치를 위한 참조 문단 줄 (수식과는 멀리 떨어짐)
    page.insert_text((49, 100), "This is body paragraph line filling most of the column width here now please.", fontsize=10)
    page.insert_text((49, 200), "The process can be expressed as", fontsize=10)
    page.insert_text((90, 220), "f(x) = a x + b", fontsize=11)
    page.insert_text((300, 220), "(1)", fontsize=11)
    path = tmp_path / "lead_in_sentence.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation 1"]
    assert len(entries) == 1
    x0, y0, _, _ = _pt(entries[0])
    # 도입 문장의 좌측 여백(x=49)이나 그 줄 자체(y=189~203)까지 확장되면
    # 안 된다 - 수식 자신의 시작 위치(x=90, y=208) 근처에 머물러야 한다.
    assert x0 > 70, f"도입 문장의 좌측 여백까지 확장됨: {entries[0]}"
    assert y0 > 195, f"도입 문장 줄까지 흡수됨: {entries[0]}"


def test_wide_caption_line_does_not_inflate_paragraph_width_estimate(tmp_path):
    """Figure/Table 캡션처럼 페이지 폭 대부분을 차지하는 줄이 있으면,
    "정상 크기 문단 줄" 판단 기준(문단 줄 폭 추정치)이 그 캡션 폭까지
    부풀려져서 진짜 온전한 문단 줄까지 수식에 흡수돼버리는 회귀가 있었다."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    # 페이지 폭 대부분을 차지하는 캡션 줄(약 500pt, 페이지 폭의 82%)
    page.insert_text((55, 300), "Figure 1. A very long caption that spans almost the entire page width here.", fontsize=9)
    # 문단 줄 - 페이지 폭의 약 55%(수식과 무관한 온전한 문장)
    page.insert_text((55, 340), "This paragraph line describes the context around the equation below fully.", fontsize=9)
    page.insert_text((55, 400), "This paragraph line comes right after the equation and continues the text.", fontsize=9)
    page.insert_text((220, 370), "a = b + c", fontsize=11)
    page.insert_text((520, 370), "(1)", fontsize=11)
    path = tmp_path / "wide_caption.pdf"
    doc.save(str(path))
    doc.close()

    result = extract_pdf_images(str(path))
    entries = [r for r in result if r.get("label") == "Equation 1"]
    assert len(entries) == 1
    _, y0, _, y1 = _pt(entries[0], page_width=612, page_height=792)
    # 위/아래 문단 줄(각각 y~300-450 부근)까지 통째로 흡수되면 안 된다 -
    # 수식 자신의 좁은 높이(수십 pt 이내)만 캡처해야 한다.
    assert y1 - y0 < 60
