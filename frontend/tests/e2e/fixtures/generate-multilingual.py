"""Generate a small, original CJK PDF needing PDF.js's external CMaps."""
from pathlib import Path
import fitz

with fitz.open() as doc:
    page = doc.new_page(width=600, height=800)
    for y, font, text in [
        (100, "japan", "日本語の文章です。"),
        (150, "korea", "한국어 문장입니다."),
        (200, "china-s", "这是中文文本。"),
        (250, "china-t", "這是中文文本。"),
        (300, "helv", "English text with a standard font."),
        (350, "zadb", "ABCDEF"),
    ]:
        page.insert_text((72, y), text, fontname=font, fontsize=16)
    doc.save(Path(__file__).with_name("multilingual-native.pdf"), deflate=True)
