"""
논문 원문 텍스트에서 References/참고문헌 섹션을 찾아 항목별로 파싱하는
순수 텍스트 처리 로직 (네트워크 호출 없음).

번호가 매겨진 인용 스타일(`[12] ...`, `12. ...`, `12) ...`)을 우선 지원하고,
번호 스타일 항목이 하나도 파싱되지 않으면 (Author, Year) 스타일(APA류)
참고문헌 목록으로 폴백해서 파싱한다. 두 스타일을 한 문서에서 섞어 쓰는
경우는 드물어서 폴백 방식으로 충분하다. (Author, Year) 항목은 번호가 없어
"첫 저자 성(소문자) + 연도"를 키로 쓴다(예: "vaswani2017") - 프론트엔드의
본문 인용 표기 매칭(main.js의 parseAuthorYearKeys)과 반드시 같은 키 형식을
써야 한다.

대괄호 스타일은 순수 숫자(`[12]`)뿐 아니라 alpha 스타일 BibTeX가 흔히 쓰는
"저자 이니셜+연도" 키워드 키(`[BCV13]`, `[LBH+15]`, `[Dev86]` 등)도 그대로
키로 인정한다 - 프론트엔드의 CITATION_MARKER_RE도 동일한 키 형식을 감지한다.

번호형(대괄호/평문) 항목 경계는 줄바꿈이 아니라 "항목 시작 표기" 자체를
전체 텍스트에서 직접 찾아 판정한다(아래 _extract_marker_entries 참고) -
2단 레이아웃 논문에서 실제로 관찰된 문제: pdf_parser.py의 블록 추출 결과가
참고문헌 항목 경계와 줄바꿈이 전혀 일치하지 않는 경우가 흔하다(항목 하나가
줄바꿈으로 쪼개지거나, 서로 다른 두 항목이 줄바꿈 없이 한 줄에 붙어버림).
"""

import re
from typing import Dict, List, Optional

from services.pdf_parser import _INDENT_SENTINEL

# 헤더 단어의 글자 사이에 공백을 허용한다 - 드롭캡(첫 글자만 별도 폰트/굵기)
# 렌더링 시 "**R** **EFERENCES**"처럼 글자 사이에 공백이 끼어드는 경우까지
# 대응하기 위함이다(별표는 별도로 먼저 제거).
_HEADER_PREFIX_RE = re.compile(
    r"^\s*(?:r\s*e\s*f\s*e\s*r\s*e\s*n\s*c\s*e\s*s|b\s*i\s*b\s*l\s*i\s*o\s*g\s*r\s*a\s*p\s*h\s*y|"
    r"참\s*고\s*문\s*헌)\b",
    re.IGNORECASE,
)
# 대괄호 키는 순수 숫자([12]) 또는 "저자 이니셜+연도" 꼴([BCV13], [Dev86],
# [LBH+15])만 인정하고, 숫자가 전혀 없는 순수 알파벳 키는 거부한다 -
# 참고문헌 항목 안에는 "... 2021. [Online]. Available: ..." 처럼 서지
# 매체를 나타내는 대괄호 표기([Online], [Internet], [Software] 등)가 실제로
# 흔히 등장하는데, 이런 단어들이 새 항목의 시작으로 오인되면 그 뒤 진짜
# 항목들이 전부 직전 항목에 잘못 흡수되어 버린다.
_BRACKET_KEY_RE = re.compile(r"\d{1,3}|[A-Za-z]{1,6}\+?\d{2,4}[a-z]?")
_BRACKET_ENTRY_RE = re.compile(r"^\s*\[(" + _BRACKET_KEY_RE.pattern + r")\]\s*(.+)")
_PLAIN_NUMBERED_ENTRY_RE = re.compile(r"^\s*(\d{1,3})[.)]\s+(.+)")

