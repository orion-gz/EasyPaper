<div align="center">

<img src="./frontend/public/icon-192.png" width="88" height="88" alt="EasyPaper 아이콘"><br>

# EasyPaper

**학술 PDF 논문을 AI로 번역하고, 논문 내용을 바탕으로 바로 대화하는 통합 서비스 — 웹 & 데스크톱 앱**

[![Last Commit](https://img.shields.io/github/last-commit/orion-gz/EasyPaper?color=4f7cff&label=last%20commit)](https://github.com/orion-gz/EasyPaper/commits/main)
[![Open Issues](https://img.shields.io/github/issues/orion-gz/EasyPaper?color=4f7cff)](https://github.com/orion-gz/EasyPaper/issues)
[![Stars](https://img.shields.io/github/stars/orion-gz/EasyPaper?color=4f7cff)](https://github.com/orion-gz/EasyPaper/stargazers)
[![Changelog](https://img.shields.io/badge/changelog-keep%20a%20changelog-4f7cff)](./CHANGELOG.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-4f7cff.svg)](https://github.com/orion-gz/EasyPaper/pulls)

[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white)](backend/requirements.txt)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](backend/requirements.txt)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](frontend/package.json)
[![SQLite](https://img.shields.io/badge/SQLite-DB-003B57?logo=sqlite&logoColor=white)](backend/services/db.py)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](./Dockerfile)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#-빠른-시작)

[![Download Desktop App](https://img.shields.io/github/v/release/orion-gz/EasyPaper?label=%E2%AC%87%EF%B8%8F%20Download%20Desktop%20App&color=4f7cff)](https://github.com/orion-gz/EasyPaper/releases/latest)

</div>

<br>

논문을 업로드하면 원문 옆에 AI 번역본이 나란히 표시되고, 궁금한 내용을 그 자리에서 바로 질문할 수 있습니다. 번역·어시스턴트 모델로는 로컬 Ollama, 외부 API(Gemini/Claude/OpenAI), CLI 기반 엔진(Antigravity/Claude Code/Codex)을 모두 지원합니다. Windows/macOS/Linux용 네이티브 데스크톱 앱과, 직접 구동하는 웹 앱 두 가지 방식으로 모두 사용할 수 있습니다.

<br>

<p align="center">
  <img src="./image/viewer1.webp" alt="EasyPaper 듀얼 패널 뷰어 + AI 어시스턴트" width="100%">
  <sub>원문 · 번역 · AI 채팅을 한 화면에서 — 수식·강조 서식까지 그대로 유지됩니다</sub>
</p>

<details>
<summary><b>스크린샷 더 보기</b> — 라이브러리, 논문 미리보기, 키워드 인사이트</summary>
<br>

<table>
<tr>
<td width="50%"><img src="./image/library1.webp" alt="내 라이브러리 화면"><br><sub align="center">카테고리 자동 태깅이 적용된 내 라이브러리</sub></td>
<td width="50%"><img src="./image/library2.webp" alt="논문 미리보기 팝업"><br><sub align="center">클릭 한 번으로 보는 논문 미리보기</sub></td>
</tr>
<tr>
<td width="50%"><img src="./image/viewer2.webp" alt="키워드·용어 인사이트 패널"><br><sub align="center">어려운 용어를 짚어주는 키워드·용어 패널</sub></td>
<td width="50%"><img src="./image/reference_overlay.png" alt="참고문헌 호버 오버레이"><br><sub align="center">인용 번호에 마우스를 올리면 원문 + 검색 링크가 바로 뜹니다</sub></td>
</tr>
</table>

</details>

<details>
<summary><b>참조 오버레이 미리보기</b> — Figure · Table · 수식 참조</summary>
<br>

<table>
<tr>
<td width="50%"><img src="./image/figure_overlay.png" alt="Figure 참조 호버 오버레이"><br><sub align="center">본문에서 그림 번호를 참조하면 해당 Figure를 바로 미리보기</sub></td>
<td width="50%"><img src="./image/table_overlay.png" alt="Table 참조 호버 오버레이"><br><sub align="center">Table 참조도 동일하게 원문 위치를 크롭해 보여줍니다</sub></td>
</tr>
<tr>
<td width="50%"><img src="./image/eq_overlay.png" alt="수식 참조 호버 오버레이"><br><sub align="center">수식 번호 참조 시 해당 수식만 정확히 크롭해 표시</sub></td>
<td width="50%" valign="middle" align="center"><i>클릭하면 원문의 해당 페이지로 바로 이동합니다</i></td>
</tr>
</table>

</details>

<br>

## 목차

- [빠른 시작](#-빠른-시작)
- [주요 기능](#-주요-기능)
- [필수 요구사항](#-필수-요구사항)
- [수동 설치 방법](#-수동-설치-방법)
- [초기 로그인 계정](#-초기-로그인-계정)
- [테스트](#-테스트)
- [데이터 백업 및 복원](#-데이터-백업-및-복원)
- [상시 구동 — systemd 서비스 등록](#-상시-구동--systemd-서비스-등록-선택-사항)
- [Docker로 실행하기](#-docker로-실행하기)
- [CLI 기반 AI 엔진](#-cli-기반-ai-엔진-antigravity--claude-code--codex)

---

<a id="-빠른-시작"></a>
## 🚀 빠른 시작

EasyPaper는 **① 설치 없이 바로 쓰는 네이티브 데스크톱 앱**과 **② 직접 구동하는 웹 앱**, 두 가지 방식 중 편한 쪽으로 사용할 수 있습니다.

### 1. 데스크톱 앱으로 설치하기 (권장)

Tauri 기반 네이티브 앱으로, Python/Node.js 설치 없이 바로 실행됩니다. 번역 엔진(FastAPI 백엔드)이 앱 안에 사이드카로 내장되어 있어 별도 서버 구동 과정이 필요 없습니다.

1. **[⬇️ 최신 릴리스 다운로드](https://github.com/orion-gz/EasyPaper/releases/latest)** 에서 운영체제에 맞는 설치 파일을 받습니다.

   | OS | 파일 |
   |---|---|
   | Windows | `.msi` / `.exe` |
   | macOS (Apple Silicon) | `_aarch64.dmg` |
   | Linux | `.AppImage` / `.deb` / `.rpm` |

   > macOS Intel(x64) 빌드는 GitHub Actions의 `macos-13` 러너 용량 문제로 현재 배포되지 않습니다. 추후 안정화되면 다시 추가될 예정입니다.

2. 설치 후 앱을 실행하면 첫 화면에서 AI 엔진(Ollama/Gemini/Claude/OpenAI/CLI) 온보딩 마법사가 안내합니다.
3. 이후 새 버전이 배포되면 앱이 자동으로 감지하여, 설정 화면의 버튼 한 번으로 업데이트를 내려받고 설치할 수 있습니다.

> ⚠️ 아직 macOS 공증(Notarization)·Windows Authenticode 코드사이닝을 적용하지 않아, 설치 시 운영체제 보안 경고가 뜹니다. 아래 안내를 따라주세요.
>
> **macOS**: 앱이 완전히 서명되지 않은 상태라 최신 macOS(Ventura 이후)에서는 우클릭 → 열기로 우회되지 않고 **"앱이 손상되었기 때문에 열 수 없습니다"** 라는 오해의 소지가 있는 메시지가 뜹니다. 실제로 파일이 손상된 게 아니라 다운로드 시 붙는 quarantine 속성 때문이니, 터미널에서 아래 명령으로 지운 뒤 다시 실행하세요.
> ```bash
> xattr -cr /Applications/EasyPaper.app
> ```
>
> **Windows**: "Windows의 PC 보호" 화면에서 **추가 정보 → 실행**을 선택하면 정상적으로 설치됩니다.

### 2. 소스에서 웹 앱으로 직접 실행하기

설치와 실행에 필요한 모든 스크립트는 `scripts/` 폴더에 모여 있습니다 — macOS·Linux용은 `scripts/sh/`, Windows용은 `scripts/bat/`에 있습니다.

**macOS / Linux**
```bash
# 1. 저장소 클론
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper

# 2. 설치 스크립트 실행
# (Python 가상환경 생성, 의존성 패키지 설치, .env 파일 생성, 프론트엔드 빌드 포함)
./scripts/sh/setup.sh

# 3. 서버 시작
./scripts/sh/start.sh
```

**Windows**

`scripts\bat\setup.bat` 파일을 더블클릭하거나(또는 명령 프롬프트에서 실행), 완료 후 `scripts\bat\start.bat`을 실행하면 됩니다.
```bat
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
scripts\bat\setup.bat
scripts\bat\start.bat
```

서버 구동 후 브라우저에서 `http://localhost:8000` 에 접속합니다.

설치 및 생성된 모든 가상 환경과 빌드 데이터, systemd 서비스(Linux)를 완전히 지우고 원복하려면 다음 삭제 스크립트를 실행합니다:
```bash
./scripts/sh/cleanup.sh      # macOS / Linux
scripts\bat\cleanup.bat      # Windows
```

> 💡 Docker로 바로 실행하고 싶다면 [Docker로 실행하기](#-docker로-실행하기) 섹션을 참고하세요.

---

<a id="-주요-기능"></a>
## ✨ 주요 기능

1. **내 라이브러리** — 라이브러리 화면에 PDF를 드래그 앤 드롭하여 바로 업로드할 수 있으며, 업로드 완료 즉시 백그라운드 번역이 시작됩니다. 카드형/리스트형 보기를 전환할 수 있고, 카테고리 필터로 원하는 논문만 모아볼 수 있습니다.
2. **AI 카테고리 자동 태깅** — 업로드 후 AI가 논문 초록과 본문을 분석하여 카테고리 태그(예: `VLM`, `VLA`, `GAN`, `CNN`,`Optimizer` 등)를 자동으로 부여합니다.
3. **정밀한 1:1 문장 매칭 & 스크롤 이동** — 원문 PDF 문장과 번역문 문장 간의 마우스 오버 하이라이트 및 클릭 시 반대편 패널 위치 자동 스크롤(양방향) 기능을 지원합니다. LLM 의미론적 태깅 정렬 방식(Semantic Tag Alignment)을 통해 정밀도 높은 문장 정렬을 제공합니다.
4. **듀얼 패널 뷰어** — 원본 PDF와 AI 번역 결과를 나란히 보며 읽을 수 있고, 패널 너비를 자유롭게 조절할 수 있습니다.
5. **AI 채팅 어시스턴트** — 논문 내용을 바탕으로 질문할 수 있으며, 답변 생성 대기 상태의 **선형 프로그레스 바(Linear Loader)**와 **현대적인 알약(Capsule) 디자인 UI**를 제공합니다. 여러 논문을 함께 선택해 비교 질문도 할 수 있습니다.
6. **인용·그림·표·수식 참조 오버레이** — 본문의 번호 인용, Figure/Table/수식 참조 어디에든 마우스를 올리면 원문에서 크롭한 미리보기가 바로 뜹니다. 인용은 참고문헌 원문과 함께 Semantic Scholar/Google Scholar 검색 링크도 함께 제공하고, 여러 서브패널로 나뉜 그림도 하나의 오버레이로 합쳐서 보여줍니다. 참조를 클릭하면 원문의 해당 페이지로 바로 이동하며, 설정에서 오버레이 표시 자체를 끌 수도 있습니다.
7. **라이브러리 전체 검색 & PDF 내보내기** — 파일명·제목·번역된 본문까지 가로지르는 통합 검색과, 번역·하이라이트·밑줄·메모가 그대로 포함된 PDF 내보내기를 지원합니다. 내보낸 PDF는 뷰어와 동일하게 원문·번역 페이지가 나란히 페어링되며, 번역이 길어져도 한 페이지 안에 맞도록 자동으로 축소됩니다.
8. **통합 모델 선택기** — UI 안에서 제공업체와 AI 모델(Ollama, Gemini, Claude, OpenAI, Antigravity, Claude Code, Codex)을 즉시 전환할 수 있습니다. 로컬에 Ollama가 설치되어 있지 않다면 설정 화면에서 원클릭으로 바로 설치할 수 있습니다.
9. **자유 배치 Floating 메모** — 논문 본문 및 번역문 위에 메모를 자유롭게 배치하여 기록할 수 있습니다. 실시간 Markdown & LaTeX 수식 렌더링, 5색 테마 컬러 피커, 커스텀 삭제 대화상자를 지원합니다.
10. **테마 색상 커스터마이징** — 설정 화면에서 프리셋 컬러 또는 컬러 피커로 서비스 전체의 강조 색상을 자유롭게 바꿀 수 있으며, 미니멀하고 절제된 다크/라이트 테마를 기본으로 제공합니다.
11. **네이티브 데스크톱 앱 (Windows/macOS/Linux)** — Tauri 기반 데스크톱 앱으로도 배포됩니다. FastAPI 백엔드가 사이드카로 앱에 내장되어 있어 별도 서버 구동 없이 바로 실행되며, 새 버전이 나오면 앱 내에서 자동으로 감지해 업데이트를 설치할 수 있습니다.

---

<a id="-필수-요구사항"></a>
## 📋 필수 요구사항

- **Python 3.8+**
- **Node.js 16+** & **npm**
- **Ollama** *(선택 사항 — 로컬 모델을 직접 실행하려는 경우에만 필요)*

---

<a id="-수동-설치-방법"></a>
## 🛠️ 수동 설치 방법

스크립트를 사용하지 않고 직접 환경을 구축하려는 경우:

### 백엔드
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```
- API 서버: `http://localhost:8000`
- API 문서 (Swagger): `http://localhost:8000/docs`

### 프론트엔드
```bash
cd frontend
npm install
npm run build # 프로덕션 빌드 — 백엔드가 정적 파일로 서빙
# 또는
npm run dev # 개발 서버 시작 (http://localhost:5173)
```

---

<a id="-초기-로그인-계정"></a>
## 🔑 초기 로그인 계정

| 항목 | 값 |
|------|-----|
| 아이디 | `admin` |
| 비밀번호 | `admin` |

로그인 후 화면 우측 상단의 설정 아이콘을 눌러 언제든지 아이디와 비밀번호를 변경할 수 있습니다. 변경된 정보는 해시 처리되어 `backend/.env`에 안전하게 저장됩니다.

---

<a id="-테스트"></a>
## 🧪 테스트

백엔드 테스트는 pytest로 작성되어 있으며, 실제 프로젝트 데이터(DB/업로드/라이브러리)는 건드리지 않고 임시 디렉터리에서 격리 실행됩니다.

```bash
cd backend
.venv/bin/pip install -r requirements-dev.txt   # 최초 1회
.venv/bin/python -m pytest tests/ -v
```

프론트엔드 E2E 테스트는 Playwright로 작성되어 있으며, 실제 백엔드 없이 `/api/**` 응답을 목(mock)으로 대체해 빌드된 `dist/`를 대상으로 실행됩니다.

```bash
cd frontend
npm install                # 최초 1회
npm run build               # dist/ 생성
npx playwright install chromium   # 최초 1회, 브라우저 바이너리 설치
npm run test:e2e
```

---

<a id="-데이터-백업-및-복원"></a>
## 💾 데이터 백업 및 복원

DB(`easypaper.db`) + 논문 라이브러리(`library/`) + 업로드 원본(`uploads/`)을 타임스탬프가 찍힌 압축 파일로 `backups/`에 저장합니다. 재생성 가능한 `cache/`는 백업 대상에서 제외됩니다. 기본적으로 최신 10개만 보관하고 오래된 백업은 자동으로 정리됩니다(`EASYPAPER_BACKUP_KEEP` 환경변수로 조절 가능).

**macOS / Linux**
```bash
./scripts/sh/backup.sh
./scripts/sh/restore.sh backups/easypaper_backup_20260101_120000.tar.gz
```

**Windows**
```bat
scripts\bat\backup.bat
scripts\bat\restore.bat backups\easypaper_backup_20260101_120000.zip
```

주기적으로 자동 백업하려면 `backup.sh`/`backup.bat`을 각 OS의 스케줄러(Linux/macOS는 `cron`, Windows는 작업 스케줄러)에 등록하세요.

---

<a id="-상시-구동--systemd-서비스-등록-선택-사항"></a>
## 🖥️ 상시 구동 — systemd 서비스 등록 (선택 사항)

Linux 서버에서 EasyPaper를 백그라운드 데몬으로 상시 실행하려면 제공된 `easypaper.service` 파일을 활용하세요.

**1. 서비스 파일 편집** — `easypaper.service`를 열어 경로(예: `/home/ubuntu/...`)와 `User=` 값을 실제 서버 환경에 맞게 수정합니다.

**2. 서비스 등록 및 시작:**
```bash
sudo cp easypaper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable easypaper
sudo systemctl start easypaper
```

**3. 로그 확인:**
```bash
sudo journalctl -u easypaper -f
```

---

<a id="-docker로-실행하기"></a>
## 🐳 Docker로 실행하기

Python/Node.js를 직접 설치하지 않고 Docker만으로 실행할 수도 있습니다. 프론트엔드 빌드와 백엔드 실행이 하나의 이미지에 담겨 있으며, 문서 DB·업로드·라이브러리·설정 값은 모두 `/data` 볼륨에 영속화되어 컨테이너를 재생성해도 유지됩니다.

```bash
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper
docker compose up -d --build
```

서버 구동 후 브라우저에서 `http://localhost:8000`에 접속합니다. 초기 로그인 계정은 위의 `admin` / `admin`과 동일합니다.

기본값은 호스트에 설치된 Ollama(`http://host.docker.internal:11434`)를 바라봅니다. Gemini/Claude/OpenAI API를 쓰려면 로그인 후 설정 화면에서 API 키를 입력하면 됩니다(볼륨에 저장되어 유지됨). `docker-compose.yml`의 `environment`에 직접 `GEMINI_API_KEY` 등을 추가해도 됩니다.

### Docker 안에서 CLI 기반 엔진(Antigravity/Claude Code/Codex) 쓰기

이미지에는 세 CLI가 모두 미리 설치되어 있지만, 로그인(OAuth) 자격증명은 이미지에 절대 포함되지 않습니다. 대신 컨테이너가 호스트의 로그인 정보를 볼륨으로 그대로 재사용합니다(`docker-compose.yml`에 이미 설정되어 있음). 그래서 **먼저 호스트(컨테이너 밖)에서 CLI를 정상적으로 설치하고 로그인**해야 합니다:

```bash
# 예: Claude Code
npm install -g @anthropic-ai/claude-code
claude auth login
```

(또는 EasyPaper를 네이티브로 한 번 실행해서 설정 화면의 "설치" 버튼으로 설치·로그인해도 됩니다.) 로그인이 끝난 뒤 `docker compose up -d`로 컨테이너를 (재)시작하면, 호스트에서 완료한 로그인이 컨테이너 안으로 그대로 반영되어 별도 설정 없이 바로 사용할 수 있습니다. 호스트에 설치/로그인하지 않은 CLI는 그냥 "미설치" 상태로 표시될 뿐이라 안전합니다.

> Claude Code가 컨테이너 안에서 `~/.claude.json 파일을 찾을 수 없습니다` 같은 백업 복원 안내를 한 번 출력할 수 있는데, 인증 자체에는 영향이 없습니다(무시해도 됩니다). 완전히 없애고 싶다면 `docker-compose.yml`에 `${HOME}/.claude.json:/root/.claude.json` 마운트를 추가하세요 — 단, 호스트에 그 파일이 실제로 존재할 때만 추가해야 합니다(존재하지 않는 파일 경로를 마운트하면 Docker가 그 자리에 빈 디렉터리를 만들어버려 이후 네이티브 설치가 깨질 수 있습니다).

**로그 확인**
```bash
docker compose logs -f
```

**중지 (데이터는 볼륨에 남아 유지됨)**
```bash
docker compose down
```

**데이터까지 완전히 삭제**
```bash
docker compose down -v
```

---

<a id="-cli-기반-ai-엔진-antigravity--claude-code--codex"></a>
## 🤖 CLI 기반 AI 엔진 (Antigravity / Claude Code / Codex)

EasyPaper는 Google Antigravity(`agy`), Anthropic Claude Code(`claude`), OpenAI Codex(`codex`) CLI를 서브프로세스로 연동하는 전용 LLM Provider를 내장하고 있습니다.

로컬 또는 서버 환경에 해당 CLI 프로그램이 설치되어 로그인까지 완료되어 있다면, EasyPaper가 기동 시 이를 자동으로 감지하여 라이브러리·뷰어의 모델 선택 드롭다운에 해당 공급자를 바로 활성화합니다. 별도의 추가 설정은 필요하지 않습니다.

> CLI 엔진을 사용하지 않는 경우: 설정 화면 또는 `.env`에서 Ollama, Gemini, OpenAI, Claude API 중 원하는 방식으로 자유롭게 사용할 수 있습니다.

---

<div align="center">
<sub>변경 이력은 <a href="./CHANGELOG.md">CHANGELOG.md</a>에서 확인할 수 있습니다.</sub>
</div>
