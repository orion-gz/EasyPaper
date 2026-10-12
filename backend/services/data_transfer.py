"""Versioned, user-scoped archives. Imports append with fresh IDs in one transaction."""
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import uuid
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from services import db, library, cache

FORMAT = 'easypaper-user-data'
VERSION = 1
MAX_ARCHIVE_BYTES = 4 * 1024**3
MAX_EXPANDED_BYTES = 8 * 1024**3
MAX_MANIFEST_BYTES = 256 * 1024**2
MAX_FILES = 100000
# Explicit allowlist: never accept arbitrary tables/SQL or authentication data.
USER_TABLES = (
    'user_workspace_settings', 'user_language_settings', 'user_reading_profiles',
    'document_mode_metrics', 'reading_time', 'reading_time_receipts',
    'reading_sessions', 'reading_page_evidence', 'paper_reading_stats', 'folders',
)
DOC_TABLES = (
    'translations', 'chats', 'page_insights', 'document_tasks', 'parsing_diagnostics',
    'reparse_previews', 'chat_evidence', 'paper_concepts', 'annotations', 'memos',
    'annotation_mutations', 'question_papers', 'document_folders',
)
TABLES = ('documents', 'compare_sessions', *USER_TABLES, *DOC_TABLES,
          'document_task_pages', 'question_concepts', 'concepts', 'concept_edges', 'paper_edges')
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]+$')


class InvalidArchive(ValueError):
    pass


def _rows(conn, table, clause='', params=()):
    return [dict(row) for row in conn.execute(f'SELECT * FROM "{table}" {clause}', params)]


def _in_rows(conn, table, column, values):
    # Avoid SQLite's variable limit for large libraries.
    result = []
    values = list(values)
    for start in range(0, len(values), 500):
        batch = values[start:start + 500]
        result.extend(_rows(conn, table, f'WHERE "{column}" IN ({",".join("?" for _ in batch)})', batch))
    return result


def _snapshot(conn, username):
    tables = {t: [] for t in TABLES}
    tables['documents'] = _rows(conn, 'documents', 'WHERE username = ?', (username,))
    docs = {row['id'] for row in tables['documents']}
    # Comparison conversations deliberately survive permanent document deletion.
    # Their owner, not the continued existence of every source paper, sets scope.
    tables['compare_sessions'] = _rows(conn, 'compare_sessions', 'WHERE username = ?', (username,))
    sessions = docs | {row['id'] for row in tables['compare_sessions']}
    for table in USER_TABLES:
        tables[table] = _rows(conn, table, 'WHERE username = ?', (username,))
    for table in DOC_TABLES:
        tables[table] = _in_rows(conn, table, 'doc_id', sessions if table == 'chats' else docs)
    chats = {r['id'] for r in tables['chats']}
    tables['question_papers'] = [r for r in tables['question_papers'] if r['chat_id'] in chats]
    tables['chat_evidence'] = [r for r in tables['chat_evidence'] if r['answer_message_id'] in chats]
    tables['document_task_pages'] = _in_rows(conn, 'document_task_pages', 'task_id', {r['id'] for r in tables['document_tasks']})
    tables['question_concepts'] = _in_rows(conn, 'question_concepts', 'chat_id', chats)
    concepts = {r['concept_id'] for t in ('paper_concepts', 'question_concepts') for r in tables[t]}
    tables['concepts'] = _in_rows(conn, 'concepts', 'id', concepts)
    tables['concept_edges'] = [r for r in _in_rows(conn, 'concept_edges', 'concept_id_a', concepts) if r['concept_id_b'] in concepts]
    tables['paper_edges'] = [r for r in _in_rows(conn, 'paper_edges', 'doc_id_a', docs) if r['doc_id_b'] in docs]
    return tables


