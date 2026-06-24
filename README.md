# ⚗️ EasyPaper

EasyPaper는 학술 PDF 논문을 AI로 번역하고 논문 내용을 기반으로 대화할 수 있는 통합 웹 서비스입니다. 
논문을 업로드하면 원문 옆에 AI 번역본이 함께 표시되며, 궁금한 내용을 바로 질문할 수 있습니다. 

본 서비스의 번역 및 어시스턴트 모델로는 로컬 Ollama 모델, 외부 API(Gemini, Claude, OpenAI), antigravity를 지원합니다.

---

## ⚡ 빠른 시작

명령어 세 줄로 바로 실행이 가능합니다.

```bash
# 1. 저장소 클론
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper

# 2. 설치 스크립트 실행
# (Python 가상환경 생성, 의존성 패키지 설치, .env 파일 생성, 프론트엔드 빌드 포함)
./setup.sh

# 3. 서버 시작
./start.sh
```

서버 구동 후 브라우저에서 `http://localhost:8000` 에 접속합니다.

---

## 🚀 주요 기능

1. **내 라이브러리** — 라이브러리 화면에 PDF를 드래그 앤 드롭하여 바로 업로드할 수 있으며, 업로드 완료 즉시 백그라운드 번역이 시작됩니다.
2. **AI 카테고리 자동 태깅** — 업로드 후 AI가 논문 초록과 본문을 분석하여 카테고리 태그(예: `VLM`, `VLA`, `GAN`, `CNN`,`Optimizer` 등)를 자동으로 부여합니다.
3. **듀얼 패널 뷰어** — 원본 PDF와 AI 번역 결과를 나란히 보며 읽을 수 있고, 패널 너비를 자유롭게 조절할 수 있습니다.
4. **AI 채팅 어시스턴트** — 논문 내용을 바탕으로 질문하거나, 핵심 결과·수식 등을 자연어로 물어볼 수 있습니다.
5. **통합 모델 선택기** — UI 안에서 제공업체와 AI 모델(Ollama, Gemini, Claude, OpenAI)을 즉시 전환할 수 있습니다.

---

## 🛠️ 필수 요구사항

- **Python 3.8+**
- **Node.js 16+** & **npm**
- **Ollama** *(선택 사항 — 로컬 모델을 직접 실행하려는 경우에만 필요)*

---

## ⚙️ 수동 설치 방법

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
npm run build  # 프로덕션 빌드 — 백엔드가 정적 파일로 서빙
# 또는
npm run dev    # 개발 서버 시작 (http://localhost:5173)
```

---

## 🔐 초기 로그인 계정

| 항목 | 값 |
|------|-----|
| 아이디 | `admin` |
| 비밀번호 | `admin` |

로그인 후 화면 우측 상단의 ⚙️ 설정 아이콘을 눌러 언제든지 아이디와 비밀번호를 변경할 수 있습니다. 변경된 정보는 해시 처리되어 `backend/.env`에 안전하게 저장됩니다.

---

## ☁️ 상시 구동 — systemd 서비스 등록 (선택 사항)

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

## ⚡ Antigravity CLI (`agy`) 연동 가이드

EasyPaper 백엔드에는 Google Antigravity CLI(`agy`)를 서브프로세스로 호출하여 번역, 논문 태깅, 채팅을 처리하는 전용 `antigravity` LLM Provider 엔진이 포함되어 있습니다.

`antigravity`를 사용하여 더 나은 번역과 질문 응답을 받아보려면 아래 단계를 완료하세요:

### 1. `agy` CLI 설치 확인

서버에 `agy` 실행 파일이 설치되어 있어야 합니다.

- EasyPaper는 기본적으로 `/home/ubuntu/.local/bin/agy` 경로를 먼저 확인합니다.
- 해당 경로에 없으면 시스템 `PATH`에서 `agy`를 찾아 실행합니다.

> 다른 경로에 설치한 경우, 해당 경로가 `PATH` 환경 변수에 등록되어 있는지 확인하세요.

### 2. Google 계정 인증

`agy` CLI는 EasyPaper 서버를 실행하는 OS 사용자 계정(예: `ubuntu`)에서 미리 인증이 완료되어 있어야 합니다.

```bash
# agy를 한 번 실행하여 OAuth 인증을 시작합니다
agy
```

최초 실행 시 Google OAuth 로그인 URL이 출력됩니다. 브라우저에서 해당 URL로 로그인한 뒤, 발급된 인증 코드를 터미널에 붙여넣으면 인증이 완료됩니다. 이후 정상 동작 여부를 확인합니다:

```bash
/home/ubuntu/.local/bin/agy --help
```

### 3. 자동 실행 권한 설정

EasyPaper는 백그라운드 번역 작업을 중단 없이 실행하기 위해 `agy --dangerously-skip-permissions` 플래그를 사용합니다. 이 플래그는 대화형 권한 확인 프롬프트를 건너뛰고 자동으로 승인합니다.

서버 실행 사용자가 `agy` 바이너리를 실행할 수 있는 권한을 가지고 있으며, `~/.gemini/antigravity-cli/settings.json`에 정의된 워크스페이스 디렉토리에 접근 가능한지 확인하세요.

> **Antigravity를 사용하지 않는 경우:** `.env` 파일에서 `TRANS_PROVIDER`와 `CHAT_PROVIDER`를 `ollama`로 설정하거나, Gemini·OpenAI·Claude API 키를 등록하여 사용하세요.



