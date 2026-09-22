"""Reading order must follow columns even when PDF object order differs."""
import fitz
import pytest

from services.pdf_parser import (
    _detect_three_columns,
    _extract_page,
    _sort_three_columns,
)


def block(x, y, label, width=163, height=80):
    return (x, y, x + width, y + height, label * 220, False)


def test_three_column_detection_uses_text_volume_not_block_count():
    blocks = [block(42, 558, 'L'), block(215, 558, 'M'), block(388, 558, 'R')]
    assert _detect_three_columns(blocks, 585) == [42, 215, 388]
    assert _sort_three_columns(blocks[::-1], 585, [42, 215, 388]) == blocks


@pytest.mark.parametrize('blocks', [
    [block(42, 50, 'L', width=240), block(310, 50, 'R', width=240)],
    [block(42, 50, 'L'), block(388, 50, 'R'), (215, 50, 378, 60, 'label')],
    [block(42, 50, 'A'), block(50, 140, 'B'), block(58, 230, 'C')],
])
def test_three_column_detection_rejects_other_layouts(blocks):
    assert _detect_three_columns(blocks, 585) == []


def test_full_width_heading_splits_sections_but_two_column_caption_does_not():
    starts = [42, 215, 388]
    header = block(42, 10, 'Header', width=509, height=20)
    left = block(42, 50, 'Left')
    middle = block(215, 40, 'Middle')
    right = block(388, 35, 'Right', height=250)
    caption = block(42, 150, 'Caption', width=336)
    section = block(42, 310, 'Section', width=509, height=20)
    lower = [block(x, 350, str(i)) for i, x in enumerate(starts)]
    expected = [header, left, caption, middle, right, section, *lower]
    assert _sort_three_columns(expected[::-1], 585, starts) == expected


@pytest.mark.parametrize('starts,width', [([42], 490), ([42, 310], 230), ([42, 215, 388], 163)])
def test_pdf_extraction_reads_columns_before_moving_right(starts, width):
    with fitz.open() as doc:
        page = doc.new_page(width=585, height=783)
        # Right column starts higher and is inserted first, as in the supplied PDF.
        for i, x in reversed(list(enumerate(starts))):
            for j, y in enumerate([100 - i * 10, 400 - i * 10]):
                text = f'Column{i}Part{j} ' + 'Architecture instructions and hardware. ' * 12
                assert page.insert_textbox(fitz.Rect(x, y, x + width, y + 250), text, fontsize=9) >= 0
        result = _extract_page(page, 1)
        assert result['column_count'] == len(starts)
        markers = [f'Column{i}Part{j}' for i in range(len(starts)) for j in range(2)]
        positions = [result['text'].index(marker) for marker in markers]
        assert positions == sorted(positions)
        assert len(result['blocks']) == len(markers)
