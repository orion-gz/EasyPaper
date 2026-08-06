import sqlite3
import os
import json
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Tuple

# DB_PATH 환경변수가 있으면 그대로 쓰고(Docker 등에서 데이터 볼륨 경로로
# 지정), 없으면 기존과 동일하게 backend/의 부모 기준 경로를 그대로 쓴다.
DB_PATH = os.getenv("DB_PATH") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "easypaper.db")

def get_db():
    # busy_timeout: 번역 잡이 쓰기 커넥션을 잡고 있는 동안(db_save_translation)
    # 라이브러리 목록 등 읽기 커넥션이 "database is locked"로 즉시 실패하지
    # 않고 잠깐 대기하도록 한다. journal_mode는 커넥션 단위가 아니라 DB
    # 파일에 영속되는 설정이라 init_db()에서 한 번만 WAL로 전환해두면 된다.
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn

def init_db():
    """데이터베이스 테이블을 생성하고 기본 사용자를 설정합니다."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 1. users 테이블
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """)
        
        # 2. documents 테이블
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            filename TEXT NOT NULL,
            pdf_path TEXT NOT NULL,
            total_pages INTEGER NOT NULL,
            metadata TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE ON UPDATE CASCADE
        )
        """)
        
        # 3. translations 테이블
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS translations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            page_num INTEGER NOT NULL,
            suffix TEXT NOT NULL,
            translation TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE,
            UNIQUE(doc_id, page_num, suffix)
        )
        """)
        
        # 4. chats 테이블 (채팅 내역)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
        )
        """)

        # 5. page_insights 테이블 (페이지별 키워드/단어 설명, 요약 캐시)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS page_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            page_num INTEGER NOT NULL,
            kind TEXT NOT NULL,
            suffix TEXT NOT NULL,
            content TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE,
            UNIQUE(doc_id, page_num, kind, suffix)
        )
        """)

        # documents 테이블 동적 스키마 마이그레이션 (is_deleted 컬럼 추가)
        try:
            cursor.execute("ALTER TABLE documents ADD COLUMN is_deleted INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass

        # chats 테이블 동적 스키마 마이그레이션 (graph_synced_at 컬럼 추가).
        # 질문이 어떤 Concept과도 매칭되지 않는 것은 정상 케이스라
        # question_concepts에 행이 없다는 사실만으로는 "아직 처리 안 됨"과
        # "처리했지만 매칭 결과 없음"을 구분할 수 없다 - documents.metadata의
        # graph_synced_at과 동일한 목적의 처리 완료 마커.
        try:
            cursor.execute("ALTER TABLE chats ADD COLUMN graph_synced_at TEXT")
        except sqlite3.OperationalError:
            pass

        # 6. app_meta 테이블 (자동 업데이트 확인 주기/마지막 확인 시각/마지막으로
        #    "업데이트 완료" 알림을 보여준 버전 등, 자주 바뀌는 앱 내부 상태를
        #    저장하는 범용 key-value 테이블)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS app_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
        """)

        # 7. compare_sessions 테이블 (논문 비교 채팅 세션 id ↔ 비교 대상 문서
        #    id 목록 매핑). chats.doc_id에 쓰이는 "cmp_"+hash 값은 원본
        #    doc_ids 조합을 역산할 수 없는 단방향 해시라서, 라이브러리에서
        #    "이 비교 세션이 어떤 논문들의 비교인지"를 보여주려면 이 매핑을
        #    별도로 저장해둬야 한다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS compare_sessions (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            doc_ids TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)

        # 8. concepts / paper_concepts 테이블 (지식 그래프의 개념 노드, 다대다).
        #    LLM이 뽑는 개념명 표기가 들쭉날쭉하므로 normalized_name(소문자+trim)
        #    으로만 얕게 중복 제거한다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS concepts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL UNIQUE,
            kind TEXT,
            created_at TEXT NOT NULL
        )
        """)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS paper_concepts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            concept_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE,
            FOREIGN KEY (concept_id) REFERENCES concepts (id) ON DELETE CASCADE,
            UNIQUE(doc_id, concept_id)
        )
        """)

        # 9. paper_edges 테이블 (논문 간 인용 관계 영속화). 카테고리 공유 엣지는
        #    영속화하지 않는다 - documents.metadata.categories로 조회 시마다
        #    즉석 그룹핑하면 되고(LLM 재호출 없이 저비용), 영속화하면 재분류 시
        #    무효화 로직이 별도로 필요해져 정합성 리스크만 늘어난다. 인용 관계는
        #    자카드 매칭 계산이 상대적으로 무거워 캐시 가치가 있다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS paper_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id_a TEXT NOT NULL,
            doc_id_b TEXT NOT NULL,
            edge_type TEXT NOT NULL,
            detail TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doc_id_a) REFERENCES documents (id) ON DELETE CASCADE,
            FOREIGN KEY (doc_id_b) REFERENCES documents (id) ON DELETE CASCADE,
            UNIQUE(doc_id_a, doc_id_b, edge_type)
        )
        """)

        # 10. annotations / memos 테이블 (하이라이트/메모의 서버 미러). 프론트의
        #     loadAnnotations/saveAnnotations, loadMemos/saveMemos는 항상 "문서
        #     전체" 단위로 통째로 읽고 쓰며, 하이라이트는 안정적인 id 필드조차
        #     없어 관계형 키 설계가 오히려 복잡해진다. documents.metadata와
        #     동일한 "1 row = 1 blob, 통째로 덮어쓰기" 방식을 쓴다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS annotations (
            doc_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
        )
        """)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS memos (
            doc_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
        )
        """)

        # 11. question_papers / question_concepts 테이블 (지식 그래프 2차: 질문
        #     노드). 질문(chats.role='user' 행) 하나가 어떤 논문(들)에 대한
        #     것인지는 다대다다 - 단일 논문 채팅은 1행이지만, 비교(compare)
        #     채팅은 doc_id가 "cmp_"+hash 가상 id라 compare_sessions.doc_ids로
        #     역매핑한 실제 문서마다 1행씩 생긴다. nullable FK 두 개를 두는
        #     대신 다대다 정규화로 단일/비교 케이스를 동일한 구조로 다룬다.
        #     question_concepts는 질문이 어떤 기존 Concept과 관련 있는지를
        #     나타내며, 새 개념을 여기서 만들지 않고 이미 sync_document_for_graph가
        #     추출해둔 개념 중에서만 고르는 폐쇄형 매칭이다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS question_papers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            doc_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE,
            FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE,
            UNIQUE(chat_id, doc_id)
        )
        """)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS question_concepts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            concept_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE,
            FOREIGN KEY (concept_id) REFERENCES concepts (id) ON DELETE CASCADE,
            UNIQUE(chat_id, concept_id)
        )
        """)

        # 12. concept_edges 테이블 (지식 그래프 2차: AI Graph Linking). 의미가
        #     유사한 Concept끼리의 비파괴적 연결(병합이 아니다 - LLM 판단만으로
        #     결정하므로 오판이 나도 데이터 손실이 없도록 엣지만 추가한다).
        #     대칭 관계라 (a,b)/(b,a) 중복이 생기지 않도록 삽입 시 항상
        #     concept_id_a < concept_id_b로 정렬해서 저장한다(db_upsert_concept_edge).
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS concept_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            concept_id_a INTEGER NOT NULL,
            concept_id_b INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (concept_id_a) REFERENCES concepts (id) ON DELETE CASCADE,
            FOREIGN KEY (concept_id_b) REFERENCES concepts (id) ON DELETE CASCADE,
            UNIQUE(concept_id_a, concept_id_b)
        )
        """)

        # 13. reading_time 테이블 (Reading History의 "읽은 시간" 실측치). 뷰어/비교
        #     화면이 화면에 보이고 포커스된 동안 프런트가 일정 간격(하트비트)으로
        #     경과 초를 보내오면 (doc_id, username, day, category) 단위로 누적한다.
        #     category는 'reading'(뷰어 기본)/'chat'(채팅 사이드바가 열려있는 동안)/
        #     'compare'(논문 비교 채팅 화면) 중 하나 - 실제로 구분 가능한 화면
        #     상태만 카테고리로 쓰고, 근거 없는 세부 항목(예: "메모 작성 시간")은
        #     만들지 않는다.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS reading_time (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            username TEXT NOT NULL,
            day TEXT NOT NULL,
            category TEXT NOT NULL,
            seconds INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            UNIQUE(doc_id, username, day, category)
        )
        """)

        # 라이브러리 목록/문서 조회가 doc_id(+suffix)로 translations를,
        # doc_id로 documents/page_insights/chats를 매번 훑는데(문서 수 x
        # 페이지 수만큼 뻥튀기됨) 인덱스가 없어 전부 풀스캔이었다. 목록
        # 화면을 열 때마다, 그리고 4초 폴링마다 이 비용을 반복해서 냈다.
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_translations_doc_suffix ON translations(doc_id, suffix, page_num)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_translations_doc_saved ON translations(doc_id, saved_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_page_insights_doc ON page_insights(doc_id, kind, suffix)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_documents_username_deleted ON documents(username, is_deleted, created_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_doc ON chats(doc_id, id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_paper_concepts_doc ON paper_concepts(doc_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_paper_concepts_concept ON paper_concepts(concept_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_paper_edges_a ON paper_edges(doc_id_a)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_paper_edges_b ON paper_edges(doc_id_b)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_question_papers_doc ON question_papers(doc_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_question_papers_chat ON question_papers(chat_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_question_concepts_concept ON question_concepts(concept_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_question_concepts_chat ON question_concepts(chat_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_concept_edges_a ON concept_edges(concept_id_a)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_concept_edges_b ON concept_edges(concept_id_b)")
        # 14. reading_sessions 테이블 (Reading Analytics System)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS reading_sessions (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            paper_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            active_reading_time INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 0,
            page_sessions_json TEXT,
            interaction_summary_json TEXT,
            reading_depth TEXT DEFAULT 'Opened',
            reading_score REAL DEFAULT 0.0,
            reading_confidence REAL DEFAULT 0.0,
            verified_pages_count INTEGER DEFAULT 0,
            total_pages INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)

        # 15. user_reading_profiles 테이블 (EMA Learning)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_reading_profiles (
            username TEXT PRIMARY KEY,
            ema_seconds_per_page REAL DEFAULT 600.0,
            session_count INTEGER DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_paper ON reading_sessions(username, paper_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_updated ON reading_sessions(username, updated_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_reading_time_username_day ON reading_time(username, day)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_reading_time_doc ON reading_time(doc_id, username)")

        conn.commit()

        # reading_time 테이블 동적 스키마 마이그레이션: doc_title 컬럼 추가
        # 논문이 영구 삭제된 후에도 제목을 보존하기 위해 하트비트 시 스냅샷 저장.
        try:
            cursor.execute("ALTER TABLE reading_time ADD COLUMN doc_title TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # 이미 존재하면 무시

        # WAL: 여러 읽기 커넥션이 번역 잡의 쓰기 커넥션과 부딪혀 잠기는
        # 문제를 줄인다. 커넥션 단위 PRAGMA가 아니라 DB 파일에 영속되는
        # 설정이라 여기서 한 번만 켜두면 이후 모든 커넥션에 적용된다.
        conn.execute("PRAGMA journal_mode=WAL")
        
    # 기본 관리자 계정 초기 생성
    from config import get_app_username, get_app_password_hash
    default_user = get_app_username()
    default_hash = get_app_password_hash()
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username FROM users WHERE username = ?", (default_user,))
        if not cursor.fetchone():
            cursor.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (default_user, default_hash, datetime.now(timezone.utc).isoformat())
            )
            conn.commit()
            print(f"Default user '{default_user}' created in SQLite database.")


# ── 사용자 (Users) ───────────────────────────────────────────────────────────

def get_user(username: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, password_hash, created_at FROM users WHERE username = ?", (username,))
        row = cursor.fetchone()
        if row:
            return dict(row)
        return None

def create_user(username: str, password_hash: str) -> bool:
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, password_hash, datetime.now(timezone.utc).isoformat())
            )
            conn.commit()
            return True
    except sqlite3.IntegrityError:
        return False

def update_user_credentials(old_username: str, new_username: str, new_password_hash: str) -> bool:
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE users SET username = ?, password_hash = ? WHERE username = ?",
                (new_username, new_password_hash, old_username)
            )
            # documents.username은 users.username을 참조하는 외래키로 선언돼
            # 있지만, SQLite는 연결마다 별도로 PRAGMA foreign_keys를 켜주지
            # 않는 한 이 외래키 제약(및 ON UPDATE CASCADE)을 전혀 강제하지
            # 않는다. 이 프로젝트는 그 PRAGMA를 켜지 않으므로, 아이디를
            # 바꾸면 documents 테이블은 예전 아이디를 그대로 가리킨 채 남아
            # 라이브러리 목록 조회(WHERE username = 새 아이디)에서 전부
            # 빠져버려 문서가 사라진 것처럼 보이는 문제가 있었다. 같은
            # 트랜잭션 안에서 명시적으로 함께 갱신한다.
            if new_username != old_username:
                cursor.execute(
                    "UPDATE documents SET username = ? WHERE username = ?",
                    (new_username, old_username)
                )
            conn.commit()
            return True
    except Exception:
        return False


# ── 문서 (Documents) ──────────────────────────────────────────────────────────

def db_save_document(doc_id: str, username: str, filename: str, pdf_path: str, total_pages: int, metadata: dict) -> dict:
    meta_str = json.dumps(metadata, ensure_ascii=False)
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT OR REPLACE INTO documents (id, username, filename, pdf_path, total_pages, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (doc_id, username, filename, pdf_path, total_pages, meta_str, created_at)
        )
        conn.commit()
    return {
        "id": doc_id,
        "username": username,
        "filename": filename,
        "pdf_path": pdf_path,
        "total_pages": total_pages,
        "metadata": metadata,
        "created_at": created_at
    }

def db_get_document(doc_id: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, filename, pdf_path, total_pages, metadata, is_deleted, created_at FROM documents WHERE id = ?",
            (doc_id,)
        )
        row = cursor.fetchone()
        if row:
            doc = dict(row)
            doc["metadata"] = json.loads(doc["metadata"]) if doc["metadata"] else {}
            return doc
        return None

def db_list_documents(username: Optional[str] = None, only_trash: bool = False, include_deleted: bool = False) -> list:
    with get_db() as conn:
        cursor = conn.cursor()
        if include_deleted:
            if username:
                cursor.execute(
                    "SELECT id, username, filename, pdf_path, total_pages, metadata, is_deleted, created_at FROM documents WHERE username = ? ORDER BY created_at DESC",
                    (username,)
                )
            else:
                cursor.execute(
                    "SELECT id, username, filename, pdf_path, total_pages, metadata, is_deleted, created_at FROM documents ORDER BY created_at DESC"
                )
        else:
            is_deleted_val = 1 if only_trash else 0
            if username:
                cursor.execute(
                    "SELECT id, username, filename, pdf_path, total_pages, metadata, is_deleted, created_at FROM documents WHERE username = ? AND is_deleted = ? ORDER BY created_at DESC",
                    (username, is_deleted_val)
                )
            else:
                cursor.execute(
                    "SELECT id, username, filename, pdf_path, total_pages, metadata, is_deleted, created_at FROM documents WHERE is_deleted = ? ORDER BY created_at DESC",
                    (is_deleted_val,)
                )
        rows = cursor.fetchall()
        docs = []
        for r in rows:
            doc = dict(r)
            doc["metadata"] = json.loads(doc["metadata"]) if doc["metadata"] else {}
            docs.append(doc)
        return docs


def _escape_like(text: str) -> str:
    """LIKE 패턴의 와일드카드(%, _)를 리터럴로 취급하도록 이스케이프한다."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def db_search_documents(username: str, query: str, only_trash: bool = False) -> list:
    """파일명/제목·카테고리(metadata)와 페이지별 번역 텍스트를 가로질러 검색어를
    찾아 매칭되는 문서 목록을 반환합니다 (대소문자 구분 없음).

    원문(PDF에서 추출한 텍스트)은 세션 메모리에만 있고 DB에 영속화되지
    않아 검색 대상에 포함하지 못한다 - 파일명/제목/카테고리와 번역된
    텍스트만 검색 대상이다.
    """
    is_deleted_val = 1 if only_trash else 0
    like_query = f"%{_escape_like(query)}%"

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT DISTINCT d.id, d.username, d.filename, d.pdf_path, d.total_pages,
                   d.metadata, d.is_deleted, d.created_at
            FROM documents d
            LEFT JOIN translations t ON t.doc_id = d.id
            WHERE d.username = ? AND d.is_deleted = ?
              AND (
                    d.filename LIKE ? ESCAPE '\\'
                 OR d.metadata LIKE ? ESCAPE '\\'
                 OR t.translation LIKE ? ESCAPE '\\'
              )
            ORDER BY d.created_at DESC
            """,
            (username, is_deleted_val, like_query, like_query, like_query)
        )
        rows = cursor.fetchall()
        docs = []
        for r in rows:
            doc = dict(r)
            doc["metadata"] = json.loads(doc["metadata"]) if doc["metadata"] else {}
            docs.append(doc)
        return docs


def db_delete_document(doc_id: str) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM documents WHERE id = ?", (doc_id,))
        if not cursor.fetchone():
            return False
        cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.commit()
        return True

def db_soft_delete_document(doc_id: str) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM documents WHERE id = ?", (doc_id,))
        if not cursor.fetchone():
            return False
        cursor.execute("UPDATE documents SET is_deleted = 1 WHERE id = ?", (doc_id,))
        conn.commit()
        return True

def db_restore_document(doc_id: str) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM documents WHERE id = ?", (doc_id,))
        if not cursor.fetchone():
            return False
        cursor.execute("UPDATE documents SET is_deleted = 0 WHERE id = ?", (doc_id,))
        conn.commit()
        return True


# ── 번역 (Translations) ────────────────────────────────────────────────────────

def db_save_translation(doc_id: str, page_num: int, translation: str, suffix: str = "") -> None:
    saved_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT OR REPLACE INTO translations (doc_id, page_num, suffix, translation, saved_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (doc_id, page_num, suffix, translation, saved_at)
        )
        conn.commit()

def db_get_translation(doc_id: str, page_num: int, suffix: str = "", fallback: bool = True) -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        if suffix:
            cursor.execute(
                "SELECT translation FROM translations WHERE doc_id = ? AND page_num = ? AND suffix = ?",
                (doc_id, page_num, suffix)
            )
            row = cursor.fetchone()
            if row:
                return row["translation"]
        
        if fallback:
            # Fallback: get the most recently saved translation for this page, regardless of suffix
            cursor.execute(
                "SELECT translation FROM translations WHERE doc_id = ? AND page_num = ? ORDER BY saved_at DESC LIMIT 1",
                (doc_id, page_num)
            )
            row = cursor.fetchone()
            if row:
                return row["translation"]
        return None

def db_list_translated_pages(doc_id: str, suffix: str = "") -> List[int]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT page_num FROM translations WHERE doc_id = ? AND suffix = ? ORDER BY page_num ASC",
            (doc_id, suffix)
        )
        return [r["page_num"] for r in cursor.fetchall()]


def db_bulk_translation_rows(doc_ids: List[str]) -> Dict[str, List[tuple]]:
    """여러 문서의 (page_num, suffix, saved_at) 행을 한 번의 커넥션으로 모아
    doc_id별로 묶어 반환합니다.

    라이브러리 목록 화면은 문서마다 번역 완료 페이지 목록을 보여주는데,
    예전에는 문서 개수(N)만큼 매번 새 sqlite3 커넥션을 열어 최대 3개의
    쿼리를 던졌다(list_documents 참고). 문서가 늘어날수록, 그리고 4초
    폴링이 반복될수록 이 비용이 그대로 누적돼 라이브러리 화면 자체가
    느려지는 원인이었다. IN절 변수 개수 제한(SQLITE_MAX_VARIABLE_NUMBER,
    보통 999)을 넘지 않도록 청크 단위로 나눠 조회한다.
    """
    result: Dict[str, list] = {doc_id: [] for doc_id in doc_ids}
    if not doc_ids:
        return result

    CHUNK = 500
    with get_db() as conn:
        cursor = conn.cursor()
        for i in range(0, len(doc_ids), CHUNK):
            chunk = doc_ids[i:i + CHUNK]
            placeholders = ",".join("?" for _ in chunk)
            cursor.execute(
                f"SELECT doc_id, page_num, suffix, saved_at FROM translations WHERE doc_id IN ({placeholders})",
                chunk
            )
            for row in cursor.fetchall():
                result[row["doc_id"]].append((row["page_num"], row["suffix"], row["saved_at"]))
    return result


# ── 채팅 (Chats) ──────────────────────────────────────────────────────────────

def db_save_chat_message(doc_id: str, role: str, content: str) -> Optional[int]:
    """저장된 chats 행의 id를 반환한다(지식 그래프 2차: Question 노드 연결에
    필요한 chat_id를 얻기 위함). 직전 메시지와 완전히 동일해 저장을 건너뛰거나
    이미 존재하는 경우 None을 반환하며, 이 반환값을 쓰지 않는 기존 호출부는
    영향받지 않는다."""
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        # Safety check: avoid duplicating the exact last message
        cursor.execute(
            "SELECT role, content FROM chats WHERE doc_id = ? ORDER BY id DESC LIMIT 1",
            (doc_id,)
        )
        last_msg = cursor.fetchone()
        if last_msg and last_msg["role"] == role and last_msg["content"] == content:
            return None

        cursor.execute(
            "INSERT INTO chats (doc_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (doc_id, role, content, created_at)
        )
        conn.commit()
        return cursor.lastrowid

def db_get_chat_history(doc_id: str) -> List[Dict[str, str]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT role, content FROM chats WHERE doc_id = ? ORDER BY id ASC",
            (doc_id,)
        )
        return [{"role": r["role"], "content": r["content"]} for r in cursor.fetchall()]

def db_clear_chat_history(doc_id: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM chats WHERE doc_id = ?", (doc_id,))
        conn.commit()


def db_list_assistant_chat_sessions(username: str) -> List[Dict[str, Any]]:
    """사용자가 AI 어시스턴트(단일 논문) 기능으로 대화한 채팅 세션 목록을,
    최근 대화 시각 역순으로 반환합니다. 비교 채팅(doc_id가 "cmp_"로 시작)은
    제외하고, 휴지통에 있거나 삭제된 문서의 대화도 제외합니다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT d.id AS doc_id, d.filename, d.metadata, MAX(c.created_at) AS last_message_at
            FROM chats c
            JOIN documents d ON d.id = c.doc_id
            WHERE d.username = ? AND d.is_deleted = 0 AND c.doc_id NOT LIKE 'cmp\\_%' ESCAPE '\\'
            GROUP BY c.doc_id
            ORDER BY last_message_at DESC
            """,
            (username,)
        )
        sessions = []
        for r in cursor.fetchall():
            row = dict(r)
            metadata = json.loads(row["metadata"]) if row["metadata"] else {}
            title = metadata.get("title") or row["filename"]
            sessions.append({
                "doc_id": row["doc_id"],
                "title": title,
                "last_message_at": row["last_message_at"],
            })
        return sessions


def db_upsert_compare_session(compare_id: str, username: str, doc_ids: List[str]) -> None:
    """비교 채팅 세션 id와 그 대상 문서 id 목록의 매핑을 저장/갱신합니다."""
    now = datetime.now(timezone.utc).isoformat()
    doc_ids_json = json.dumps(doc_ids, ensure_ascii=False)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO compare_sessions (id, username, doc_ids, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
            """,
            (compare_id, username, doc_ids_json, now, now)
        )
        conn.commit()


def db_get_compare_doc_ids(compare_id: str) -> List[str]:
    """비교 세션 가상 id(cmp_+hash)를 실제 문서 id 목록으로 역매핑한다.
    이 해시는 단방향이라 compare_sessions 테이블 조회 없이는 복원할 수 없다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT doc_ids FROM compare_sessions WHERE id = ?", (compare_id,))
        row = cursor.fetchone()
        if not row:
            return []
        return json.loads(row["doc_ids"])


def db_list_compare_chat_sessions(username: str) -> List[Dict[str, Any]]:
    """사용자가 논문 비교 기능으로 대화한 채팅 세션 목록을, 최근 대화 시각
    역순으로 반환합니다. 각 세션의 doc_ids에 연결된 문서 제목도 함께 담습니다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, doc_ids, updated_at FROM compare_sessions WHERE username = ? ORDER BY updated_at DESC",
            (username,)
        )
        rows = cursor.fetchall()

        sessions = []
        for r in rows:
            row = dict(r)
            doc_ids = json.loads(row["doc_ids"])

            titles = []
            for doc_id in doc_ids:
                cursor.execute(
                    "SELECT filename, metadata FROM documents WHERE id = ? AND username = ?",
                    (doc_id, username)
                )
                doc_row = cursor.fetchone()
                if not doc_row:
                    titles.append("(삭제된 논문)")
                    continue
                doc = dict(doc_row)
                metadata = json.loads(doc["metadata"]) if doc["metadata"] else {}
                titles.append(metadata.get("title") or doc["filename"])

            sessions.append({
                "id": row["id"],
                "doc_ids": doc_ids,
                "titles": titles,
                "last_message_at": row["updated_at"],
            })
        return sessions


# ── 페이지 인사이트 (키워드/단어, 요약) ─────────────────────────────────────────

def db_save_page_insight(doc_id: str, page_num: int, kind: str, content: str, suffix: str = "") -> None:
    saved_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT OR REPLACE INTO page_insights (doc_id, page_num, kind, suffix, content, saved_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (doc_id, page_num, kind, suffix, content, saved_at)
        )
        conn.commit()

def db_get_page_insight(doc_id: str, page_num: int, kind: str, suffix: str = "") -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT content FROM page_insights WHERE doc_id = ? AND page_num = ? AND kind = ? AND suffix = ?",
            (doc_id, page_num, kind, suffix)
        )
        row = cursor.fetchone()
        return row["content"] if row else None

def db_clear_page_insights(doc_id: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM page_insights WHERE doc_id = ?", (doc_id,))
        conn.commit()

def db_delete_page_insight(doc_id: str, page_num: int, kind: str, suffix: str = "") -> None:
    """특정 kind/suffix 하나만 지운다. db_clear_page_insights는 문서의 모든
    인사이트(키워드/요약/브리핑 등, 언어별로도 전부)를 지워버려 "이 브리핑
    하나만 다시 생성" 같은 용도로 쓰기엔 범위가 너무 넓다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM page_insights WHERE doc_id = ? AND page_num = ? AND kind = ? AND suffix = ?",
            (doc_id, page_num, kind, suffix)
        )
        conn.commit()


def db_clear_translations(doc_id: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM translations WHERE doc_id = ?", (doc_id,))
        conn.commit()

def db_update_document_metadata(doc_id: str, metadata: dict) -> None:
    meta_str = json.dumps(metadata, ensure_ascii=False)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE documents SET metadata = ? WHERE id = ?",
            (meta_str, doc_id)
        )
        conn.commit()


# ── 앱 내부 상태 (app_meta) ───────────────────────────────────────────────────

def db_get_meta(key: str) -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM app_meta WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else None


def db_set_meta(key: str, value: str) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value)
        )
        conn.commit()


# ── 지식 그래프 (개념 / 논문 간 인용 엣지) ───────────────────────────────────────

def db_upsert_concept(name: str, normalized_name: str, kind: Optional[str] = None) -> int:
    """개념을 normalized_name 기준으로 upsert하고 concept id를 반환한다."""
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO concepts (name, normalized_name, kind, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(normalized_name) DO UPDATE SET kind = COALESCE(excluded.kind, concepts.kind)
            """,
            (name, normalized_name, kind, created_at)
        )
        cursor.execute("SELECT id FROM concepts WHERE normalized_name = ?", (normalized_name,))
        conn.commit()
        return cursor.fetchone()["id"]


def db_link_paper_concept(doc_id: str, concept_id: int) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO paper_concepts (doc_id, concept_id, created_at) VALUES (?, ?, ?)",
            (doc_id, concept_id, created_at)
        )
        conn.commit()


def db_get_concepts_for_docs(doc_ids: List[str]) -> List[Dict[str, Any]]:
    """주어진 문서들에 연결된 (doc_id, concept) 쌍을 모두 반환한다."""
    if not doc_ids:
        return []
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in doc_ids)
        cursor.execute(
            f"""
            SELECT pc.doc_id, c.id AS concept_id, c.name, c.kind
            FROM paper_concepts pc
            JOIN concepts c ON c.id = pc.concept_id
            WHERE pc.doc_id IN ({placeholders})
            """,
            doc_ids
        )
        return [dict(r) for r in cursor.fetchall()]


def db_upsert_paper_edge(doc_id_a: str, doc_id_b: str, edge_type: str, detail: Optional[dict] = None) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    detail_str = json.dumps(detail, ensure_ascii=False) if detail else None
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO paper_edges (doc_id_a, doc_id_b, edge_type, detail, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(doc_id_a, doc_id_b, edge_type) DO UPDATE SET detail = excluded.detail
            """,
            (doc_id_a, doc_id_b, edge_type, detail_str, created_at)
        )
        conn.commit()


def db_get_paper_edges_for_docs(doc_ids: List[str]) -> List[Dict[str, Any]]:
    """양쪽 doc_id가 모두 주어진 집합에 속하는 엣지만 반환한다(다른 사용자
    소유 문서로 향하는 엣지가 섞여 나오지 않도록 호출부에서 doc_ids를
    "이 사용자가 소유한 문서 id 목록"으로 제한해서 넘겨야 한다)."""
    if not doc_ids:
        return []
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in doc_ids)
        cursor.execute(
            f"""
            SELECT doc_id_a, doc_id_b, edge_type, detail
            FROM paper_edges
            WHERE doc_id_a IN ({placeholders}) AND doc_id_b IN ({placeholders})
            """,
            doc_ids + doc_ids
        )
        edges = []
        for r in cursor.fetchall():
            row = dict(r)
            row["detail"] = json.loads(row["detail"]) if row["detail"] else None
            edges.append(row)
        return edges


def db_upsert_concept_edge(concept_id_x: int, concept_id_y: int) -> None:
    """의미가 유사한 두 Concept을 비파괴적으로 연결한다(병합 아님). 대칭
    관계이므로 (a,b)/(b,a) 중복이 생기지 않도록 항상 작은 id를 concept_id_a로
    정렬해서 저장한다."""
    if concept_id_x == concept_id_y:
        return
    concept_id_a, concept_id_b = sorted([concept_id_x, concept_id_y])
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO concept_edges (concept_id_a, concept_id_b, created_at) VALUES (?, ?, ?)",
            (concept_id_a, concept_id_b, created_at)
        )
        conn.commit()


def db_get_concept_edges_for_concepts(concept_ids: List[int]) -> List[Dict[str, Any]]:
    """양쪽 concept_id가 모두 주어진 집합에 속하는 유사 개념 엣지만 반환한다
    (다른 사용자 소유 문서에서만 등장하는 개념으로 향하는 엣지가 섞이지
    않도록, 호출부에서 concept_ids를 "이 사용자의 그래프에 실제로 등장하는
    concept id 목록"으로 제한해서 넘겨야 한다)."""
    if not concept_ids:
        return []
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in concept_ids)
        cursor.execute(
            f"""
            SELECT concept_id_a, concept_id_b
            FROM concept_edges
            WHERE concept_id_a IN ({placeholders}) AND concept_id_b IN ({placeholders})
            """,
            concept_ids + concept_ids
        )
        return [dict(r) for r in cursor.fetchall()]


# ── 지식 그래프 (질문 노드) ──────────────────────────────────────────────────

def db_link_question_paper(chat_id: int, doc_id: str) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO question_papers (chat_id, doc_id, created_at) VALUES (?, ?, ?)",
            (chat_id, doc_id, created_at)
        )
        conn.commit()


