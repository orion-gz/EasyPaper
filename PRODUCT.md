# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual researchers and students reading research PDFs.

## Product Purpose

EasyPaper helps people translate, read, annotate, and discuss PDFs with AI. Research mode supports working through academic papers; general document mode also supports technical documentation, books, articles, reports, manuals, policies, and presentations.

## Positioning

EasyPaper combines sentence-aligned source and AI translation with document-grounded AI assistance and research-specific analysis of paper structure, methods, evidence, citations, figures, tables, and equations. The user confirmed both the aligned reading and research analysis workflows as core differentiators.

## Operating Context

- Users open PDF documents in a web app or desktop app and work through them using translation, reading tools, annotations, and document-aware AI conversations.
- Researchers can use a research workspace with a library, research graph, paper comparisons, reading analytics, and pre-reading briefs.
- Individuals can run EasyPaper locally. Teams can use a self-hosted shared server through Lab Mode; desktop users can also connect to a remote server and sync libraries.

## Capabilities and Constraints

- Both reading modes currently accept PDF files.
- AI options include local Ollama, API providers such as Gemini, Claude, and OpenAI, and supported CLI providers including Antigravity, Claude Code, and Codex CLI.
- The desktop app is built with Tauri for Windows, macOS, and Linux; the product also ships as a self-hosted web app.
- Desktop users can cache remote documents for offline reading. AI availability depends on the configured provider and connection.
- No additional binding product constraints were specified in the init interview.

## Brand Commitments

- Product name: EasyPaper.
- The repository includes the product icon at `frontend/public/icon.svg` and a workspace screenshot at `image/main.png`. No additional brand voice or identity constraints were confirmed.

## Evidence on Hand

- Product overview and feature claims: `README.md` and `README.en.md`.
- Workspace screenshot: `image/main.png`.
- Workflow and implementation references: `docs/`, including `docs/features/reference-analysis.md`, `docs/tab-workspace.md`, and the Lab Mode guides.
- No testimonials, customer endorsements, or comparative benchmarks were confirmed; future work must not invent them.

## Product Principles

- Keep AI assistance grounded in the document being read.
- Preserve the relationship between source text and its translation.
- Make research evidence and paper structure usable while reading.
- Let individuals and teams choose suitable AI providers and local or self-hosted operation.
