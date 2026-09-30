# Easy English

Easy English rewrites English source sentence structures without translating or
summarizing the document. The source language override takes precedence over
language detection. Non-English and unresolved sources are blocked before an AI
request. Set the document's source language to English to correct detection.

## Reader and settings

Each page offers Translation, Easy English, Keywords, and Summary tabs. Easy
English defaults to **On button click** in both research and general modes.
**Automatically for the current page** generates only the active document's
current page, independently of translation settings. Opening the tab in manual
mode only reads the cache. Reopening a result costs no additional generation.

A source sentence should remain one simplified sentence when possible. A complex
sentence can become several short sentences, but those sentences remain one
source-owned group. Hover either side to highlight its match; click or press
Enter on a result to reveal the original. The source-pairs disclosure remains
available when exact PDF geometry or text matching cannot be resolved. Source
highlights are clipped to the viewport and source scroll containers.

## API and integrity

- `GET /api/easy-english/{session_id}/{page_num}` only reads a saved result;
  missing results return 404.
- `POST /api/easy-english/{session_id}/{page_num}` accepts
  `{ "regenerate": false }` and streams generation status followed by the
  validated result over SSE. Failure is a terminal `error` event.
- Each result has `text`, `sentences`, `page_num`, `content_revision`, `warnings`,
  and `cached`. Each sentence group has `source_sentence_id`, `source_text`,
  `easy_sentences`, `paragraph`, and optional `source_mapping` geometry.
- IDs, order, group count, nonempty outputs, numbers with signs, recognized scientific units, citations and math literals
  are validated. There is no approximate alignment fallback. Unvalidated model
  output is not shown as a completed result or saved.
- The translation provider/model is reused with a separate prompt and CLI
  conversation. Existing ownership, classification, rate and local-only policy
  checks apply. Calls use the `easy_english` usage label.
- Results live under the document's `easy_english/results` directory. Keys include
  the source page, revision, language, model/provider and prompt version.
  Regeneration replaces a result atomically after validation. Failure preserves
  the old result. Reparse clears results; document deletion removes the directory
  and the external Antigravity conversation and brain data for the separate CLI session.
  Validator changes invalidate older result caches through the prompt version.

## Quality evaluation

Structural checks cannot prove semantic equivalence. Automated tests use mocked
AI responses; real-model output needs a human content review before assessing
linguistic quality for a chosen model.

Use representative English passages covering nested relative clauses, passive
voice, conditionals, negation, technical terminology, uncertainty, citations,
quantities, formulas, and already-simple sentences. Check that each source ID
has one group, information is neither added nor dropped, the claim strength and
conditions remain unchanged, and splitting is used only when needed. Compare
PDF/web rendering and both directions of sentence highlighting as well.