def db_link_question_concept(chat_id: int, concept_id: int) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO question_concepts (chat_id, concept_id, created_at) VALUES (?, ?, ?)",
            (chat_id, concept_id, created_at)
        )
        conn.commit()


def db_mark_question_synced(chat_id: int) -> None:
    synced_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE chats SET graph_synced_at = ? WHERE id = ?", (synced_at, chat_id))
        conn.commit()


def db_get_unsynced_questions(doc_ids: List[str], limit: int = 20) -> List[Dict[str, Any]]:
    """주어진 문서들에 속한 질문(role='user') 중 아직 개념 매칭이 안 된
    것을 오래된 순으로 최대 limit개 반환한다. 비교 세션 채팅은 doc_id가
    documents 테이블에 없는 가상 id(cmp_...)라 이 함수의 doc_ids 스캔에는
    잡히지 않는다 - 비교 채팅의 backfill은 compare_sessions를 별도로
    순회해야 하며, 지식 그래프 조회 시점 backfill(get_graph_data)은
    사용자 소유 문서 기준으로만 동작하므로 범위 밖이다."""
    if not doc_ids:
        return []
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in doc_ids)
        cursor.execute(
            f"""
            SELECT id, doc_id, content
            FROM chats
            WHERE doc_id IN ({placeholders}) AND role = 'user' AND graph_synced_at IS NULL
            ORDER BY id ASC
            LIMIT ?
            """,
            doc_ids + [limit]
        )
        return [dict(r) for r in cursor.fetchall()]