# 아래 두 정규식은 줄 시작(^)에 앵커하지 않고 텍스트 전체에서 "항목이 시작하는
# 지점" 자체를 찾는 데 쓴다(_extract_marker_entries) - 매치와 매치 사이 구간을
# 그대로 항목 텍스트로 잘라내므로, 항목 중간에 줄바꿈이 끼어 있든 두 항목이
# 줄바꿈 없이 붙어 있든 항목 경계를 정확히 잡아낼 수 있다.
_BRACKET_MARKER_RE = re.compile(r"\[(" + _BRACKET_KEY_RE.pattern + r")\]")
# 평문 번호형은 대괄호보다 오탐 위험이 크다(항목 안에 흔한 "vol. 12," 같은
# 숫자+마침표와 구분이 안 됨) - 뒤에 대문자/한글이 바로 이어질 때만 후보로
# 인정하고, _extract_marker_entries에서 1부터 정확히 연속되는 번호만 채택해
# 우연히 일치하는 페이지/연도 숫자를 걸러낸다.
_PLAIN_NUMBERED_MARKER_RE = re.compile(r"(?:^|\s)(\d{1,3})[.)]\s+(?=[A-Z가-힣])")

# References 섹션 뒤에 곧바로 이어지는 Appendix 표제 - 표제만 딱 담긴 줄에만
# 일치하도록(문장 중간의 "see Appendix B" 같은 언급과 구분) 줄 전체를 앵커링한다.
_APPENDIX_HEADER_RE = re.compile(
    r"^(?:appendix|supplementary material|supplemental material)(?:\s+[A-Z0-9]{1,3})?\.?$",
    re.IGNORECASE,
)

# (Author, Year) 스타일 항목의 시작 판별용 - "Surname, Initial..." 형태로
# 시작하는 구간을 새 항목의 시작으로 본다. 실제로 참고문헌 항목인지는 flush
# 시점에 텍스트 전체에서 연도가 발견되는지로 한 번 더 검증한다(오탐 방지).
#
# 첫 저자가 "Inception Labs," "Google DeepMind," 처럼 여러 단어로 된 기관명인
# 경우도 있어("Inception Labs, Khanna, S., ..." - 실제로 관찰된 문서), 성 뒤에
# 공백으로 이어지는 대문자 단어를 추가로 몇 개 더 허용한다. 키(=프론트엔드
# main.js의 extractAuthorYearClauses와 맞춰야 하는 부분)는 항상 첫 단어만
# 쓰므로 캡처 그룹은 첫 단어에만 건다.
#
# 다만 이 다중 단어 허용은 "In NeurIPS, 2020." "In ICML, 2015." 같은 학회명
# 인용구(항목 안의 문장이지 새 항목이 아님)까지 오탐하게 만든다 - "In"과
# "NeurIPS"가 둘 다 대문자로 시작해 SURNAME_SRC에 그대로 걸림. 실제 저자
# 목록은 콤마 뒤에 보통 이니셜("S.", "J. C.")이나 또 다른 저자 성이 이어지고
# 곧바로 4자리 숫자가 오지 않는 반면, 학회명 인용구는 콤마 뒤에 곧장 연도가
# 온다는 차이가 있어, 콤마 뒤에 숫자가 바로 오는 경우는 항목 시작으로 인정하지
# 않는다(그 대가로 저자 이니셜 없이 "Google, 2023."처럼 곧장 연도가 오는
# 극히 드문 기관 저자 항목은 놓칠 수 있음).
_AUTHOR_YEAR_SURNAME_WORD_SRC = r"[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\-']*"
_AUTHOR_YEAR_SURNAME_SRC = (
    "(" + _AUTHOR_YEAR_SURNAME_WORD_SRC + ")"
    r"(?:\s" + _AUTHOR_YEAR_SURNAME_WORD_SRC + r")*"
)
_AUTHOR_YEAR_SURNAME_END_SRC = r",\s(?!\d)"
_AUTHOR_YEAR_ENTRY_START_RE = re.compile(r"^\s*" + _AUTHOR_YEAR_SURNAME_SRC + _AUTHOR_YEAR_SURNAME_END_SRC)
# 항목 경계 자체를 텍스트 전체에서 찾을 때 쓴다(_parse_author_year_entries 참고) -
# 문장 경계(마침표/느낌표/물음표 + 공백) 또는 텍스트 시작 바로 뒤에 "Surname,"
# 패턴이 오는 지점을 새 항목의 시작으로 본다. 항목 안의 공저자 나열은 보통
# 세미콜론이나 "&"로 구분되고 성 뒤에 곧바로 마침표+공백이 오는 경우가 거의
# 없어(이니셜 뒤에는 대개 쉼표나 세미콜론이 옴) 오탐 위험이 낮다.
#
# 일부 논문(backref 패키지 사용)은 각 항목 끝에 "이 문헌이 인용된 페이지 번호"
# 목록을 덧붙인다(예: "... 2023. 1" 또는 "... 2025. 8, 9, 10") - 이 숫자
# 목록이 마침표와 다음 항목의 "Surname," 사이에 끼어들면 경계를 못 찾고 다음
# 수십 개 항목 전체가 앞 항목 하나에 뭉쳐 흡수돼버리는 문제가 실제로 관찰됨.
# 마침표 뒤에 그런 숫자 목록이 있으면 건너뛰고 그 다음에서 Surname을 찾는다.
_AUTHOR_YEAR_CITED_PAGES_SRC = r"\d{1,4}(?:,\s*\d{1,4})*\s+"
_AUTHOR_YEAR_ENTRY_BOUNDARY_RE = re.compile(
    r"(?:^|[.!?]\s+(?:" + _AUTHOR_YEAR_CITED_PAGES_SRC + r")?)"
    r"(?=" + _AUTHOR_YEAR_SURNAME_SRC + _AUTHOR_YEAR_SURNAME_END_SRC + r")"
)
# 연도는 APA류처럼 괄호로 싸인 경우("(2020)")뿐 아니라, AAAI/IJCAI류처럼
# 저자 목록 바로 뒤에 괄호 없이 오는 경우("... 2020. Title...")도 지원한다.
_YEAR_RE = re.compile(r"\((\d{4})[a-z]?\)|(?<!\d)(\d{4})[a-z]?\.(?=\s|$)")

