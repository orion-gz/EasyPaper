# PDF text recovery

Some PDFs contain visible glyphs but no Unicode mapping. Interpreting their CID
numbers as Unicode can produce plausible Greek, Arabic, or other unrelated text.
EasyPaper checks extraction with `TEXT_CID_FOR_UNKNOWN_UNICODE` disabled and uses
local Tesseract OCR for pages with substantial unmapped text. The original PDF is
not modified or uploaded to an OCR service. Translation and the selectable viewer
layer share the recovered text and its page coordinates.

Docker includes Tesseract language models. For native installations:

- Debian/Ubuntu: `sudo apt-get install tesseract-ocr tesseract-ocr-all`
- macOS: `brew install tesseract tesseract-lang`
- Windows: install Tesseract, add its executable directory to PATH, and install
  the source language's traineddata files in its tessdata directory.

`TESSDATA_PREFIX` may point to the tessdata directory. By default, script detection
selects from installed models, with English for mixed technical terms. Set
`EASYPAPER_OCR_LANGUAGES=jpn+eng` (or any installed Tesseract language codes) to
override that selection. Restart the backend and reparse documents after changing
models or this setting. Missing models are reported as recovery failures; damaged
glyph IDs are never used as translation input.

OCR is approximate and slower than native extraction. Verify commands, numbers,
and small text against the original page. Normal Unicode PDFs retain native text
and do not need OCR. PDF.js CMaps, fallback fonts, and WASM resources are bundled
locally for development, production, and desktop rendering.

To exercise the original 250-page Japanese textbook without redistributing it:

```sh
EASYPAPER_TEST_JAPANESE_PDF=/path/to/Linux標準教科書_ver3.0.2.pdf \
  python -m pytest backend/tests/test_pdf_text_recovery.py
```