def export_archive(username, browser_data, destination):
    with closing(db.get_db()) as conn:
        conn.execute('BEGIN')
        tables = _snapshot(conn, username)
        conn.rollback()
    docs = {r['id'] for r in tables['documents']}
    sessions = docs | {r['id'] for r in tables['compare_sessions']}
    files = {}
    expanded_bytes = 0
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        def add(path, name):
            nonlocal expanded_bytes
            expanded_bytes += path.stat().st_size
            if expanded_bytes > MAX_EXPANDED_BYTES or len(files) >= MAX_FILES - 1:
                raise InvalidArchive('Backup exceeds supported size or file count limits.')
            if path.is_symlink() or not path.is_file():
                raise InvalidArchive('Document files must be regular files.')
            digest = hashlib.sha256()
            with path.open('rb') as source, archive.open(name, 'w', force_zip64=True) as target:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    target.write(chunk)
            files[name] = digest.hexdigest()
        for doc_id in sorted(sessions):
            if not SAFE_ID.fullmatch(doc_id):
                raise InvalidArchive('Invalid document identifier.')
            for label, root in (('library', library.LIBRARY_DIR), ('uploads', library.UPLOAD_DIR)):
                directory = Path(root) / doc_id
                if directory.is_symlink():
                    raise InvalidArchive('Document directory must not be a symbolic link.')
                if directory.exists():
                    for path in sorted(directory.rglob('*')):
                        if path.is_symlink():
                            raise InvalidArchive('Document files must not be symbolic links.')
                        if path.is_file() and path.name not in ('ai_session.json', 'conversation_id.txt'):
                            add(path, f'{label}/{doc_id}/{path.relative_to(directory).as_posix()}')
            for path in sorted(Path(cache.CACHE_DIR).glob(f'{doc_id}_*')):
                if path.is_file():
                    add(path, f'cache/{doc_id}/{path.name[len(doc_id):]}')
        for row in tables['documents']:
            if row.get('content_kind') == 'html_article':
                required = f"library/{row['id']}/article/article.json"
            else:
                required = f"library/{row['id']}/document.pdf"
            if required not in files:
                raise InvalidArchive(f"Missing original file for {row['filename']}.")
            # Do not disclose source machine paths.
            row['pdf_path'] = ''
        for row in tables['reparse_previews']:
            row['staging_path'] = None
        manifest = {'format': FORMAT, 'version': VERSION,
                    'exported_at': datetime.now(timezone.utc).isoformat(),
                    'tables': tables, 'browser_data': filter_browser_data(browser_data, sessions, username, {r['id'] for r in tables['reading_sessions']}),
                    'system_settings': system_settings(), 'files': files}
        payload = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
        if len(payload) > MAX_MANIFEST_BYTES or expanded_bytes + len(payload) > MAX_EXPANDED_BYTES:
            raise InvalidArchive('Backup manifest exceeds supported size limits.')
        archive.writestr('manifest.json', payload)
    if hasattr(destination, 'stat') and destination.stat().st_size > MAX_ARCHIVE_BYTES:
        raise InvalidArchive('Backup exceeds the 4 GiB archive limit.')


def _read_archive(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(entries) > MAX_FILES or len(set(names)) != len(names):
        raise InvalidArchive('Too many or duplicate archive entries.')
    if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
        raise InvalidArchive('Archive exceeds the expanded size limit.')
    for entry in entries:
        path = PurePosixPath(entry.filename)
        if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                or ':' in entry.filename or entry.is_dir()
                or (entry.external_attr >> 16) & 0o170000 == 0o120000):
            raise InvalidArchive('Unsafe archive entry.')
    if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > MAX_MANIFEST_BYTES:
        raise InvalidArchive('Missing or oversized manifest.')
    manifest = json.loads(archive.read('manifest.json'))
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT or manifest.get('version') != VERSION:
        raise InvalidArchive('Unsupported backup format or version.')
    tables, files = manifest.get('tables'), manifest.get('files')
    if not isinstance(tables, dict) or set(tables) != set(TABLES) or not isinstance(files, dict):
        raise InvalidArchive('Invalid backup manifest.')
    if set(names) != set(files) | {'manifest.json'}:
        raise InvalidArchive('Archive file inventory does not match.')
    for rows in tables.values():
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise InvalidArchive('Invalid table data.')
    browser = manifest.get('browser_data', {})
    if not isinstance(manifest.get('system_settings', {}), dict):
        raise InvalidArchive('Invalid system settings.')
    if not isinstance(browser, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in browser.items()):
        raise InvalidArchive('Invalid browser settings.')
    return manifest