_MAX_ENTRY_LENGTH = 500


def _match_section_header_prefix(line: str) -> Optional[str]:
    """줄이 References/Bibliography/참고문헌 헤더로 시작하면 그 뒤에 남는
    텍스트를 반환하고, 헤더로 시작하지 않으면 None을 반환합니다.

    일부 논문(특히 Nature류)은 헤더 다음에 개행 없이 바로 첫 항목이 이어져
    "**References** 48. Haist, F. ..."처럼 한 줄에 같이 붙어 나온다. 이
    경우 남는 텍스트("48. Haist, F. ...")가 실제로 참고문헌 항목의 시작처럼
    보일 때만 헤더로 인정한다 - 그냥 "References"로 시작하는 일반 문장을
    섹션 시작으로 오인하지 않기 위함이다. 헤더만 있고 뒤에 아무것도 없는
    깔끔한 줄은 그대로 빈 문자열을 반환한다.
    """
    no_asterisks = re.sub(r"\*+", "", line)
    m = _HEADER_PREFIX_RE.match(no_asterisks)
    if not m:
        return None

    remainder = no_asterisks[m.end():].strip()
    if not remainder:
        return remainder
    if (_BRACKET_ENTRY_RE.match(remainder) or _PLAIN_NUMBERED_ENTRY_RE.match(remainder)
            or _AUTHOR_YEAR_ENTRY_START_RE.match(remainder)):
        return remainder
    return None


