# ── Stage 1: 프론트엔드 빌드 ──
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src
RUN npm run build

# ── Stage 2: 백엔드 런타임 ──
FROM python:3.12-slim
WORKDIR /app/backend

# curl(agy 공식 설치 스크립트) + Node.js/npm(claude-code, codex 설치용).
# claude/codex/agy 바이너리 자체는 설치 후 독립 실행형 네이티브 바이너리라
# 런타임에 Node.js가 필요하지 않지만, npm install -g 설치 과정 자체에는
# 필요하다.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs tesseract-ocr tesseract-ocr-all \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# CLI 기반 AI 엔진(Antigravity/Claude Code/Codex) 설치. 실제 로그인
# 자격증명은 이미지에 절대 포함되지 않는다 - 컨테이너 실행 시 호스트의
# ~/.claude, ~/.codex, ~/.antigravitycli, ~/.gemini를 볼륨으로 그대로
# 마운트해, 호스트에서 이미 완료해둔 로그인을 그대로 재사용하는 방식이다
# (README 참고). 컨테이너는 root로 실행되므로 HOME=/root 기준 경로에
# 설치한다. claude/codex는 npm 전역 설치 시 이미 PATH에 있는
# /usr/local/bin에 설치되어 별도 경로 지정이 필요 없고, agy 설치 스크립트만
# $HOME/.local/bin을 쓰므로 그 경로만 PATH/AGY_PATH에 추가한다.
ENV HOME=/root \
    PATH="/root/.local/bin:${PATH}" \
    AGY_PATH=/root/.local/bin/agy
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && curl -fsSL https://antigravity.google/cli/install.sh | bash

# config.py는 .env/translation_prompt.txt를 항상 backend/(이 이미지에서는
# /app/backend) 기준 상대경로로 읽고 쓴다 - 심볼릭 링크로 /data 볼륨 안을
# 가리키게 해서, 설정 화면에서 바꾼 계정 정보나 번역 프롬프트 커스터마이징이
# 컨테이너를 재생성해도 사라지지 않고 남도록 한다.
RUN ln -sf /data/.env .env && ln -sf /data/translation_prompt.txt translation_prompt.txt

# 문서 DB/업로드/캐시/라이브러리를 컨테이너 밖에 영속화하기 위한 데이터 볼륨.
# services/db.py의 DB_PATH, config.py의 UPLOAD_DIR/CACHE_DIR/LIBRARY_DIR는
# 모두 이 환경변수를 우선 사용하도록 되어 있다 (미설정 시 네이티브 실행과
# 동일하게 backend/ 하위 상대경로로 폴백).
ENV DB_PATH=/data/easypaper.db \
    UPLOAD_DIR=/data/uploads \
    CACHE_DIR=/data/cache \
    LIBRARY_DIR=/data/library \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/', timeout=3)" || exit 1

CMD ["python", "main.py"]