def _insert(conn, table, row):
    columns = list(row)
    return conn.execute(f'INSERT INTO "{table}" ({",".join(chr(34) + c + chr(34) for c in columns)}) '
                        f'VALUES ({",".join("?" for _ in columns)})', [row[c] for c in columns]).lastrowid


def import_archive(username, source):
    """Validate and stage before writing. On failure roll back DB and new files."""
    published = []
    try:
        with zipfile.ZipFile(source) as archive, tempfile.TemporaryDirectory(prefix='easypaper-import-') as temp, closing(db.get_db()) as conn:
            manifest = _read_archive(archive)
            tables = manifest['tables']
            for table, rows in tables.items():
                schema = list(conn.execute(f'PRAGMA table_info("{table}")'))
                columns = {r['name'] for r in schema}
                required = {r['name'] for r in schema if r['pk'] or (r['notnull'] and r['dflt_value'] is None)}
                if any(not required <= set(row) or not set(row) <= columns for row in rows):
                    raise InvalidArchive('Backup uses an unsupported database schema.')
            maps = {}
            for table in ('documents', 'folders', 'document_tasks', 'reparse_previews', 'reading_sessions'):
                mapping = {}
                for row in tables[table]:
                    old = row['id']
                    if not isinstance(old, str) or not SAFE_ID.fullmatch(old) or old in mapping:
                        raise InvalidArchive('Invalid or duplicate identifier.')
                    mapping[old] = uuid.uuid4().hex
                maps[table] = mapping
            docs = maps['documents']
            document_count = len(docs)
            file_sessions = set(docs)

            def map_document_id(old):
                if not isinstance(old, str) or not SAFE_ID.fullmatch(old):
                    raise InvalidArchive('Invalid historical document identifier.')
                if old not in docs:
                    docs[old] = uuid.uuid4().hex
                return docs[old]

            compare = {}
            for row in tables['compare_sessions']:
                old_ids = json.loads(row['doc_ids'])
                if not isinstance(old_ids, list) or not old_ids:
                    raise InvalidArchive('Invalid comparison document list.')
                if not isinstance(row['id'], str) or not SAFE_ID.fullmatch(row['id']) or row['id'] in docs or row['id'] in compare:
                    raise InvalidArchive('Invalid comparison identifier.')
                ids = [map_document_id(doc_id) for doc_id in old_ids]
                compare[row['id']] = 'cmp_' + hashlib.sha256(':'.join(sorted(ids)).encode()).hexdigest()[:20]
                row['doc_ids'] = json.dumps(ids)
            maps['compare_sessions'] = compare
            file_sessions.update(compare)
            sessions = {**docs, **compare}
            # Deleted documents may still have reading history. Give those IDs one
            # consistent mapping without recreating deleted documents.
            for table in USER_TABLES:
                for row in tables[table]:
                    old = row.get('paper_id', row.get('doc_id'))
                    if old and old not in sessions:
                        sessions[old] = map_document_id(old)
            # Validate every file path against IDs declared in the manifest.
            staged = []
            for name, checksum in manifest['files'].items():
                parts = PurePosixPath(name).parts
                if len(parts) < 3 or parts[0] not in ('library', 'uploads', 'cache') or parts[1] not in file_sessions:
                    raise InvalidArchive('Unrecognized document file.')
                label, old = parts[:2]
                new = sessions[old]
                roots = {'library': library.LIBRARY_DIR, 'uploads': library.UPLOAD_DIR, 'cache': cache.CACHE_DIR}
                if label == 'cache':
                    if len(parts) != 3 or not parts[2].startswith('_'):
                        raise InvalidArchive('Invalid cache file.')
                    target = Path(roots[label]) / (new + parts[2])
                else:
                    target = Path(roots[label]) / new / Path(*parts[2:])
                path = Path(temp) / str(len(staged))
                digest = hashlib.sha256()
                with archive.open(name) as src, path.open('wb') as dst:
                    while chunk := src.read(1024 * 1024):
                        digest.update(chunk)
                        dst.write(chunk)
                if digest.hexdigest() != checksum:
                    raise InvalidArchive('Backup file checksum mismatch.')
                staged.append((path, target, label, new))
            for row in tables['documents']:
                filename = 'article/article.json' if row.get('content_kind') == 'html_article' else 'document.pdf'
                if f"library/{row['id']}/{filename}" not in manifest['files']:
                    raise InvalidArchive('Backup is missing an original document.')
            conn.execute('BEGIN IMMEDIATE')
            # Concepts are shared; reuse by normalized name, never replace others' rows.
            maps['concepts'] = {}
            for row in tables['concepts']:
                old = row['id']
                existing = conn.execute('SELECT id FROM concepts WHERE normalized_name=?', (row['normalized_name'],)).fetchone()
                maps['concepts'][old] = existing['id'] if existing else _insert(conn, 'concepts', {k: v for k, v in row.items() if k != 'id'})
            maps['chats'] = {}
            maps['receipts'] = {row['request_id']: uuid.uuid4().hex for row in tables['reading_time_receipts']}
            order = ('documents', 'compare_sessions', 'folders', 'chats', 'document_tasks', 'reading_sessions',
                     *[t for t in TABLES if t not in ('documents', 'compare_sessions', 'folders', 'chats', 'document_tasks', 'reading_sessions', 'concepts')])
            for table in order:
                for original in tables[table]:
                    row = dict(original)
                    old_id = row.get('id')
                    if 'username' in row:
                        row['username'] = username
                    if table in maps and table != 'chats':
                        row['id'] = maps[table][old_id]
                    elif 'id' in row:
                        del row['id']
                    for column, mapping in (
                        ('doc_id', sessions), ('doc_id_a', docs), ('doc_id_b', docs),
                        ('paper_id', docs), ('folder_id', maps['folders']),
                        ('parent_id', maps['folders']), ('task_id', maps['document_tasks']),
                        ('chat_id', maps['chats']), ('answer_message_id', maps['chats']),
                        ('concept_id', maps['concepts']), ('concept_id_a', maps['concepts']),
                        ('concept_id_b', maps['concepts']), ('source_session_id', maps['reading_sessions']),
                    ):
                        if column in row and row[column] is not None:
                            # Historical reading rows can outlive permanently deleted documents.
                            if column in ('paper_id', 'doc_id') and table in USER_TABLES:
                                row[column] = mapping.setdefault(row[column], uuid.uuid4().hex)
                            else:
                                row[column] = mapping[row[column]]
                    if table == 'documents':
                        filename = 'article/article.json' if row.get('content_kind') == 'html_article' else 'document.pdf'
                        row['pdf_path'] = str(Path(library.LIBRARY_DIR) / row['id'] / filename)
                    if table == 'reparse_previews':
                        row['staging_path'] = None
                        row['status'] = 'cancelled'
                    if table in ('document_tasks', 'document_task_pages') and row.get('status') in ('queued', 'running', 'retry_wait'):
                        row['status'] = 'cancelled'
                    if table in ('user_workspace_settings', 'user_language_settings', 'user_reading_profiles'):
                        conn.execute(f'DELETE FROM "{table}" WHERE username=?', (username,))
                    if table == 'reading_time_receipts':
                        row['request_id'] = maps['receipts'][row['request_id']]
                    if table == 'concept_edges':
                        row['concept_id_a'], row['concept_id_b'] = sorted((row['concept_id_a'], row['concept_id_b']))
                        if conn.execute('SELECT 1 FROM concept_edges WHERE concept_id_a=? AND concept_id_b=?', (row['concept_id_a'], row['concept_id_b'])).fetchone():
                            continue
                    inserted = _insert(conn, table, row)
                    if table == 'chats':
                        maps['chats'][old_id] = inserted
            for path, target, label, new in staged:
                root = target if label == 'cache' else Path(library.LIBRARY_DIR if label == 'library' else library.UPLOAD_DIR) / new
                if root not in published:
                    if root.exists():
                        raise InvalidArchive('Import destination already exists.')
                    published.append(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                with path.open('rb') as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
            conn.commit()
            return {'documents': document_count, 'id_map': {**sessions, **maps['folders'], **maps['reading_sessions'], **maps['receipts']},
                    'browser_data': manifest.get('browser_data', {}),
                    'system_settings': {k: v for k, v in manifest.get('system_settings', {}).items() if k in SYSTEM_KEYS and isinstance(v, str)}}
    except Exception as exc:
        for path in reversed(published):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        if isinstance(exc, (KeyError, TypeError, ValueError, sqlite3.IntegrityError, zipfile.BadZipFile, RuntimeError, NotImplementedError)):
            raise InvalidArchive('Invalid or incompatible backup: ' + str(exc)) from exc
        raise


SYSTEM_KEYS = ('ollama_host', 'trans_provider', 'trans_model', 'chat_provider', 'chat_model',
               'default_ai_provider', 'default_ai_model', 'analysis_provider', 'analysis_model',
               'library_provider', 'library_model', 'openalex_mailto', 'pdf_parser_engine',
               'translation_prompt_template')
DOC_STORAGE_PREFIXES = (
    'easypaper_annotations_', 'easypaper_memos_all_hidden_', 'easypaper_memos_',
    'easypaper_chat_quote_images_', 'easypaper_suggested_questions_',
    'easypaper_annotation_sync_queue_annotations_', 'easypaper_annotation_sync_queue_memos_',
    'easypaper_annotation_sync_meta_annotations_', 'easypaper_annotation_sync_meta_memos_',
)


def system_settings():
    import config
    return {key: getattr(config, 'get_' + key)() for key in SYSTEM_KEYS}


def filter_browser_data(data, sessions, username, reading_sessions=()):
    from urllib.parse import quote
    result = {}
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if any(word in key.lower() for word in ('password', 'token', 'secret', 'api_key', 'credential')):
            continue
        prefix = next((p for p in DOC_STORAGE_PREFIXES if key.startswith(p)), None)
        if prefix:
            if key[len(prefix):] in sessions:
                result[key] = value
        elif key.startswith('easypaper_reading_time:'):
            if key.split(':')[1] == quote(username, safe="~()*!.'-"):
                result[key] = value
        elif key.startswith('easypaper_workspace_v1:'):
            if len(key.split(':')) == 4 and key.split(':')[2] == quote(username, safe="~()*!.'-"):
                result[key] = value
        elif key == 'easypaper_library_favorites':
            try:
                result[key] = json.dumps([item for item in json.loads(value) if item in sessions])
            except (ValueError, TypeError):
                pass
        elif key == 'easypaper_reading_heartbeat_offline_queue':
            try:
                result[key] = json.dumps([item for item in json.loads(value)
                                          if (item.get('payload') or item).get('paperId') in sessions
                                          and (item.get('payload') or item).get('sessionId') in reading_sessions])
            except (ValueError, TypeError, AttributeError):
                pass
        elif key.startswith('easypaper_') and key != 'easypaper_annotation_sync_client_id':
            result[key] = value
        elif key in ('trans-pane-width', 'trans-pane-collapsed'):
            result[key] = value
    return result
