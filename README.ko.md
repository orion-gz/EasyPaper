<div align="center">

<img src="./frontend/public/icon-192.png" width="88" height="88" alt="EasyPaper 아이콘"><br>

# EasyPaper

연구 논문과 일반 문서를 위한 AI 기반 번역·읽기 도구

[English README](./README.md)

[![Release](https://img.shields.io/github/v/release/orion-gz/EasyPaper?display_name=tag&label=release&color=4f7cff)](https://github.com/orion-gz/EasyPaper/releases/latest)
[![Last commit](https://img.shields.io/github/last-commit/orion-gz/EasyPaper?label=last%20commit)](https://github.com/orion-gz/EasyPaper/commits/main)
[![Stars](https://img.shields.io/github/stars/orion-gz/EasyPaper?label=stars)](https://github.com/orion-gz/EasyPaper/stargazers)
[![Issues](https://img.shields.io/github/issues/orion-gz/EasyPaper?label=issues)](https://github.com/orion-gz/EasyPaper/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-4f7cff)](https://github.com/orion-gz/EasyPaper/pulls)

</div>

EasyPaper는 PDF를 AI로 번역하고, 읽고, 주석을 남기고, 문서 내용을 바탕으로 대화할 수 있는 웹·데스크톱 워크스페이스입니다. 로컬 Ollama, Gemini, Claude, OpenAI와 Antigravity·Claude Code·Codex CLI를 지원합니다.

<p align="center">
  <img src="./image/dashboard_research_mode.png" alt="EasyPaper 연구 모드 대시보드" width="100%">
  <sub>연구 모드 워크스페이스</sub>
</p>

## 두 가지 읽기 모드

| 모드 | 대상 | 주요 기능 |
|---|---|---|
| 연구 모드 | 논문, 서베이, 학위 논문, 프리프린트, 학술 보고서 | 논문 구조·방법론·근거·인용 분석, 연구 그래프, 논문 비교, 읽기 전 브리핑 |
| 일반 문서 모드 | 기술 문서, 서적, 기사, 보고서, 매뉴얼, 정책 문서, 발표 자료 등 | 문서 유형별 번역, 요약, 어휘, 문서 중심 질의응답, 전문 검색, 문서 개요 |

현재 두 모드 모두 PDF를 입력으로 사용합니다. 일반 문서 모드에서는 DOCX 등으로 작성한 문서를 PDF로 내보낸 뒤에도 문서 목적과 유형에 맞는 기능을 활용할 수 있습니다.

<details>
<summary>추가 스크린샷</summary>

<br>

| | |
|---|---|
| <img src="./image/dashboard_research_mode.png" alt="연구 모드 대시보드"> | <img src="./image/dashboard_doc_mode.png" alt="일반 문서 모드 대시보드"> |
| 연구 모드 대시보드 | 일반 문서 모드 대시보드 |
| <img src="./image/viewer_ai_assistant.png" alt="AI 어시스턴트가 열린 뷰어"> | <img src="./image/viewer_image_overlay.png" alt="이미지 참조 오버레이"> |
| 뷰어와 AI 어시스턴트 | 그림·이미지 참조 오버레이 |
| <img src="./image/viewer_memo.png" alt="뷰어 메모"> | <img src="./image/viewer_ref_overlay.png" alt="참고문헌 오버레이"> |
| 주석과 플로팅 메모 | 인용 참고문헌 오버레이 |
| <img src="./image/library.png" alt="문서 라이브러리"> | <img src="./image/ai_chats.png" alt="AI Chats"> |
| 라이브러리 | AI Chats |
| <img src="./image/heatmap.png" alt="연구 그래프 히트맵"> | <img src="./image/reading_history.png" alt="읽기 이력"> |
| 연구 그래프 히트맵 | 읽기 이력 |

</details>

## 주요 기능

- 원문과 AI 번역문을 나란히 보는 문장 단위 정렬 뷰어
- 문서 맥락 기반 AI 채팅, 읽기 전 브리핑, 요약, 어휘 지원
- 라이브러리, AI Chats, 연구 그래프, 읽기 분석, 추천을 갖춘 연구 워크스페이스
- 하이라이트, 주석, 플로팅 메모, 주석 포함 PDF 내보내기
- 연구 PDF의 인용·그림·표·수식 참조 오버레이
- Windows, macOS, Linux용 네이티브 데스크톱 앱 및 자체 호스팅 웹 앱

## 빠른 시작

### 데스크톱 앱

[최신 릴리스](https://github.com/orion-gz/EasyPaper/releases/latest)에서 설치 파일을 받으세요. Tauri 기반 앱에는 백엔드 사이드카가 포함되어 있어 Python과 Node.js 설치가 필요하지 않습니다.

| OS | 설치 파일 |
|---|---|
| Windows | `.msi` 또는 `.exe` |
| macOS (Apple Silicon) | `_aarch64.dmg` |
| Linux | `.AppImage`, `.deb`, 또는 `.rpm` |

첫 실행 시 온보딩에서 AI 공급자를 선택하고 설정합니다. 서명되지 않은 데스크톱 빌드는 운영체제 보안 경고를 표시할 수 있습니다.

### 소스에서 실행

Python 3.8+, Node.js 16+, npm이 필요합니다. Ollama는 선택 사항입니다.

```bash
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
./scripts/sh/setup.sh
./scripts/sh/start.sh
```

Windows에서는 `scripts\bat\setup.bat`을 실행한 뒤 `scripts\bat\start.bat`을 실행하세요. 서버가 시작되면 `http://localhost:8000`에서 사용할 수 있습니다.

## Docker

```bash
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
docker compose up -d --build
```

서버는 `http://localhost:8000`에서 실행됩니다. 데이터는 `/data` 볼륨에 보존되며, 중지는 `docker compose down`으로 할 수 있습니다.

## 초기 계정

| 항목 | 값 |
|---|---|
| 아이디 | `admin` |
| 비밀번호 | `admin` |

로그인 후 설정에서 계정을 변경하세요.

## 테스트

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

## CLI 기반 AI 공급자

EasyPaper는 시작 시 설치·로그인된 `agy`, `claude`, `codex` CLI를 감지합니다. 감지된 공급자는 모델 선택기에서 바로 사용할 수 있으며 API 공급자와 Ollama도 함께 지원합니다.

변경 이력은 [CHANGELOG.md](./CHANGELOG.md)에서 확인할 수 있습니다.