def db_get_question_count_for_concepts(concept_ids: List[int]) -> Dict[int, int]:
    if not concept_ids:
        return {}
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in concept_ids)
        cursor.execute(
            f"""
            SELECT concept_id, COUNT(*) AS cnt
            FROM question_concepts
            WHERE concept_id IN ({placeholders})
            GROUP BY concept_id
            """,
            concept_ids
        )
        return {r["concept_id"]: r["cnt"] for r in cursor.fetchall()}


def db_get_question_doc_concept_counts(doc_ids: List[str]) -> Dict[Tuple[str, int], int]:
    """(논문, 개념) 쌍마다 그 논문에 대해 그 개념과 관련된 질문이 몇 개 있었는지 센다.
    새 테이블 없이 question_papers(질문-논문)와 question_concepts(질문-개념)를 chat_id로
    조인해 교집합만 집계한다 - Concept Heatmap 매트릭스의 셀 강도에 쓰인다."""
    if not doc_ids:
        return {}
    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in doc_ids)
        cursor.execute(
            f"""
            SELECT qp.doc_id, qc.concept_id, COUNT(*) AS cnt
            FROM question_papers qp
            JOIN question_concepts qc ON qc.chat_id = qp.chat_id
            WHERE qp.doc_id IN ({placeholders})
            GROUP BY qp.doc_id, qc.concept_id
            """,
            doc_ids
        )
        return {(r["doc_id"], r["concept_id"]): r["cnt"] for r in cursor.fetchall()}


