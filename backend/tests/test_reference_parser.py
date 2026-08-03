"""services/reference_parser.py 테스트 - References/참고문헌 섹션 파싱."""

from services.reference_parser import extract_reference_list


def test_parses_bracket_style_numbered_references():
    pages = [
        {"page_num": 1, "text": "Title\n\nAbstract\n\nBody text..."},
        {"page_num": 9, "text": (
            "Conclusion\n\nWe presented the Transformer.\n\n"
            "References\n\n"
            "[1] Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. Neural machine "
            "translation by jointly learning to align and translate. CoRR, 2014.\n\n"
            "[2] Jianpeng Cheng, Li Dong, and Mirella Lapata. Long short-term "
            "memory-networks for machine reading. In EMNLP, 2016."
        )},
    ]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"1", "2"}
    assert "Bahdanau" in refs["1"]
    assert "Cheng" in refs["2"]


def test_parses_plain_numbered_references_with_korean_header():
    pages = [
        {"page_num": 1, "text": "논문 제목\n\n초록\n\n본문 내용..."},
        {"page_num": 5, "text": (
            "결론\n\n참고문헌\n\n"
            "1. Smith, J. Deep Learning Basics. NeurIPS 2020.\n\n"
            "2. Lee, K. Attention Mechanisms Survey. ICML 2021."
        )},
    ]
    refs = extract_reference_list(pages)
    assert refs == {
        "1": "Smith, J. Deep Learning Basics. NeurIPS 2020.",
        "2": "Lee, K. Attention Mechanisms Survey. ICML 2021.",
    }


def test_returns_empty_dict_when_no_references_section():
    pages = [{"page_num": 1, "text": "그냥 본문 텍스트입니다. 참고문헌 섹션 없음."}]
    assert extract_reference_list(pages) == {}


def test_returns_empty_dict_for_empty_input():
    assert extract_reference_list([]) == {}


def test_merges_multiline_entries():
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "[1] A very long author list that continues\n"
        "onto a second physical line before the year\n"
        "and publisher information. 2021."
    )}]
    refs = extract_reference_list(pages)
    assert "continues" in refs["1"]
    assert "publisher information" in refs["1"]


def test_truncates_excessively_long_entries():
    long_text = "A. Author. " + ("Very long title words. " * 100)
    pages = [{"page_num": 1, "text": f"References\n\n[1] {long_text}"}]
    refs = extract_reference_list(pages)
    assert len(refs["1"]) <= 500


def test_does_not_crash_on_malformed_page_data():
    """text 키가 없거나 None이어도 예외 없이 빈 결과를 반환해야 한다."""
    assert extract_reference_list([{"page_num": 1}]) == {}
    assert extract_reference_list([{"page_num": 1, "text": None}]) == {}


def test_parses_paren_numbered_references():
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "1) Smith, J. Deep Learning Basics. NeurIPS 2020.\n\n"
        "2) Lee, K. Attention Mechanisms Survey. ICML 2021."
    )}]
    refs = extract_reference_list(pages)
    assert refs == {
        "1": "Smith, J. Deep Learning Basics. NeurIPS 2020.",
        "2": "Lee, K. Attention Mechanisms Survey. ICML 2021.",
    }


def test_parses_author_year_style_references():
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, "
        "A. N., Kaiser, L., & Polosukhin, I. (2017). Attention is all you need. "
        "Advances in Neural Information Processing Systems, 30.\n\n"
        "Devlin, J., Chang, M. W., Lee, K., & Toutanova, K. (2019). BERT: "
        "Pre-training of deep bidirectional transformers for language "
        "understanding. NAACL."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"vaswani2017", "devlin2019"}
    assert "Attention is all you need" in refs["vaswani2017"]
    assert "BERT" in refs["devlin2019"]


def test_author_year_entry_spans_multiple_lines():
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Cheng, J., Dong, L., & Lapata, M. Long short-term memory-networks\n"
        "for machine reading. In Proceedings of EMNLP (2016)."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"cheng2016"}
    assert "machine reading" in refs["cheng2016"]


