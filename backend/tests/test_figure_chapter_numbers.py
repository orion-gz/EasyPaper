"""Chapter-qualified captions must not collide with integer figure labels."""
import fitz
import pytest

from services.pdf_parser import _CAPTION_RE, extract_pdf_images


@pytest.mark.parametrize('text,number', [
    ('Figure 4.18: Example', '4.18'),
    ('Fig. 4.18. Example', '4.18'),
    ('Table 12.3.10 Example', '12.3.10'),
    ('Figure 4. Example', '4'),
    ('TABLE III: Example', 'III'),
])
def test_caption_preserves_full_number(text, number):
    assert _CAPTION_RE.match(text).group(2) == number


def test_body_reference_is_not_truncated_into_caption():
    assert _CAPTION_RE.match('Figure 4.18 shows the result') is None


def test_extracted_figures_have_distinct_chapter_labels(tmp_path):
    path = tmp_path / 'chapter-figures.pdf'
    with fitz.open() as doc:
        for number in ('4', '4.1', '4.18', 'S1', 'A.1', '2(a)'):
            page = doc.new_page()
            page.draw_rect(fitz.Rect(80, 150, 500, 400), color=(0, 0, 0), width=1.5)
            page.draw_line(fitz.Point(100, 350), fitz.Point(480, 200), color=(0, 0, 0))
            page.insert_text((80, 430), f'Figure {number}: Example diagram', fontsize=10)
        doc.save(path)
    images = extract_pdf_images(str(path), engine='pymupdf')
    labels = {image.get('label'): image['page'] for image in images}
    assert labels['Figure 4'] == 1
    assert labels['Figure 4.1'] == 2
    assert labels['Figure 4.18'] == 3
    assert labels['Figure S1'] == 4
    assert labels['Figure A.1'] == 5
    assert labels['Figure 2'] == 6


@pytest.mark.parametrize('text,label', [
    ('FIGURE 4.18: Example', 'Figure 4.18'),
    ('fig.\u00a04.18: Example', 'Figure 4.18'),
    ('Figure S1: Example', 'Figure S1'),
    ('Fig. s1a: Example', 'Figure S1'),
    ('Figure A.1: Example', 'Figure A.1'),
    ('Figure A1: Example', 'Figure A1'),
    ('Figure 2a: Example', 'Figure 2'),
    ('Figure 2(a): Example', 'Figure 2'),
    ('Figure 2 (a): Example', 'Figure 2'),
    ('Figure 2(a—c): Example', 'Figure 2'),
    ('fig. iv: Example', 'Figure IV'),
    ('Tab. A.2: Example', 'Table A.2'),
])
def test_caption_variants_use_reference_labels(text, label):
    from services.pdf_parser import _match_label_from_caption_text
    assert _match_label_from_caption_text(text)[0] == label


@pytest.mark.parametrize('text', [
    'Figure IVX: Example', 'Figure Introduction', 'Figure 2nd: Example',
    'Figure 4.18th: Example', 'Tablet A.1', 'Fig. S1st: Example',
    'Figure S1 shows the result',
])
def test_caption_does_not_accept_partial_identifiers(text):
    from services.pdf_parser import _match_label_from_caption_text
    assert _match_label_from_caption_text(text)[0] is None
