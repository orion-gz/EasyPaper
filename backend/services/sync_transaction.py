"""Journal file swaps alongside the SQLite synchronization transaction."""
from contextlib import closing
import json
import logging
from pathlib import Path
import shutil
import uuid

from services import data_transfer as transfer, db, library, cache
from services.atomic_io import atomic_write_text
from services import library_sync as sync

logger = logging.getLogger(__name__)


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def restore_journal(path, committed):
    journal = json.loads(path.read_text())
    old = {item['target']: item['backup'] for item in journal['old']}
    if not committed:
        for target in journal['new']:
            # An old target whose backup was never moved is still the original.
            if target not in old or Path(old[target]).exists():
                remove(Path(target))
        for target, backup in old.items():
            backup = Path(backup)
            if backup.exists():
                remove(Path(target))
                backup.rename(target)
    else:
        for backup in old.values():
            remove(Path(backup))
    path.unlink(missing_ok=True)


def recover_transactions():
    root = Path(library.LIBRARY_DIR) / '.sync-transactions'
    if not root.exists():
        return
    sync.ensure_schema()
    with closing(db.get_db()) as conn:
        for path in root.glob('*.json'):
            committed = conn.execute('SELECT 1 FROM library_sync_commits WHERE id=?', (path.stem,)).fetchone()
            restore_journal(path, bool(committed))


class SyncTransaction:
    def __init__(self, username, expected_raw, peer, checkpoint, request_id, request_hash, response_path):
        self.username = username
        self.expected_raw = expected_raw
        self.peer = peer
        self.snapshot = checkpoint
        self.request_id, self.request_hash, self.response_path = request_id, request_hash, response_path
        self.token = uuid.uuid4().hex
        self.journal = None
        self.entries = {}
        self.committed = False
        self.old_documents = set()
        with closing(db.get_db()) as conn:
            self.existing = {(r['kind'], r['sync_id']): r['local_id'] for r in conn.execute(
                'SELECT * FROM library_sync_ids WHERE username=?', (username,))}

    def local_id(self, kind, shared):
        key = (kind, str(shared))
        if key not in self.entries:
            self.entries[key] = self.existing.get(key) or (('cmp_' if kind == 'compare_sessions' else '') + uuid.uuid4().hex)
        return self.entries[key]

    def record(self, kind, shared, local):
        self.entries[(kind, str(shared))] = str(local)

    def begin(self, conn, maps, staged):
        if sync.raw_fingerprint(self.username, conn) != self.expected_raw:
            raise transfer.InvalidArchive('Library changed during synchronization. Retry after current work finishes.')
        current = transfer._snapshot(conn, self.username)
        self.old_documents = {r['id'] for r in current['documents']}
        sessions = self.old_documents | {r['id'] for r in current['compare_sessions']}
        old = []
        for document in sessions:
            if not transfer.SAFE_ID.fullmatch(document):
                raise transfer.InvalidArchive('Invalid local document identifier.')
            paths = [Path(library.LIBRARY_DIR) / document, Path(library.UPLOAD_DIR) / document,
                     *Path(cache.CACHE_DIR).glob(document + '_*')]
            for path in paths:
                if path.is_symlink():
                    raise transfer.InvalidArchive('Cannot synchronize symbolic links.')
                if path.exists():
                    old.append({'target': str(path.resolve()),
                                'backup': str(path.resolve().with_name('.sync-' + self.token + '-' + path.name))})
        new = set()
        for _, target, label, document in staged:
            root = target if label == 'cache' else Path(library.LIBRARY_DIR if label == 'library' else library.UPLOAD_DIR) / document
            new.add(str(root.resolve()))
        owned = {entry['target'] for entry in old}
        if any(Path(path).exists() and path not in owned for path in new):
            raise transfer.InvalidArchive('Synchronization destination belongs to another resource.')
        self.journal = Path(library.LIBRARY_DIR) / '.sync-transactions' / (self.token + '.json')
        self.journal.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(str(self.journal), json.dumps({'old': old, 'new': sorted(new)}))
        # Exact primary keys from this user's snapshot avoid deleting another
        # account's records, even though foreign-key cascades are disabled.
        for table in reversed(transfer.TABLES):
            if table in sync.PREFERENCES or table in ('concepts', 'concept_edges'):
                continue
            keys = [row['name'] for row in conn.execute(f'PRAGMA table_info("{table}")') if row['pk']]
            for row in current[table]:
                clause = ' AND '.join(f'"{key}"=?' for key in keys)
                conn.execute(f'DELETE FROM "{table}" WHERE {clause}', [row[key] for key in keys])
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='document_chunks_fts'").fetchone():
            for document in self.old_documents:
                conn.execute('DELETE FROM document_chunks_fts WHERE doc_id=?', (document,))

    def move_old_files(self):
        for entry in json.loads(self.journal.read_text())['old']:
            Path(entry['target']).rename(entry['backup'])

    def checkpoint(self, conn, maps):
        self.new_documents = set(maps['documents'].values())
        for kind in ('concepts', 'receipts'):
            for shared, local in maps[kind].items():
                self.record(kind, shared, local)
        for (kind, shared), local in self.entries.items():
            conn.execute('DELETE FROM library_sync_ids WHERE username=? AND kind=? AND (local_id=? OR sync_id=?)',
                         (self.username, kind, local, shared))
            conn.execute('INSERT INTO library_sync_ids VALUES (?,?,?,?)', (self.username, kind, local, shared))
        sync.save_checkpoint(conn, self.username, self.peer, self.snapshot,
                             self.request_id, self.request_hash, self.response_path)
        conn.execute('INSERT INTO library_sync_commits VALUES (?)', (self.token,))

    def finish(self):
        self.committed = True
        # Failures after commit are cleanup failures, never a reason to remove
        # newly committed files. The next startup completes journal cleanup.
        try:
            restore_journal(self.journal, True)
        except Exception:
            logger.exception('Synchronization committed; deferred backup cleanup')
        try:
            from routers.upload import sessions
            from services.document_workers import _deleted
            from services.cache import clear_session_cache
            for document in self.old_documents:
                sessions.pop(document, None)
                clear_session_cache(document)
            for document in self.new_documents:
                _deleted.discard((db.DB_PATH, document))
        except Exception:
            logger.exception('Synchronization committed; session cache cleanup failed')

    def rollback(self):
        if not self.committed and self.journal and self.journal.exists():
            restore_journal(self.journal, False)