def find_reference_start_page_index(pages: List[dict]) -> Optional[int]:
    """참고문헌 섹션이 시작하는 페이지의 0-based 인덱스를 찾습니다. 끝
    페이지부터 거꾸로 스캔해 실제 섹션 헤더(본문 중 우연히 "References"라는
    단어가 언급된 경우가 아니라 섹션 자체의 시작)를 찾습니다 - 결론 뒤에
    참고문헌이 오는 일반적인 논문 구조를 전제로, 뒤에서부터 찾는 편이 앞에서
    찾는 것보다 본문 중 언급과의 오탐이 적습니다. 찾지 못하면 None을
    반환합니다. extract_reference_list와 services.library.get_reference_start_page
    (읽은 페이지 수 계산에서 참고문헌 페이지를 제외하는 데 사용) 양쪽에서
    공유합니다."""
    for i in range(len(pages) - 1, -1, -1):
        text = pages[i].get("text", "") or ""
        if any(_match_section_header_prefix(line) is not None for line in text.split("\n")):
            return i
    return None


def extract_reference_list(pages: List[dict]) -> Dict[str, str]:
    """페이지 목록(각 {"text": ...} 포함)에서 참고문헌 목록을 파싱합니다.

    반환값: {"12": "Vaswani et al. Attention Is All You Need. 2017.", ...}
    섹션을 찾지 못하거나 파싱에 실패하면 빈 딕셔너리를 반환합니다(호출부가
    이 실패를 전체 기능 중단으로 이어가지 않도록).
    """
    try:
        return _extract_reference_list_impl(pages)
    except Exception:
        return {}


def _extract_reference_list_impl(pages: List[dict]) -> Dict[str, str]:
    ref_start_page_idx = find_reference_start_page_index(pages)
    if ref_start_page_idx is None:
        return {}

    combined_text = "\n".join(p.get("text", "") or "" for p in pages[ref_start_page_idx:])
    # pdf_parser.py가 들여쓰기된 문단 앞에 붙이는 내부 마커(_INDENT_SENTINEL) -
    # 원래는 chunker.py가 번역 파이프라인에서 소비하는 표시인데, 참고문헌
    # 목록의 줄바꿈된 항목(첫 줄은 안 들여써지고 이어지는 줄은 들여써지는
    # hanging indent 서식)도 이 표시가 붙은 채로 들어와, 그대로 두면 툴팁에
    # 보이는 참고문헌 원문에 눈에 안 보이는 문자가 섞여 나온다.
    combined_text = combined_text.replace(_INDENT_SENTINEL, "")
    lines = combined_text.split("\n")

    start_idx = 0
    for idx, line in enumerate(lines):
        remainder = _match_section_header_prefix(line)
        if remainder is not None:
            # 헤더 뒤에 같은 줄로 바로 이어지는 첫 항목이 있으면(remainder)
            # 그 부분은 버리지 않고 body_lines의 첫 줄로 그대로 살린다.
            lines[idx] = remainder
            start_idx = idx
            break
    body_lines = lines[start_idx:]

    # 많은 논문이 References 섹션 바로 뒤에 Appendix를 이어 붙인다(같은 PDF,
    # 페이지 구분 없음). References 시작 페이지부터 문서 끝까지를 통째로
    # 가져오는 위 combined_text 구성 방식상, Appendix 헤더를 걷어내지 않으면
    # 부록 본문 전체가 마지막 참고문헌 항목 하나에 통째로 흡수된다(실제로
    # 부록 안의 "Notably, evidence shows..." 같은 일반 문장까지 "Surname,"
    # 패턴에 우연히 걸려 항목 경계로 오인되는 경우도 있어 더 위험함). Appendix
    # 표제만 있는 줄을 만나면 그 지점에서 자른다 - "... see Appendix B" 처럼
    # 문장 중간에 낀 언급은 줄 전체가 표제와 일치하지 않으므로 걸리지 않는다.
    for idx, line in enumerate(body_lines):
        if idx == 0:
            continue
        stripped = re.sub(r"\*+", "", line).strip()
        if _APPENDIX_HEADER_RE.match(stripped):
            body_lines = body_lines[:idx]
            break

    # 항목 경계 탐지는 줄바꿈에 기대지 않는다(아래 _extract_marker_entries
    # 참고) - 여기서는 그냥 하나의 문자열로 이어붙이기만 한다.
    body_text = "\n".join(body_lines)

    entries = _extract_marker_entries(body_text, _BRACKET_MARKER_RE)
    if not entries:
        entries = _extract_marker_entries(body_text, _PLAIN_NUMBERED_MARKER_RE, sequential=True)
    if not entries:
        entries = _parse_author_year_entries(body_text)

    return entries


