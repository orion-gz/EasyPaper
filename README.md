<div align="center">

<img src="./frontend/public/icon-192.png" width="88" height="88" alt="EasyPaper icon"><br>

# EasyPaper

AI-assisted reading and translation for research papers and general documents.

[한국어 README](./README.ko.md)

[![Release](https://img.shields.io/github/v/release/orion-gz/EasyPaper?display_name=tag&label=release&color=4f7cff)](https://github.com/orion-gz/EasyPaper/releases/latest)
[![Last commit](https://img.shields.io/github/last-commit/orion-gz/EasyPaper?label=last%20commit)](https://github.com/orion-gz/EasyPaper/commits/main)
[![Stars](https://img.shields.io/github/stars/orion-gz/EasyPaper?label=stars)](https://github.com/orion-gz/EasyPaper/stargazers)
[![Issues](https://img.shields.io/github/issues/orion-gz/EasyPaper?label=issues)](https://github.com/orion-gz/EasyPaper/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-4f7cff)](https://github.com/orion-gz/EasyPaper/pulls)

[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white)](backend/requirements.txt)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](backend/requirements.txt)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](frontend/package.json)
[![SQLite](https://img.shields.io/badge/SQLite-DB-003B57?logo=sqlite&logoColor=white)](backend/services/db.py)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#quick-start)

</div>

EasyPaper is a web and desktop workspace for translating, reading, annotating, and discussing PDFs with AI. Use local Ollama, Gemini, Claude, OpenAI, or supported CLI providers including Antigravity, Claude Code, and Codex.

<p align="center">
  <img src="./image/dashboard_research_mode.png" alt="EasyPaper research mode dashboard" width="100%">
  <sub>Research mode workspace</sub>
</p>

## Two reading modes

| Mode | For | What it emphasizes |
|---|---|---|
| Research mode | Papers, surveys, theses, preprints, and academic reports | Paper structure, methods, evidence, citations, research graphs, comparisons, and pre-reading briefs |
| General document mode | Technical documentation, books, articles, reports, manuals, policies, presentations, and other general documents | Document-aware translation, summaries, vocabulary, focused Q&A, full-text search, and document overviews |

Both modes currently accept PDF files. General document mode lets you work with PDF exports of documents such as DOCX files while preserving the purpose and structure appropriate to the selected document type.

<details>
<summary>More screenshots</summary>

<br>

| | |
|---|---|
| <img src="./image/dashboard_research_mode.png" alt="Research mode dashboard"> | <img src="./image/dashboard_doc_mode.png" alt="General document mode dashboard"> |
| Research mode dashboard | General document mode dashboard |
| <img src="./image/viewer_ai_assistant.png" alt="Viewer with AI assistant"> | <img src="./image/viewer_image_overlay.png" alt="Viewer image overlay"> |
| Viewer and AI assistant | Figure and image reference overlay |
| <img src="./image/viewer_memo.png" alt="Viewer memo"> | <img src="./image/viewer_ref_overlay.png" alt="Viewer reference overlay"> |
| Annotations and floating memos | Citation reference overlay |
| <img src="./image/library.png" alt="Document library"> | <img src="./image/ai_chats.png" alt="AI Chats"> |
| Library | AI Chats |
| <img src="./image/heatmap.png" alt="Research graph heatmap"> | <img src="./image/reading_history.png" alt="Reading history"> |
| Research graph heatmap | Reading history |

</details>

## Features

- Side-by-side source and AI translation with sentence-level alignment
- Context-aware AI chat, pre-reading briefs, summaries, and vocabulary support
- Research workspace with library, AI Chats, research graph, reading analytics, and recommendations
- Annotations, highlights, floating memos, and annotated PDF export
- Reference, figure, table, and equation overlays for research PDFs
- Native desktop apps for Windows, macOS, and Linux, plus a self-hosted web app

## Quick start

### Desktop app

Download the installer for your platform from the [latest release](https://github.com/orion-gz/EasyPaper/releases/latest). The Tauri desktop app includes the backend sidecar, so Python and Node.js are not required.

| OS | Installer |
|---|---|
| Windows | `.msi` or `.exe` |
| macOS (Apple Silicon) | `_aarch64.dmg` |
| Linux | `.AppImage`, `.deb`, or `.rpm` |

At first launch, choose and configure an AI provider in the onboarding flow. Unsigned desktop builds can trigger an operating-system security warning.

### Run from source

Requirements: Python 3.8+, Node.js 16+, and npm. Ollama is optional.

```bash
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
./scripts/sh/setup.sh
./scripts/sh/start.sh
```

On Windows, run `scripts\bat\setup.bat`, then `scripts\bat\start.bat`. Open `http://localhost:8000` after the server starts.

## Docker

```bash
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
docker compose up -d --build
```

Open `http://localhost:8000`. Data is persisted in the `/data` volume. To stop the service, run `docker compose down`.

## Initial account

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `admin` |

Change these credentials in Settings after signing in.

## Testing

```bash
cd backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -v
```

```bash
cd frontend
npm install
npm run build
npm run test:e2e
```

## CLI providers

EasyPaper detects installed and authenticated `agy`, `claude`, and `codex` CLIs at startup. Select any detected provider from the model picker; API providers and Ollama remain available as alternatives.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.