def db_get_related_questions_for_concept(concept_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    """이 Concept과 연결된 질문들을 최신순으로 반환한다(소속 논문 제목 포함)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT c.content, c.created_at, d.id AS doc_id, d.filename, d.metadata
            FROM question_concepts qc
            JOIN chats c ON c.id = qc.chat_id
            LEFT JOIN question_papers qp ON qp.chat_id = c.id
            LEFT JOIN documents d ON d.id = qp.doc_id
            WHERE qc.concept_id = ?
            ORDER BY c.id DESC
            LIMIT ?
            """,
            (concept_id, limit)
        )
        results = []
        for r in cursor.fetchall():
            row = dict(r)
            metadata = json.loads(row["metadata"]) if row.get("metadata") else {}
            results.append({
                "content": row["content"],
                "created_at": row["created_at"],
                "doc_id": row.get("doc_id"),
                "doc_title": metadata.get("title") or row.get("filename"),
            })
        return results


def db_get_related_questions_for_doc(doc_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    """이 논문에 대해 오간 질문들을 최신순으로 반환한다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT c.content, c.created_at
            FROM question_papers qp
            JOIN chats c ON c.id = qp.chat_id
            WHERE qp.doc_id = ?
            ORDER BY c.id DESC
            LIMIT ?
            """,
            (doc_id, limit)
        )
        return [dict(r) for r in cursor.fetchall()]