def test_author_year_ignores_non_reference_sentences_without_year():
    """대문자로 시작하고 쉼표가 있어도 연도가 없으면 참고문헌 항목으로 오인하지 않는다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Note, this section intentionally left without a proper citation list."
    )}]
    assert extract_reference_list(pages) == {}


def test_parses_header_with_drop_cap_bold_split():
    """일부 논문 템플릿은 섹션 제목 첫 글자를 드롭캡으로 렌더링해서, 텍스트
    추출 시 "**R****EFERENCES**"처럼 단어 중간에 마크다운 볼드(**)가 끼어드는
    경우가 있다(실제 UniFormer 논문에서 재현된 케이스)."""
    pages = [{"page_num": 1, "text": (
        "some conclusion text.\n\n"
        "**R****EFERENCES**\n\n"
        "[1] A. Arnab, M. Dehghani. Vivit: A video vision transformer. ICCV, 2021.\n\n"
        "[2] Jimmy Ba, Jamie Ryan Kiros. Layer normalization. ArXiv, 2016."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"1", "2"}
    assert "Vivit" in refs["1"]


def test_parses_header_with_space_separated_drop_cap():
    """드롭캡 뒤에 공백까지 끼는 "**R** **EFERENCES**" 형태도 지원한다."""
    pages = [{"page_num": 1, "text": (
        "**R** **EFERENCES**\n\n"
        "[1] Some Author. A paper title. 2020."
    )}]
    refs = extract_reference_list(pages)
    assert refs == {"1": "Some Author. A paper title. 2020."}


def test_parses_entries_packed_on_one_line_without_separators():
    """2단 레이아웃 PDF의 블록 추출 결과, 서로 다른 여러 항목이 줄바꿈 없이
    한 줄에 이어 붙는 경우가 실제로 관찰된다(예: 실제 EEG Conformer 논문의
    참고문헌 목록). 항목 경계가 줄바꿈이 아니라 "[N]" 표기 자체로 판정되어야
    이런 경우에도 각 항목이 올바르게 분리된다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "[1] J. Jin et al., “A novel framework,” IEEE Trans., vol. 30, "
        "pp. 20–29, 2022. [2] B. Liu et al., “Improving SSVEP-BCI,” "
        "IEEE Trans., vol. 29, pp. 1998–2007, 2021. [3] J. W. Li et al., "
        "“Single-channel selection,” J. Biomed., vol. 26, 2022."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"1", "2", "3"}
    assert "Jin" in refs["1"] and "Liu" not in refs["1"]
    assert "Liu" in refs["2"] and "Single-channel" not in refs["2"]
    assert "Single-channel" in refs["3"]


def test_parses_entry_split_across_hanging_indent_continuation_line():
    """hanging indent 서식(첫 줄은 안 들여쓰고 이어지는 줄만 들여쓰는 참고문헌
    표기)에서, 실제 pdf_parser.py가 들여쓰기된 이어지는 줄 앞에 내부 마커
    (_INDENT_SENTINEL)를 붙여 반환한다 - 참고문헌 파싱 결과에는 이 마커가
    노출되지 않아야 하고, 항목도 하나로 정상 병합되어야 한다."""
    from services.pdf_parser import _INDENT_SENTINEL
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "[1] J. Jin et al., “A novel classification framework using the graph\n\n"
        f"{_INDENT_SENTINEL}representations of electroencephalogram,” IEEE Trans., 2022. "
        "[2] B. Liu et al., “Second entry,” 2021."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"1", "2"}
    assert _INDENT_SENTINEL not in refs["1"]
    assert "representations of electroencephalogram" in refs["1"]


def test_bracket_bibliographic_medium_marker_is_not_treated_as_new_entry():
    """"[Online]", "[Internet]" 같은 서지 매체 표기 대괄호는 참고문헌 항목
    안에 실제로 흔히 등장하는데, 숫자가 없는 순수 알파벳 키라 새 항목의
    시작으로 오인되면 안 된다(오인되면 그 뒤 진짜 항목이 전부 잘못 흡수됨)."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "[22] Y. Song et al., “Transformer-based learning,” Jun. 2021. "
        "[Online]. Available: https://arxiv.org/abs/2106.11170 "
        "[23] S. Bagchi and D. Bathula, “EEG-ConvTransformer,” 2022."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"22", "23"}
    assert "Online" in refs["22"]  # 항목 텍스트 안에는 그대로 남아 있어야 함
    assert "Bagchi" in refs["23"]


def test_parses_keyword_style_bracket_references():
    """일부 논문(특히 VAE류)은 저자 이니셜+연도 키워드를 대괄호 키로 쓴다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "[BCV13] Y. Bengio, A. Courville, and P. Vincent. Representation "
        "learning: A review and new perspectives. 2013.\n\n"
        "[Dev86] G. E. Deville. Some early paper. 1986."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"BCV13", "Dev86"}
    assert "Bengio" in refs["BCV13"]
    assert "Deville" in refs["Dev86"]


def test_author_year_keeps_first_entry_on_duplicate_key():
    """같은 저자가 같은 해에 여러 편(2020a/2020b 등)이면 먼저 나온 항목만 유지한다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Kim, S. (2020a). First paper title.\n\n"
        "Kim, S. (2020b). Second paper title."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"kim2020"}
    assert "First paper title" in refs["kim2020"]


def test_author_year_entries_merged_into_single_block_without_line_breaks():
    """2단 레이아웃 논문에서 실제로 관찰된 문제: pdf_parser.py가 여러(때로는
    거의 대부분의) 참고문헌 항목 사이에 줄바꿈을 전혀 남기지 않고 하나의
    블록으로 통째로 추출하는 경우가 있다(실제 논문에서 재현됨). 줄 기반
    판별이었다면 첫 항목만 인식되고 나머지 전부가 거기 흡수됐을 것이다.
    또한 이 케이스는 AAAI/IJCAI류 서식(연도가 괄호 없이 "... 2022. Title"
    형태로 저자 목록 바로 뒤에 옴)도 함께 검증한다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Gifford, A. T.; Dwivedi, K.; Roig, G.; and Cichy, R. M. 2022. A large "
        "and rich EEG dataset for modeling human visual object recognition. "
        "NeuroImage, 264: 119754. Grill-Spector, K.; and Malach, R. 2004. The "
        "human visual cortex. Annu. Rev. Neurosci., 27(1): 649-677. Hansen, "
        "K. A.; Kay, K. N.; and Gallant, J. L. 2007. Topographic organization "
        "in and near human visual area V4. Journal of Neuroscience, 27(44): "
        "11896-11911."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"gifford2022", "grill-spector2004", "hansen2007"}
    assert "EEG dataset" in refs["gifford2022"]
    assert "human visual cortex" in refs["grill-spector2004"]
    assert "Topographic organization" in refs["hansen2007"]


