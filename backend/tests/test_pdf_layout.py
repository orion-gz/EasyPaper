"""Known-order PDF fixtures and conservative provenance/failure contracts."""
import copy
import fitz
import pytest

from services.pdf_layout import (normalize_page, native_blocks, normalize_document,
                                 attach_source_mappings, validate_ai_order)
from services.pdf_parser import extract_pages


@pytest.fixture(autouse=True)
def no_external_analysis(monkeypatch):
    monkeypatch.setattr('config.get_analysis_provider', lambda: 'unsupported')


def make_pdf(tmp_path, placements, rotation=0):
    path = tmp_path / 'layout.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=600, height=800)
        for text, x, y in placements:
            page.insert_text((x, y), text, fontsize=10)
        page.set_rotation(rotation)
        doc.save(path)
    return path


@pytest.mark.parametrize('placements,expected', [
    ([('Second.', 40, 140), ('First.', 40, 80)], ['First.', 'Second.']),
    ([('R2.', 410, 140), ('L1.', 40, 80), ('R1.', 410, 85), ('L2.', 40, 145)], ['L1.', 'L2.', 'R1.', 'R2.']),
    ([('C2.', 440, 145), ('B1.', 240, 85), ('A2.', 40, 150), ('C1.', 440, 90), ('A1.', 40, 80), ('B2.', 240, 140)], ['A1.', 'A2.', 'B1.', 'B2.', 'C1.', 'C2.']),
    ([('Left article first.', 40, 100), ('Right article first.', 340, 105), ('Left article last.', 40, 200), ('Right article last.', 340, 210)], ['Left article first.', 'Left article last.', 'Right article first.', 'Right article last.']),
    ([('Slide group A.', 40, 100), ('Slide group B.', 350, 300)], ['Slide group A.', 'Slide group B.']),
])
@pytest.mark.parametrize('engine', ['pymupdf', 'pdfplumber'])
def test_known_pdf_order(tmp_path, placements, expected, engine):
    page = extract_pages(str(make_pdf(tmp_path, placements)), engine)[0]
    assert [b['text'] for b in page['blocks']] == expected
    assert not page['layout']['needs_review']
    assert len({b['id'] for b in page['blocks']}) == len(expected)


def block(text, box, **kwargs):
    return {'text': text, 'bbox': box, 'source_chars': [box] * len(text), **kwargs}


def normalize(blocks, resolve=None):
    return normalize_page({'page_num': 1, 'text': '\n\n'.join(b['text'] for b in blocks), 'blocks': blocks}, [], 600, 800, 'rev', resolve)


def test_mixed_full_width_heading_and_columns():
    blocks = [block('Heading', [30, 20, 570, 45]), block('Right 1', [350, 70, 550, 100]),
              block('Left 2', [30, 140, 260, 170]), block('Left 1', [30, 70, 260, 100]),
              block('Right 2', [350, 140, 550, 170]), block('Section', [30, 210, 570, 240]),
              block('End', [30, 280, 570, 310])]
    result = normalize(blocks)
    assert [b['text'] for b in result['blocks']] == ['Heading', 'Left 1', 'Left 2', 'Right 1', 'Right 2', 'Section', 'End']
    assert not result['layout']['needs_review']


@pytest.mark.parametrize('direction', ['rtl', 'vertical-rl', 'vertical-lr'])
def test_direction(direction):
    blocks = [block('Left', [30, 80, 100, 200], writing_direction=direction),
              block('Right', [350, 80, 420, 200], writing_direction=direction)]
    result = normalize(blocks)
    expected = ['Left', 'Right'] if direction == 'vertical-lr' else ['Right', 'Left']
    assert [b['text'] for b in result['blocks']] == expected


def test_roles_and_caption_link():
    blocks = [block('Body A', [30, 80, 280, 120]), block('Caption', [30, 190, 280, 215], role='caption'),
              block('Table', [30, 140, 280, 180], role='table'), block('Body B', [30, 250, 280, 280]),
              block('Footnote', [30, 710, 280, 740], role='footnote'),
              block('Formula', [30, 350, 280, 380], role='equation'),
              block('Header', [30, 10, 280, 25], role='header', include_in_translation=False)]
    result = normalize(blocks)
    assert result['text'].startswith('Body A\n\nBody B')
    assert 'Header' not in result['text']
    caption = next(b for b in result['blocks'] if b['role'] == 'caption')
    assert caption['object_id'] == 'p1-b2'
    assert len(result['blocks']) == len(blocks)
    assert result['original_blocks'] == blocks


def answer(blocks):
    return {'blocks': [{'id': b['id'], 'region': 'region', 'group': b['id'], 'direction': 'ltr'} for b in blocks]}