def db_get_all_concepts() -> List[Dict[str, Any]]:
    """전체 개념 목록을 반환한다. concepts 테이블은 normalized_name으로만
    전역 중복 제거되며(사용자별로 분리되지 않음, paper_concepts를 통해 어떤
    문서에 연결됐는지로만 사용자 범위가 결정된다), AI Graph Linking(새 개념과
    기존 개념의 유사도 비교)에 필요한 "기존 개념 전체 이름 목록"을 얻기 위해
    쓰인다."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, normalized_name FROM concepts")
        return [dict(r) for r in cursor.fetchall()]


def db_search_graph_nodes(doc_ids: List[str], query: str) -> Dict[str, List[str]]:
    """이 사용자가 소유한 doc_ids 범위 안에서 논문/개념/메모(Note)/질문을
    검색해 매칭된 그래프 노드 id를 타입별로 반환한다. 질문은 그래프 노드가
    아니므로, 매칭되면 그 질문이 연결된 concept/paper 노드로 대체 매핑한다."""
    if not doc_ids or not (query or "").strip():
        return {"paper": [], "concept": [], "note": []}

    like_query = f"%{_escape_like(query)}%"
    needle = query.strip().lower()
    paper_ids: set = set()
    concept_ids: set = set()
    note_ids: set = set()

    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in doc_ids)

        cursor.execute(
            f"""
            SELECT id FROM documents
            WHERE id IN ({placeholders})
              AND (filename LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')
            """,
            doc_ids + [like_query, like_query]
        )
        paper_ids.update(r["id"] for r in cursor.fetchall())

        cursor.execute(
            f"""
            SELECT DISTINCT c.id FROM concepts c
            JOIN paper_concepts pc ON pc.concept_id = c.id
            WHERE pc.doc_id IN ({placeholders}) AND c.name LIKE ? ESCAPE '\\'
            """,
            doc_ids + [like_query]
        )
        concept_ids.update(r["id"] for r in cursor.fetchall())

        cursor.execute(
            f"SELECT doc_id, data FROM memos WHERE doc_id IN ({placeholders}) AND data LIKE ? ESCAPE '\\'",
            doc_ids + [like_query]
        )
        for r in cursor.fetchall():
            try:
                blob = json.loads(r["data"])
            except (TypeError, ValueError):
                continue
            for items in (blob or {}).values():
                for item in items or []:
                    if not isinstance(item, dict):
                        continue
                    if needle in (item.get("text") or "").lower() and item.get("id"):
                        note_ids.add(f"{r['doc_id']}:{item['id']}")

        cursor.execute(
            f"SELECT id FROM chats WHERE doc_id IN ({placeholders}) AND role = 'user' AND content LIKE ? ESCAPE '\\'",
            doc_ids + [like_query]
        )
        chat_ids = [r["id"] for r in cursor.fetchall()]
        if chat_ids:
            chat_placeholders = ",".join("?" for _ in chat_ids)
            cursor.execute(
                f"SELECT DISTINCT doc_id FROM question_papers WHERE chat_id IN ({chat_placeholders})",
                chat_ids
            )
            paper_ids.update(r["doc_id"] for r in cursor.fetchall())
            cursor.execute(
                f"SELECT DISTINCT concept_id FROM question_concepts WHERE chat_id IN ({chat_placeholders})",
                chat_ids
            )
            concept_ids.update(r["concept_id"] for r in cursor.fetchall())

    return {
        "paper": [f"paper:{d}" for d in paper_ids],
        "concept": [f"concept:{c}" for c in concept_ids],
        "note": [f"note:{n}" for n in note_ids],
    }


# ── 메모 / 하이라이트 서버 미러 ───────────────────────────────────────────────

def db_get_annotations(doc_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT data, updated_at FROM annotations WHERE doc_id = ?", (doc_id,))
        row = cursor.fetchone()
        if not row:
            return None
        return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


def db_put_annotations(doc_id: str, data: dict) -> None:
    updated_at = datetime.now(timezone.utc).isoformat()
    data_str = json.dumps(data, ensure_ascii=False)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO annotations (doc_id, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
            """,
            (doc_id, data_str, updated_at)
        )
        conn.commit()


