# Reference reading-priority analysis

Open a citation preview and select **Analyze reading priority**. The card shows a
0–100 reading-priority score, its rationale, citation roles and reasons, and source
excerpts with page navigation. This estimates usefulness for understanding the
current document; it does not rate the cited paper's quality.

The score sums method/reproduction dependency (0–40), core-argument understanding
(0–40), and background benefit (0–20). Citation count does not add points.

**Automatically analyze references** in the mode-specific automation settings is
off by default. When enabled, an open preview waits 500 ms before analyzing its
uncached references sequentially. Closing it cancels pending work; an already
started server analysis may finish and populate the cache. Saved results appear
in either mode. **Analyze again** refreshes an existing result.

## Evidence and limitations

Only the current PDF's citation contexts and section excerpts are sent to the
configured chat provider/model, using a fresh call without reader chat history.
No cited-paper abstract or full text is fetched. Contexts exclude the bibliography,
retain appendix citations, deduplicate text, and sample at most 12 excerpts across
the document (up to 600 characters on either side of each marker).

The model selects evidence IDs; the server supplies their original text and page
numbers. Missing contexts, ambiguous same-author/year references, or insufficient
model evidence produce no score. Grouped citations require qualified attribution.
Extraction limitations and model judgment can affect the estimate.

## API and persistence

- `GET /api/library/{doc_id}/references/{ref_key}/analysis?target_lang=ko`
  returns saved analysis or `{"status":"not_analyzed"}` without generating it.
- `POST` to the same path accepts `{"target_lang":"ko","force":false}`.
  It reuses cached analysis unless forced, and coalesces concurrent requests.
- Results contain `status`, nullable `score`, `method_score`,
  `understanding_score`, `background_score`, `score_reason`, `citation_reason`,
  `roles`, `evidence`, `ref_key`, `target_lang`, and `analyzed_at`.
- Roles: `background`, `method`, `comparison`, `support`, `critique`, `data_tool`.
- Both endpoints require document ownership. POST returns 404 for missing PDF or
  reference, 409 for a document changed during analysis, 502 for generation or
  validation failure, and 504 on timeout. Invalid languages return 422.

The existing `page_insights` store holds results under `reference_analysis`.
Document content revision, reference key, output language, provider/model and
analysis version isolate cache entries. Failed regeneration preserves a previous
valid result. No database migration or new provider credentials are required.

## Verification

Backend tests cover extraction formats, bibliography exclusion, ambiguity, evidence
validation, cache invalidation, ownership, concurrency and failure recovery.
Frontend unit and Chromium tests cover manual/automatic operation, stale results,
sequential requests, retry, cached reopening, keyboard dismissal and page links.
Model outputs are mocked in automated tests; qualitative scoring requires checking
representative papers with the configured provider.