def test_author_year_supports_plain_year_without_parentheses():
    """APA류("(2020)")뿐 아니라 AAAI/IJCAI류처럼 연도가 괄호 없이 오는
    서식("... 2020. Title")도 지원해야 한다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Smith, J.; and Lee, K. 2020. A paper without parenthesized year. "
        "Some Venue, 1: 1-10."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"smith2020"}
    assert "without parenthesized year" in refs["smith2020"]


def test_author_year_supports_multi_word_organization_author():
    """"Inception Labs, Khanna, S., ..."처럼 첫 저자가 여러 단어로 된 기관명인
    항목도 독립된 항목으로 인식해야 한다(실제 The Flexibility Trap 논문에서
    재현된 케이스). 키는 프론트엔드(main.js의 extractAuthorYearClauses)와
    맞춰 첫 단어만 사용한다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Huang, Z., Chen, Z., and Li, T. Reinforcing the diffusion chain. "
        "In NeurIPS, 2025.\n\n"
        "Inception Labs, Khanna, S., and Kharbanda, S. Mercury: Ultra-fast "
        "language models based on diffusion. arXiv preprint arXiv:2506.17298, 2025."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"huang2025", "inception2025"}
    assert "Mercury" in refs["inception2025"]
    assert "Mercury" not in refs["huang2025"]


def test_author_year_boundary_tolerates_backref_cited_page_numbers():
    """backref 패키지를 쓰는 논문은 각 항목 끝에 "이 문헌이 인용된 페이지
    번호" 목록을 덧붙인다(예: "... 2023. 1" 또는 "... 2025. 8, 9, 10"). 이
    숫자 목록이 마침표와 다음 항목의 "Surname," 사이에 끼면 경계를 놓쳐
    뒤따르는 항목 전부가 앞 항목 하나에 흡수되던 문제가 실제로 있었다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Achiam, J., Adler, S. GPT-4 technical report. arXiv preprint "
        "arXiv:2303.08774, 2023. 1\n\n"
        "Ben-Hamu, H., Gat, I. Accelerated sampling from masked diffusion "
        "models. In NeurIPS, 2025. 8, 9, 10"
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"achiam2023", "ben-hamu2025"}
    assert "Ben-Hamu" not in refs["achiam2023"]


def test_author_year_venue_citation_is_not_mistaken_for_new_entry():
    """"In NeurIPS, 2020."처럼 항목 안에 등장하는 학회명 인용구는(두 단어 다
    대문자로 시작해 다중 단어 기관 저자 패턴과 겉보기 형태가 같음) 새 항목의
    시작으로 오인되면 안 된다 - 콤마 뒤에 곧장 연도가 오는지로 구분한다."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Ho, J., Jain, A., and Abbeel, P. Denoising diffusion probabilistic "
        "models. In NeurIPS, 2020. Some further description continues here."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"ho2020"}
    assert "NeurIPS" in refs["ho2020"]


def test_author_year_stops_before_appendix_section():
    """References 섹션 바로 뒤에 Appendix가 페이지 구분 없이 이어 붙는 논문이
    흔하다. Appendix 표제를 걷어내지 않으면 부록 본문 전체가 마지막 참고문헌
    항목 하나에 통째로 흡수된다(실제 The Flexibility Trap 논문에서 재현된
    케이스 - 부록 안의 일반 문장이 "Surname," 패턴에 우연히 걸려 경계로
    오인되는 경우까지 있어 더 위험함)."""
    pages = [{"page_num": 1, "text": (
        "References\n\n"
        "Zhu, F., Wang, R. LLaDA 1.5: Variance-reduced preference optimization. "
        "arXiv preprint arXiv:2505.19223, 2025. 1, 4, 8\n"
        "**Appendix**\n\n"
        "**A. Experimental Details**\n\n"
        "Notably, even under these optimized settings, the arbitrary order mode "
        "does not recover the same coverage."
    )}]
    refs = extract_reference_list(pages)
    assert set(refs.keys()) == {"zhu2025"}
    assert "Notably" not in refs["zhu2025"]
    assert "Appendix" not in refs["zhu2025"]