def db_get_memos(doc_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT data, updated_at FROM memos WHERE doc_id = ?", (doc_id,))
        row = cursor.fetchone()
        if not row:
            return None
        return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


def db_put_memos(doc_id: str, data: dict) -> None:
    updated_at = datetime.now(timezone.utc).isoformat()
    data_str = json.dumps(data, ensure_ascii=False)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO memos (doc_id, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
            """,
            (doc_id, data_str, updated_at)
        )
        conn.commit()


def db_get_memo_counts_for_docs(doc_ids: List[str]) -> Dict[str, int]:
    """문서별 메모 개수를 반환한다. 메모는 문서당 1개의 JSON blob으로
    저장되어 있어(_queue_note_nodes와 동일한 이유) SQL COUNT로 셀 수 없고
    각 blob을 순회해 항목 수를 더해야 한다. 메모가 0개인 문서는 결과에
    포함하지 않는다(호출부가 .get(doc_id, 0)으로 기본값을 다루도록)."""
    if not doc_ids:
        return {}
    counts = {}
    for doc_id in doc_ids:
        mirrored = db_get_memos(doc_id)
        total = sum(len(items or []) for items in (mirrored or {}).get("data", {}).values())
        if total:
            counts[doc_id] = total
    return counts


def db_add_reading_time(doc_id: str, username: str, category: str, seconds: int) -> None:
    """뷰어/비교 화면 하트비트로 들어온 경과 초를 (doc_id, username, 오늘 날짜,
    category) 버킷에 누적한다. 하루 단위로 쌓아두면 캘린더 히트맵/기간별 통계를
    reading_time만으로 바로 집계할 수 있다.
    논문이 나중에 영구 삭제되더라도 제목을 보존하기 위해 documents 테이블에서
    현재 제목을 조회해 doc_title 컬럼에 스냅샷한다."""
    if seconds <= 0:
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        # 논문 제목 스냅샷: 영구 삭제 후에도 제목을 복원하기 위해 저장
        doc_title: Optional[str] = None
        try:
            cursor.execute(
                "SELECT filename, metadata FROM documents WHERE id = ?",
                (doc_id,)
            )
            row = cursor.fetchone()
            if row:
                meta = json.loads(row["metadata"]) if row["metadata"] else {}
                doc_title = meta.get("title") or row["filename"] or None
        except Exception:
            pass

        cursor.execute(
            """
            INSERT INTO reading_time (doc_id, username, day, category, seconds, updated_at, doc_title)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(doc_id, username, day, category)
            DO UPDATE SET
                seconds = seconds + excluded.seconds,
                updated_at = excluded.updated_at,
                doc_title = COALESCE(excluded.doc_title, reading_time.doc_title)
            """,
            (doc_id, username, day, category, int(seconds), now, doc_title)
        )
        conn.commit()


def db_get_reading_time_stats(username: str, since_days: Optional[int] = None) -> Dict[str, Any]:
    """사용자의 실측 읽기 시간을 세 가지 형태로 집계해서 반환한다:
    - total_seconds_by_category: {"reading": n, "chat": n, "compare": n} (시간 분포용)
    - total_seconds_by_doc: {doc_id: seconds} (Top Papers by Reading Time용, 카테고리 무관 합계)
    - total_seconds_by_day: {"YYYY-MM-DD": seconds} (일별 총 읽기 시간)
    since_days가 주어지면 오늘 포함 최근 N일로 제한한다."""
    with get_db() as conn:
        cursor = conn.cursor()
        params: List[Any] = [username]
        day_filter = ""
        if since_days is not None:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days - 1)).strftime("%Y-%m-%d")
            day_filter = " AND day >= ?"
            params.append(cutoff)
        cursor.execute(
            f"SELECT doc_id, day, category, seconds FROM reading_time WHERE username = ?{day_filter}",
            params,
        )
        rows = cursor.fetchall()

    by_category: Dict[str, int] = {}
    by_doc: Dict[str, int] = {}
    by_day: Dict[str, int] = {}
    total_seconds = 0
    for r in rows:
        by_category[r["category"]] = by_category.get(r["category"], 0) + r["seconds"]
        by_doc[r["doc_id"]] = by_doc.get(r["doc_id"], 0) + r["seconds"]
        by_day[r["day"]] = by_day.get(r["day"], 0) + r["seconds"]
        total_seconds += r["seconds"]

    # doc별 저장된 제목 스냅샷 조회 (영구 삭제된 논문 제목 복원용)
    title_by_doc: Dict[str, str] = {}
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            cursor.execute(
                "SELECT doc_id, doc_title FROM reading_time WHERE username = ? AND doc_title IS NOT NULL GROUP BY doc_id",
                (username,)
            )
            for tr in cursor.fetchall():
                if tr["doc_id"] and tr["doc_title"]:
                    title_by_doc[tr["doc_id"]] = tr["doc_title"]
        except Exception:
            pass

    return {
        "total_seconds": total_seconds,
        "total_seconds_by_category": by_category,
        "total_seconds_by_doc": by_doc,
        "total_seconds_by_day": by_day,
        "title_by_doc": title_by_doc,
    }


def db_get_latest_reading_session(paper_id: str, username: str) -> Optional[Dict[str, Any]]:
    """Gets the most recently updated reading session for a given paper and user."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, paper_id, started_at, ended_at, active_reading_time, version,
                   page_sessions_json, interaction_summary_json, reading_depth,
                   reading_score, reading_confidence, verified_pages_count, total_pages,
                   created_at, updated_at
            FROM reading_sessions
            WHERE username = ? AND paper_id = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (username, paper_id),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return dict(row)


def db_get_reading_session(session_id: str, username: str) -> Optional[Dict[str, Any]]:
    """Gets a specific reading session by ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, paper_id, started_at, ended_at, active_reading_time, version,
                   page_sessions_json, interaction_summary_json, reading_depth,
                   reading_score, reading_confidence, verified_pages_count, total_pages,
                   created_at, updated_at
            FROM reading_sessions
            WHERE id = ? AND username = ?
            """,
            (session_id, username),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return dict(row)


def db_save_reading_session(
    session_id: str,
    username: str,
    paper_id: str,
    started_at: str,
    ended_at: Optional[str],
    active_reading_time: int,
    version: int,
    page_sessions_json: str,
    interaction_summary_json: str,
    reading_depth: str,
    reading_score: float,
    reading_confidence: float,
    verified_pages_count: int,
    total_pages: int,
) -> bool:
    """Insert a session or replace it only with a newer heartbeat version."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO reading_sessions (
                id, username, paper_id, started_at, ended_at, active_reading_time, version,
                page_sessions_json, interaction_summary_json, reading_depth,
                reading_score, reading_confidence, verified_pages_count, total_pages,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                ended_at = excluded.ended_at,
                active_reading_time = excluded.active_reading_time,
                version = excluded.version,
                page_sessions_json = excluded.page_sessions_json,
                interaction_summary_json = excluded.interaction_summary_json,
                reading_depth = excluded.reading_depth,
                reading_score = excluded.reading_score,
                reading_confidence = excluded.reading_confidence,
                verified_pages_count = excluded.verified_pages_count,
                total_pages = excluded.total_pages,
                updated_at = excluded.updated_at
            WHERE excluded.version > reading_sessions.version
            """,
            (
                session_id,
                username,
                paper_id,
                started_at,
                ended_at,
                active_reading_time,
                version,
                page_sessions_json,
                interaction_summary_json,
                reading_depth,
                reading_score,
                reading_confidence,
                verified_pages_count,
                total_pages,
                now_iso,
                now_iso,
            ),
        )
        saved = cursor.rowcount > 0
        conn.commit()
        return saved


def db_get_reading_sessions_for_user(username: str) -> List[Dict[str, Any]]:
    """Return Reading Analytics sessions for Timeline, newest first."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT rs.id, rs.paper_id, rs.started_at, rs.ended_at,
                   rs.active_reading_time, rs.version, rs.page_sessions_json,
                   rs.reading_depth, rs.reading_score, rs.reading_confidence,
                   rs.verified_pages_count, rs.total_pages, rs.updated_at,
                   titles.doc_title
            FROM reading_sessions AS rs
            LEFT JOIN (
                SELECT doc_id, MAX(doc_title) AS doc_title
                FROM reading_time
                WHERE username = ? AND doc_title IS NOT NULL
                GROUP BY doc_id
            ) AS titles ON titles.doc_id = rs.paper_id
            WHERE rs.username = ?
            ORDER BY rs.started_at DESC
            """,
            (username, username),
        )
        return [dict(row) for row in cursor.fetchall()]


