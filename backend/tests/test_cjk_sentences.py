import pytest

from services.chunker import split_into_sentences, tag_source_text, parse_tagged_translation


@pytest.mark.parametrize('text,expected', [
    ('最初です。次です。最後です。', ['最初です。', '次です。', '最後です。']),
    ('本当！？はい。', ['本当！？', 'はい。']),
    ('「最初です。」次です。', ['「最初です。」', '次です。']),
    ('第一句。第二句！第三句？', ['第一句。', '第二句！', '第三句？']),
    ('最初です。\n 次です。', ['最初です。', '次です。']),
    ('Version 3.0 is ready. Next sentence.', ['Version 3.0 is ready.', 'Next sentence.']),
    ('Dr. Smith works here. Next sentence.', ['Dr. Smith works here.', 'Next sentence.']),
])
def test_sentence_boundaries(text, expected):
    assert split_into_sentences(text) == expected


def test_new_translation_has_one_tag_per_japanese_sentence():
    tagged, sources = tag_source_text('最初です。次です。最後です。')
    assert sources == ['最初です。', '次です。', '最後です。']
    assert '[S0]' in tagged and '[S1]' in tagged and '[S2]' in tagged
    _, pairs = parse_tagged_translation('[S0] 첫 문장입니다. [S1] 다음 문장입니다. [S2] 마지막입니다.', sources)
    assert [p['src'] for p in pairs] == sources
    assert len(pairs) == 3
