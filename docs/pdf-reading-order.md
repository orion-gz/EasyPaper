# PDF reading order and source mapping

New PDF uploads pass all four parsers through `services/pdf_layout.py`. Existing
cached documents keep their order. Use the library's reparse preview and Apply
controls to opt an existing document into the new layout. Applying a preview
uses the existing content-revision transaction: translations, sentence mappings,
page insights and summaries from the previous revision are no longer current;
annotations, memos and chat history remain stored.

The common stage reconciles parser blocks against native character geometry or
OCR geometry. It separates disconnected columns, cuts regions around spanning
headings, and orders columns according to writing direction. Marker structure,
MinerU roles, detected tables/equations, repeated margins and footnotes provide
additional evidence. Objects and captions follow the body. Original parser text
and blocks remain available as `original_text` and `original_blocks`.

Each block carries an ID, source geometry, role, region/group, writing direction,
reading order and mapping status. `layout` records the rules version, source PDF
fingerprint, analysis method/model, layout revision and review reasons. The
existing `text` and `blocks` fields remain supported. Coordinates are unrotated
visible-page top-left PDF points; character offsets use Python Unicode indices.

Only ambiguous pages invoke the configured **analysis** provider/model. The
OpenAI, Gemini and Claude adapters receive the page image and existing block
metadata/text. Other providers skip this step. A request has a 60-second timeout;
unsupported image models, malformed JSON, missing/duplicate/unknown IDs,
interleaved groups and detached captions are rejected. Validated answers are
cached under the PDF fingerprint, page input, rules version, provider and model.
An unsuccessful analysis retains parser order and text and displays **Reading
order needs review**. AI cannot repair missing source character coordinates.

Interactive and batch translations attach `source_mapping` to each sentence.
Only proven character ranges receive rectangles; one sentence may reference
multiple blocks. The viewer prioritizes these coordinates and checks the layout
revision. Unresolved mappings produce no guessed highlight. Documents without
this metadata retain the legacy text-matching path.

This is conservative layout analysis, not a guarantee for every PDF. Vertical
column progression, overlapping regions and mixed directions may still require
image analysis or manual review. OCR availability and installed language models
remain prerequisites for scanned/unmapped text. The tests use generated PDFs and
mock model responses; they do not evaluate the accuracy of a live vision model
or install/run the full Marker and MinerU model stacks.