def _extract_marker_entries(text: str, marker_re: "re.Pattern", sequential: bool = False) -> Dict[str, str]:
    """텍스트 전체에서 marker_re에 매칭되는 "항목 시작 표기"를 전부 찾아,
    연속된 두 매치 사이 구간을 항목 텍스트로 잘라낸다.

    sequential=True(평문 번호형)이면 오탐 방지를 위해 1부터 정확히
    연속되는 번호(1, 2, 3, ...)만 항목 시작으로 채택한다 - 실제 참고문헌
    번호는 항상 이렇게 증가하므로, 항목 본문 안의 우연한 숫자(페이지·연도
    등)를 걸러내는 데 이 제약만으로 충분하다.
    """
    matches = list(marker_re.finditer(text))
    if sequential:
        filtered = []
        expected = 1
        for m in matches:
            if int(m.group(1)) != expected:
                continue
            filtered.append(m)
            expected += 1
        matches = filtered

    entries: Dict[str, str] = {}
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        entry_text = re.sub(r"\s+", " ", text[start:end]).strip()
        if entry_text and m.group(1) not in entries:
            entries[m.group(1)] = entry_text[:_MAX_ENTRY_LENGTH]
    return entries


def _parse_author_year_entries(body_text: str) -> Dict[str, str]:
    """번호가 없는 (Author, Year) 스타일 참고문헌 목록을 파싱합니다.

    예전에는 물리적 줄(\\n) 시작에서만 새 항목을 판별했는데, 2단 레이아웃
    논문에서 실제로 관찰된 문제: PyMuPDF가 참고문헌 항목 사이의 여백을
    인식하지 못하고 여러(때로는 대부분의) 항목을 줄바꿈이 전혀 없는 하나의
    블록으로 통째로 추출하는 경우가 흔하다. 그러면 줄 기반 판별로는 첫
    항목만 인식되고 나머지 전부가 그 항목 하나에 흡수돼버린다.

    이를 피하기 위해 번호형(_extract_marker_entries)과 동일한 원칙으로,
    항목 경계를 줄바꿈이 아니라 "문장 경계(마침표 등) 뒤에 오는 Surname,
    패턴" 자체를 텍스트 전체에서 찾아 판정한다. 실제로 참고문헌 항목인지는
    잘라낸 구간 안에 연도가 포함돼 있는지로 한 번 더 검증한다(오탐 방지).
    키는 "성(소문자)+연도"(예: "vaswani2017")이며, 같은 저자가 같은 해에
    여러 편을 낸 경우(2020a/2020b 등) 먼저 나온 항목만 유지한다.
    """
    normalized = re.sub(r"\s+", " ", body_text).strip()
    if not normalized:
        return {}

    starts = [m.end() for m in _AUTHOR_YEAR_ENTRY_BOUNDARY_RE.finditer(normalized)]
    if not starts or starts[0] != 0:
        starts.insert(0, 0)

    entries: Dict[str, str] = {}
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(normalized)
        text = normalized[start:end].strip()
        if not text:
            continue
        surname_match = _AUTHOR_YEAR_ENTRY_START_RE.match(text)
        if not surname_match:
            continue
        year_match = _YEAR_RE.search(text)
        if not year_match:
            continue
        year = year_match.group(1) or year_match.group(2)
        key = f"{surname_match.group(1).lower()}{year}"
        if key not in entries:
            entries[key] = text[:_MAX_ENTRY_LENGTH]
    return entries
