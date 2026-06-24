import sqlite3
import os
import json
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "easypaper.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
        
        conn.commit()
        
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
            "SELECT id, username, filename, pdf_path, total_pages, metadata, created_at FROM documents WHERE id = ?",
            (doc_id,)
        )
        row = cursor.fetchone()
        if row:
            doc = dict(row)
            doc["metadata"] = json.loads(doc["metadata"]) if doc["metadata"] else {}
            return doc
        return None

def db_list_documents(username: Optional[str] = None) -> list:
    with get_db() as conn:
        cursor = conn.cursor()
        if username:
            cursor.execute(
                "SELECT id, username, filename, pdf_path, total_pages, metadata, created_at FROM documents WHERE username = ? ORDER BY created_at DESC",
                (username,)
            )
        else:
            cursor.execute(
                "SELECT id, username, filename, pdf_path, total_pages, metadata, created_at FROM documents ORDER BY created_at DESC"
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

def db_get_translation(doc_id: str, page_num: int, suffix: str = "") -> Optional[str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT translation FROM translations WHERE doc_id = ? AND page_num = ? AND suffix = ?",
            (doc_id, page_num, suffix)
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


# ── 채팅 (Chats) ──────────────────────────────────────────────────────────────

def db_save_chat_message(doc_id: str, role: str, content: str) -> None:
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
            return
            
        cursor.execute(
            "INSERT INTO chats (doc_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (doc_id, role, content, created_at)
        )
        conn.commit()

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