@pytest.mark.parametrize('bad', ['missing', 'duplicate', 'unknown', 'direction', 'group'])
def test_ai_invalid_preserves_source(bad):
    blocks = [block('A', [30, 80, 280, 120]), block('B', [40, 90, 270, 110])]
    def resolve(items):
        result = answer(items)
        if bad == 'missing': result['blocks'].pop()
        elif bad == 'duplicate': result['blocks'][1] = result['blocks'][0]
        elif bad == 'unknown': result['blocks'][0]['id'] = 'unknown'
        elif bad == 'direction': result['blocks'][0]['direction'] = 'up'
        else: result['blocks'][0]['group'] = []
        return result
    result = normalize(blocks, resolve)
    assert result['layout']['needs_review']
    assert result['layout']['method'] == 'parser_fallback'
    assert result['text'] == result['original_text']


def test_ai_only_called_for_uncertainty():
    calls = []
    def resolve(items):
        calls.append(items)
        return answer(items)
    good = normalize([block('A', [30, 80, 280, 120])], resolve)
    assert not calls
    fixed = normalize([block('A', [30, 80, 280, 120]), block('B', [40, 90, 270, 110])], resolve)
    assert len(calls) == 1
    assert fixed['layout']['method'] == 'vision'
    assert not fixed['layout']['needs_review']


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_repeated_phrase_source_mapping(tmp_path, rotation):
    path = make_pdf(tmp_path, [('Repeated sentence.', 30, 80), ('Repeated sentence.', 340, 150)], rotation)
    page = extract_pages(str(path), 'pymupdf')[0]
    sentences = [{'src': 'Repeated sentence.', 'trans': 'x'} for _ in range(2)]
    attach_source_mappings(sentences, page)
    assert all(s['source_mapping']['status'] == 'exact' for s in sentences)
    boxes = [s['source_mapping']['segments'][0]['rects'][0] for s in sentences]
    assert boxes[0][0] < 100 and boxes[1][0] > 300
    assert sentences[0]['id'] != sentences[1]['id']


def test_multiple_blocks_and_no_invented_position():
    page = normalize([block('Across', [30, 80, 100, 100]), block('columns.', [350, 80, 420, 100])])
    sentences = [{'src': 'Across columns.'}, {'src': 'Not present.'}]
    attach_source_mappings(sentences, page)
    assert len(sentences[0]['source_mapping']['segments']) == 2
    assert sentences[1]['source_mapping'] == {'status': 'unresolved', 'segments': [], 'coordinate_space': 'unrotated-top-left', 'source_revision': 'rev', 'layout_revision': page['layout']['layout_revision']}
    legacy = [{'src': 'legacy'}]
    assert attach_source_mappings(legacy, {'text': 'legacy'}) == [{'src': 'legacy'}]


def test_missing_geometry_cannot_be_fixed_by_ai():
    result = normalize_page({'page_num': 1, 'text': 'Original', 'blocks': [{'text': 'Original'}]}, [], 600, 800, 'rev', answer)
    assert result['layout']['needs_review']
    sentences = [{'src': 'Original'}]
    attach_source_mappings(sentences, result)
    assert sentences[0]['source_mapping']['status'] == 'unresolved'


def test_scanned_page_uses_ocr_geometry(tmp_path, monkeypatch):
    from services.pdf_text_recovery import needs_text_recovery
    path = tmp_path / 'scan.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=600, height=800)
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 50), False)
        pixmap.clear_with(255)
        page.insert_image(page.rect, pixmap=pixmap)
        assert needs_text_recovery(page)
        doc.save(path)
    raw = {'blocks': [{'bbox': [30, 70, 180, 90], 'lines': [{'bbox': [30, 70, 180, 90], 'wmode': 0,
           'dir': [1, 0], 'spans': [{'text': 'Recovered sentence.', 'bbox': [30, 70, 180, 90], 'size': 10, 'flags': 0}]}]}]}
    monkeypatch.setattr('services.pdf_text_recovery.recover_text', lambda *args: raw)
    page = extract_pages(str(path), 'pymupdf')[0]
    assert page['text_recovery'] == 'ocr'
    assert not page['layout']['needs_review']
    sentences = [{'src': 'Recovered sentence.'}]
    attach_source_mappings(sentences, page)
    assert sentences[0]['source_mapping']['segments'][0]['rects'] == [[30, 70, 180, 90]]


def test_vertical_progression_requires_confirmation():
    result = normalize([block('Vertical', [30, 80, 50, 300], lines=[{'wmode': 1, 'dir': [0, 1]}])])
    assert result['layout']['needs_review']
    assert 'ambiguous_direction' in result['layout']['reasons']


def test_rtl_unicode_detection():
    result = normalize([block('שלום', [30, 80, 100, 100]), block('עולם', [350, 80, 420, 100])])
    assert [b['text'] for b in result['blocks']] == ['עולם', 'שלום']


