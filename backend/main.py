from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import os

from config import CORS_ORIGINS, UPLOAD_DIR
from routers import upload, translate, chat
from routers import library as library_router
from routers import jobs as jobs_router
from routers import auth as auth_router
from routers import agy as agy_router
from services.auth import get_current_user

app = FastAPI(
    title="EasyPaper API",
    description="PDF 논문 번역 서비스 (Gemma 4 E4B + Ollama)",
    version="1.0.0",
)

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
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "../frontend/dist")
if os.path.exists(FRONTEND_DIST):
    # /assets 등 정적 자산
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str = ""):
        """SPA 라우팅 — 모든 경로를 index.html로 폴백 (API 경로 제외)"""
        if full_path.startswith("api"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        index = os.path.join(FRONTEND_DIST, "index.html")
        return FileResponse(index)
else:
    @app.get("/")
    async def root():
        return {"message": "EasyPaper API is running — 프론트엔드 빌드 필요 (npm run build)", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
