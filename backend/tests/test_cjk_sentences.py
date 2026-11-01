import pytest

from services.chunker import split_into_sentences, tag_source_text, parse_tagged_translation


@pytest.mark.parametrize('text,expected', [
    ('First sentence. lowercase follows.', ['First sentence.', 'lowercase follows.']),
    ('Done. (Next sentence.) Last.', ['Done.', '(Next sentence.)', 'Last.']),
    ('He said "Done." Next.', ['He said "Done."', 'Next.']),
    ('첫 문장입니다.다음 문장입니다.', ['첫 문장입니다.', '다음 문장입니다.']),
    ('Done.Next sentence.', ['Done.', 'Next sentence.']),
    ('Count is 3. 2024 was next.', ['Count is 3.', '2024 was next.']),
    ('Use e.g. apples and pears. Next.', ['Use e.g. apples and pears.', 'Next.']),
    ('See Fig. 2 and Eq. 3. Next.', ['See Fig. 2 and Eq. 3.', 'Next.']),
    ('Use apples etc. Next.', ['Use apples etc.', 'Next.']),
    ('See example.com for version 3.14. Next.', ['See example.com for version 3.14.', 'Next.']),
    ('1. Introduction\nFirst sentence. Second.', ['1. Introduction\nFirst sentence.', 'Second.']),
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


def test_untagged_translation_never_merges_source_sentences():
    sources = ['First.', 'Second.', 'Third.']
    _, pairs = parse_tagged_translation('하나로 합쳐진 번역입니다.', sources)
    assert [pair['src'] for pair in pairs] == sources
    assert all(pair['trans'] for pair in pairs)