def test_vision_cache_and_revision_model_invalidation(tmp_path, monkeypatch):
    from services import pdf_layout_vision as vision
    path = make_pdf(tmp_path, [('Text.', 30, 80)])
    monkeypatch.setattr('config.CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr('config.get_analysis_provider', lambda: 'openai')
    monkeypatch.setattr('config.get_analysis_model', lambda: 'configured-model')
    calls = []
    blocks = [{'id': 'p1-b0', 'text': 'Text.', 'bbox': [30, 60, 80, 90]}]
    async def analyze(prompt, image, provider, model):
        calls.append((image, provider, model))
        return answer(blocks)
    monkeypatch.setattr(vision, '_analyze', analyze)
    resolve = vision.resolver_for_page(str(path), 1, 'rev1')
    assert resolve(blocks) == resolve(blocks)
    assert len(calls) == 1
    vision.resolver_for_page(str(path), 1, 'rev2')(blocks)
    monkeypatch.setattr('config.get_analysis_model', lambda: 'other-model')
    vision.resolver_for_page(str(path), 1, 'rev2')(blocks)
    monkeypatch.setattr(vision, 'RULE_VERSION', 'next')
    vision.resolver_for_page(str(path), 1, 'rev2')(blocks)
    assert len(calls) == 4


def test_vision_failure_and_unsupported_model(tmp_path, monkeypatch):
    from services import pdf_layout_vision as vision
    assert vision.resolver_for_page('unused.pdf', 1, 'rev') is None
    path = make_pdf(tmp_path, [('Text.', 30, 80)])
    monkeypatch.setattr('config.CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr('config.get_analysis_provider', lambda: 'openai')
    monkeypatch.setattr('config.get_analysis_model', lambda: 'unsupported-model')
    async def fail(*args):
        raise RuntimeError('model does not support images')
    monkeypatch.setattr(vision, '_analyze', fail)
    result = normalize([block('A', [30, 80, 280, 120]), block('B', [40, 90, 270, 110])],
                       vision.resolver_for_page(str(path), 1, 'rev'))
    assert result['text'] == result['original_text']
    assert result['layout']['needs_review']
    assert not list((tmp_path / 'cache').glob('**/*.json'))


def test_sentence_ending_punctuation_has_real_geometry(tmp_path):
    path = make_pdf(tmp_path, [('A complete sentence.', 30, 80)])
    page = extract_pages(str(path), 'pymupdf')[0]
    sentences = attach_source_mappings([{'src': 'A complete sentence.'}], page)
    segment = sentences[0]['source_mapping']['segments'][0]
    assert segment['char_range'] == [0, len('A complete sentence.')]
    with fitz.open(path) as doc:
        chars = doc[0].get_text('rawdict')['blocks'][0]['lines'][0]['spans'][0]['chars']
        assert list(chars[-1]['bbox']) in segment['rects']


def test_legacy_document_does_not_run_layout(tmp_path, monkeypatch):
    path = make_pdf(tmp_path, [('Legacy document.', 30, 80)])
    monkeypatch.setattr('services.pdf_layout.normalize_document', lambda *args: pytest.fail('implicit migration'))
    assert 'layout' not in extract_pages(str(path), 'pymupdf', normalize_layout=False)[0]


def test_same_pdf_changed_order_changes_layout_revision():
    blocks = [block('A', [30, 80, 280, 120]), block('B', [40, 90, 270, 110])]
    first = normalize(blocks, answer)
    def reverse(items):
        return answer(list(reversed(items)))
    second = normalize(blocks, reverse)
    assert first['layout']['source_revision'] == second['layout']['source_revision']
    assert first['layout']['layout_revision'] != second['layout']['layout_revision']


def test_marker_layout_keeps_roles_and_coordinates():
    from types import SimpleNamespace as Node
    from services.pdf_parser import _marker_layout_blocks
    leaf = lambda kind, html, box: Node(block_type=kind, html=html, bbox=box, children=[])
    tree = Node(bbox=[0, 0, 1200, 1600], children=[
        leaf('PageHeader', '<p>Header</p>', [20, 10, 300, 40]),
        Node(block_type='TableGroup', children=[
            leaf('Table', '<table><tr><td>Cell</td></tr></table>', [40, 400, 500, 600]),
            leaf('Caption', '<p>Table 1</p>', [40, 610, 500, 650]),
        ]),
        leaf('Footnote', '<p>Note</p>', [40, 1500, 500, 1540]),
    ])
    blocks = _marker_layout_blocks(tree)
    assert [b['role'] for b in blocks] == ['header', 'table', 'caption', 'footnote']
    assert blocks[1]['group_id'] == blocks[2]['group_id']
    assert blocks[1]['bbox'][1] == 250
