from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os
import logging

from logging_config import setup_logging
setup_logging()
logger = logging.getLogger(__name__)

from config import CORS_ORIGINS, UPLOAD_DIR, APP_HOST, APP_PORT
from routers import upload, translate, chat
from routers import library as library_router
from routers import jobs as jobs_router
from routers import auth as auth_router
from routers import agy as agy_router
from routers import insight as insight_router
from services.auth import get_current_user

limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])

app = FastAPI(
    title="EasyPaper API",
    description="PDF 논문 번역 서비스 (Gemma 4 E4B + Ollama)",
    version="1.0.0",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS 설정 (모든 오리진 허용 — NPM/리버스 프록시 환경)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 라우터 등록
app.include_router(auth_router.router, prefix="/api", tags=["Auth"])
app.include_router(upload.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Upload"])
app.include_router(translate.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Translate"])
app.include_router(chat.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Chat"])
app.include_router(library_router.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Library"])
app.include_router(jobs_router.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Jobs"])
app.include_router(agy_router.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["AGY"])
app.include_router(insight_router.router, prefix="/api", dependencies=[Depends(get_current_user)], tags=["Insight"])


@app.on_event("startup")
async def startup_event():
    """서버 시작 시 데이터베이스 초기화 및 라이브러리의 문서들을 세션으로 복원합니다."""
    from services.db import init_db
    from services.usage_tracker import init_usage_table
    init_db()
    init_usage_table()
    upload.restore_sessions_from_library()


@app.get("/api/pdf-file/{session_id}")
async def serve_pdf(session_id: str, username: str = Depends(get_current_user)):
    """PDF 파일을 직접 서빙합니다."""
    if not upload.ensure_session(session_id):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    pdf_path = upload.sessions[session_id]["pdf_path"]
    return FileResponse(pdf_path, media_type="application/pdf")


# 프론트엔드 정적 파일 서빙 (빌드된 dist 폴더)
#
# EASYPAPER_FRONTEND_DIST가 있으면 그 경로를 그대로 쓴다. PyInstaller onedir로
# 패키징된 sidecar에서는 main.py의 __file__이 <onedir>/_internal/main.py를
# 가리키게 되는데, PyInstaller가 datas 목적지로 "<onedir> 최상위 밖"(예:
# "../frontend/dist")을 허용하지 않아 dist를 onedir 최상위(main.py가 기존
# 상대경로로 찾는 위치)에 둘 수 없다. 대신 dist를 _internal/frontend/dist에
# 두고 이 env var로 실제 위치를 알려준다. 미설정 시(서버/Docker 배포)에는
# 기존과 동일하게 상대경로로 계산한다.
FRONTEND_DIST = os.getenv("EASYPAPER_FRONTEND_DIST") or os.path.join(os.path.dirname(__file__), "../frontend/dist")
if os.path.exists(FRONTEND_DIST):
    # /assets 등 정적 자산
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str = ""):
        """SPA 라우팅 — 모든 경로를 index.html로 폴백 (API 경로 제외, 루트 정적 파일은 직접 서빙)"""
        if full_path.startswith("api"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)

        if full_path:
            # os.path.join + isfile만으로는 "../"가 섞인 경로를 걸러내지 못해
            # dist 밖의 임의 파일을 읽어올 수 있다(Starlette가 대부분의 "../"
            # 케이스를 라우팅 단계에서 이미 정규화해주긴 하지만, 그 동작에만
            # 의존하지 않고 실제 해석된 절대경로가 dist 안에 있는지 명시적으로
            # 검증한다).
            dist_root = os.path.realpath(FRONTEND_DIST)
            file_path = os.path.realpath(os.path.join(FRONTEND_DIST, full_path))
            if file_path.startswith(dist_root + os.sep) and os.path.isfile(file_path):
                return FileResponse(file_path)

        index = os.path.join(FRONTEND_DIST, "index.html")
        return FileResponse(
            index,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
else:
    @app.get("/")
    async def root():
        return {"message": "EasyPaper API is running — 프론트엔드 빌드 필요 (npm run build)", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=APP_HOST, port=APP_PORT, reload=False)