def db_get_user_reading_profile(username: str) -> Dict[str, Any]:
    """Gets or initializes the user EMA reading profile."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT ema_seconds_per_page, session_count FROM user_reading_profiles WHERE username = ?",
            (username,),
        )
        row = cursor.fetchone()
        if not row:
            return {"ema_seconds_per_page": 600.0, "session_count": 0}
        return dict(row)


def db_save_user_reading_profile(username: str, ema_seconds_per_page: float, session_count: int) -> None:
    """Updates user EMA profile."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO user_reading_profiles (username, ema_seconds_per_page, session_count, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                ema_seconds_per_page = excluded.ema_seconds_per_page,
                session_count = excluded.session_count,
                updated_at = excluded.updated_at
            """,
            (username, ema_seconds_per_page, session_count, now_iso),
        )
        conn.commit()


def db_get_all_reading_analytics_summary(username: str, since_days: Optional[int] = None) -> Dict[str, Any]:
    """Aggregates reading analytics metrics per paper and overall for dashboard and history."""
    with get_db() as conn:
        cursor = conn.cursor()
        params: List[Any] = [username]
        day_filter = ""
        if since_days is not None:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days - 1)).strftime("%Y-%m-%d")
            day_filter = " AND updated_at >= ?"
            params.append(cutoff)

        cursor.execute(
            f"""
            SELECT paper_id, reading_score, reading_confidence, reading_depth,
                   verified_pages_count, total_pages, active_reading_time, updated_at
            FROM reading_sessions
            WHERE username = ?{day_filter}
            ORDER BY updated_at DESC
            """,
            params,
        )
        rows = cursor.fetchall()

    paper_stats: Dict[str, Dict[str, Any]] = {}
    total_active_time = 0
    scores = []
    confidences = []
    verified_sum = 0

    for r in rows:
        pid = r["paper_id"]
        # Keep latest session info per paper
        if pid not in paper_stats:
            paper_stats[pid] = {
                "paper_id": pid,
                "reading_score": r["reading_score"],
                "reading_confidence": r["reading_confidence"],
                "reading_depth": r["reading_depth"],
                "verified_pages_count": r["verified_pages_count"],
                "total_pages": r["total_pages"],
                "active_reading_time": r["active_reading_time"],
                "updated_at": r["updated_at"],
            }
            scores.append(r["reading_score"])
            confidences.append(r["reading_confidence"])
            verified_sum += r["verified_pages_count"]

        total_active_time += r["active_reading_time"]

    avg_score = round(sum(scores) / len(scores), 1) if scores else 0.0
    avg_confidence = round(sum(confidences) / len(confidences), 1) if confidences else 0.0

    return {
        "overall_avg_score": avg_score,
        "overall_avg_confidence": avg_confidence,
        "overall_verified_pages": verified_sum,
        "total_active_reading_time": total_active_time,
        "paper_stats": paper_stats,
    }

