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
retain appendix citations, deduplicate text, and sample at most 12 excerpts (up to
600 characters on either side of each marker). Recognized headings assign contexts
to introduction/background, methods/training, results/experiments, discussion/conclusion,
or appendix. Sampling reserves a slot for each represented section, then distributes
remaining slots across sections and positions. Unrecognized sections use a distributed
fallback. Returned evidence includes the detected `section`.

Bibliography boundaries use the reference-list parser's header validation, including
first entries on the same line as the header. A normal sentence starting with
"References to ..." remains body text. Analysis version 2 invalidates older cached
results so incorrect scores and missing-evidence results are recomputed on demand.

The model receives an explicit citation-key-to-reference mapping. The scoring rubric
assigns no method dependency points to background-only mentions; high method scores require evidence
of an actual implementation or reproduction dependency. Section labels alone do
not establish dependency. A citation supporting criticism of another architecture
can be supporting evidence without implying that the cited paper itself is rejected.
The server rejects positive method scores without a method or data/tool role rather
than caching an internally inconsistent result. A validation failure triggers at most
one corrective model call with the failure reason and the same target/evidence. If it
still fails, the existing retry UI handles the error. Transport failures are not
retried automatically, and both attempts share the existing overall timeout.

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

### Optional live model check

Download the public [Attention Is All You Need v7 PDF](https://arxiv.org/pdf/1706.03762v7)
locally, then run with the backend Python environment:

```sh
python backend/scripts/evaluate_reference_analysis.py --pdf /path/to/attention.pdf --output /tmp/reference-evaluation.json
```

This explicitly calls the configured chat provider (not mocks), using references
[20] (method dependency), [22] (background), and [12] (support for a limitations argument).
It checks response validity, expected roles, background method-dependency points,
and relative reading priority without fixing exact total scores. Inspect the generated
reasons and evidence against the PDF as well: this is a small quality sample, not a
general accuracy metric. Use `--case critique_support` (or `method`, `background`)
to repeat a single case. The script is opt-in and is not run by CI. It does not
download or import papers, change provider settings, or write analysis caches.

### Live smoke-check record (2026-10-19)

Iterative checks used local Ollama `gemma4:e4b`, Korean output, and the public v7 PDF
linked above. Observed results after the relevant corrections:

| Reference | Expected use | Score | Method component | Returned roles |
| --- | --- | --- | --- | --- |
| [20] | Adopted optimizer | 62 | 31 | method |
| [22] | Related-work example | 40 | 0 | background, support |
| [12] | Support for a long-range-dependency limitation | 41 | 0 | support, background |

The first two observations preceded the final role-definition refinement; [12] was
then rechecked separately with the final prompt and bounded repair enabled. Its
strict evaluator reported zero issues. Source inspection confirmed the distinction
between an adopted technique, an illustrative prior example, and a citation supporting
a limitations argument. This is not a simultaneous benchmark or a fixed-score test.

Earlier iterations exposed missing target-key mapping, excessive method points for
background/support citations, and confusion between a comparison target and evidence
supporting comparison of other works. These motivated the explicit mapping, scoring
rubric, role definitions, consistency validation, and one-attempt repair. The automated
regression tests cover these contracts and reject invalid evidence after repair.

Only one paper and one model were sampled. Score calibration, semantic correctness
on other papers, and cross-provider consistency remain model-dependent and require
broader evaluation; these smoke checks do not establish a general accuracy rate.
