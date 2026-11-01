"""Versioned, account-scoped, three-way library synchronization.

Wire IDs are independent of SQLite row IDs. Checkpoints contain the last common
snapshot, so removals propagate and repeated transfers do not create copies.
Conflicts stop the exchange before either library is changed.
"""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import uuid
import zipfile

from services import data_transfer as transfer, db

PROTOCOL = 1
PREFERENCES = {'user_workspace_settings', 'user_language_settings', 'user_reading_profiles'}
NATURAL_KEYS = {
    'translations': ('doc_id', 'page_num', 'suffix', 'content_revision'),
    'page_insights': ('doc_id', 'page_num', 'kind', 'suffix', 'content_revision'),
    'paper_concepts': ('doc_id', 'concept_id'),
    'paper_edges': ('doc_id_a', 'doc_id_b', 'edge_type'),
    'question_papers': ('chat_id', 'doc_id'),
    'question_concepts': ('chat_id', 'concept_id'),
    'concept_edges': ('concept_id_a', 'concept_id_b'),
    'reading_time': ('doc_id', 'day', 'category'),
}
KEYS = {
    'annotations': ('doc_id',), 'memos': ('doc_id',),
    'parsing_diagnostics': ('doc_id', 'content_revision'),
    'document_task_pages': ('task_id', 'page_num'),
    'annotation_mutations': ('resource', 'doc_id', 'client_id', 'mutation_id'),
    'document_folders': ('doc_id',), 'reading_time_receipts': ('request_id',),
    'reading_page_evidence': ('paper_id', 'page_number'), 'paper_reading_stats': ('paper_id',),
}
REFERENCES = {
    'doc_id': 'documents', 'doc_id_a': 'documents', 'doc_id_b': 'documents', 'paper_id': 'documents',
    'folder_id': 'folders', 'parent_id': 'folders', 'task_id': 'document_tasks',
    'chat_id': 'chats', 'answer_message_id': 'chats', 'concept_id': 'concepts',
    'concept_id_a': 'concepts', 'concept_id_b': 'concepts', 'source_session_id': 'reading_sessions',
    'request_id': 'receipts',
}


class SyncConflict(transfer.InvalidArchive):
    def __init__(self, conflicts):
        self.conflicts = conflicts[:50]
        super().__init__('Conflicting changes require a decision before this library can be updated.')


def dumps(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def content(manifest):
    tables = dict(manifest['tables'])
    # Shared concept labels/timestamps are installation-wide display metadata,
    # not account-owned edits. Their canonical identities carry the relations.
    for table in ('concepts', 'concept_edges'):
        tables[table] = [comparable(table, row) for row in tables[table]]
    return {'tables': tables, 'files': manifest['files']}


def comparable(table, row):
    if row is None:
        return None
    ignored = {'created_at', 'name'} if table == 'concepts' else {'created_at'} if table == 'concept_edges' else set()
    return {key: value for key, value in row.items() if key not in ignored}


def fingerprint(manifest):
    return digest(content(manifest))


def ensure_schema():
    with closing(db.get_db()) as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS library_sync_ids (
                username TEXT NOT NULL, kind TEXT NOT NULL, local_id TEXT NOT NULL, sync_id TEXT NOT NULL,
                PRIMARY KEY(username,kind,local_id), UNIQUE(username,kind,sync_id));
            CREATE TABLE IF NOT EXISTS library_sync_accounts (username TEXT PRIMARY KEY, id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS library_sync_peers (
                username TEXT NOT NULL, peer TEXT NOT NULL, revision TEXT NOT NULL, manifest TEXT NOT NULL,
                request_id TEXT, request_hash TEXT, response_path TEXT,
                PRIMARY KEY(username,peer));
            CREATE TABLE IF NOT EXISTS library_sync_commits (id TEXT PRIMARY KEY);
        ''')


def account_id(username):
    ensure_schema()
    with closing(db.get_db()) as conn:
        conn.execute('INSERT OR IGNORE INTO library_sync_accounts VALUES (?,?)', (username, uuid.uuid4().hex))
        result = conn.execute('SELECT id FROM library_sync_accounts WHERE username=?', (username,)).fetchone()[0]
        conn.commit()
        return result


def peer_state(username, peer):
    ensure_schema()
    with closing(db.get_db()) as conn:
        row = conn.execute('SELECT * FROM library_sync_peers WHERE username=? AND peer=?', (username, peer)).fetchone()
        if not row:
            return None
        result = dict(row)
        result['manifest'] = json.loads(result['manifest'])
        return result


class CanonicalExport:
    def __init__(self, username):
        self.username = username
        self.ids = {}
        self.comparisons = set()

    def prepare(self, tables):
        ensure_schema()
        self.comparisons = {r['id'] for r in tables['compare_sessions']}
        with closing(db.get_db()) as conn:
            self.ids = {(r['kind'], r['local_id']): r['sync_id'] for r in conn.execute(
                'SELECT * FROM library_sync_ids WHERE username=?', (self.username,))}
            for table, rows in tables.items():
                for row in rows:
                    if 'id' in row:
                        if table == 'concepts':
                            self.ids[(table, str(row['id']))] = uuid.uuid5(uuid.NAMESPACE_URL, 'easypaper-concept:' + row['normalized_name']).hex
                        else:
                            self.identity(table, row['id'])
                    for column, kind in REFERENCES.items():
                        if row.get(column) is not None:
                            self.identity(kind, row[column])
                    if table == 'compare_sessions':
                        for doc in json.loads(row['doc_ids']):
                            self.identity('documents', doc)
            for (kind, local), shared in self.ids.items():
                conn.execute('INSERT OR REPLACE INTO library_sync_ids VALUES (?,?,?,?)', (self.username, kind, local, shared))
            conn.commit()

    def identity(self, kind, value):
        if kind == 'documents' and value in self.comparisons:
            kind = 'compare_sessions'
        return self.ids.setdefault((kind, str(value)), uuid.uuid4().hex)

    def file_name(self, name):
        label, document, rest = name.split('/', 2)
        return f'{label}/{self.identity("documents", document)}/{rest}'

    def include_file(self, name):
        # Machine-specific parser/translation caches are regenerated from the
        # original and synchronized database, rather than treated as user edits.
        return not name.startswith('cache/')

    def transform(self, manifest):
        for table, rows in manifest['tables'].items():
            if table in PREFERENCES or table == 'reparse_previews':
                manifest['tables'][table] = []
                continue
            for row in rows:
                if 'username' in row:
                    row['username'] = 'sync-account'
                if 'id' in row:
                    row['id'] = self.identity(table, row['id'])
                for column, kind in REFERENCES.items():
                    if row.get(column) is not None:
                        row[column] = self.identity(kind, row[column])
                if table == 'concept_edges':
                    row['concept_id_a'], row['concept_id_b'] = sorted((row['concept_id_a'], row['concept_id_b']))
                if table in NATURAL_KEYS:
                    row['id'] = uuid.uuid5(uuid.NAMESPACE_URL, table + ':' + dumps([row[k] for k in NATURAL_KEYS[table]])).hex
                if table == 'compare_sessions':
                    row['doc_ids'] = dumps([self.identity('documents', doc) for doc in json.loads(row['doc_ids'])])
                if table == 'page_insights':
                    row['content'] = transfer._remap_insight_references(row['kind'], row['content'],
                        {local: shared for (kind, local), shared in self.ids.items() if kind == 'documents'})
            rows.sort(key=lambda row: record_key(table, row))
        manifest.update(exported_at='', browser_data={}, system_settings={})
        manifest['sync'] = {'protocol': PROTOCOL, 'account': account_id(self.username)}
        return manifest


def export_snapshot(username, destination):
    transfer.export_archive(username, {}, destination, sync_export=CanonicalExport(username))
    return read_snapshot(destination)


def read_snapshot(source):
    with zipfile.ZipFile(source) as archive:
        manifest = transfer._read_archive(archive)
        meta = manifest.get('sync', {})
        if meta.get('protocol') != PROTOCOL or not transfer.SAFE_ID.fullmatch(str(meta.get('account', ''))):
            raise transfer.InvalidArchive('Unsupported synchronization snapshot.')
        # Verify every checksum before a merge can select only a subset of files.
        for name, checksum in manifest['files'].items():
            hasher = hashlib.sha256()
            with archive.open(name) as stream:
                while chunk := stream.read(1024 * 1024):
                    hasher.update(chunk)
            if hasher.hexdigest() != checksum:
                raise transfer.InvalidArchive('Synchronization file checksum mismatch.')
        return manifest


def record_key(table, row):
    return dumps([row[k] for k in KEYS.get(table, ('id',))])


def index_rows(table, rows):
    result = {}
    for row in rows:
        key = record_key(table, row)
        if key in result:
            raise transfer.InvalidArchive('Duplicate synchronization record.')
        result[key] = row
    return result


def merge_snapshots(base, local, remote):
    """Three-way record merge. Concurrent edits/deletion-vs-edit stop safely."""
    result = copy.deepcopy(remote)
    conflicts = []
    base = base or {'tables': {table: [] for table in transfer.TABLES}, 'files': {}}
    for table in transfer.TABLES:
        b, l, r = (index_rows(table, m['tables'][table]) for m in (base, local, remote))
        merged = {}
        for key in sorted(b.keys() | l.keys() | r.keys()):
            before, left, right = b.get(key), l.get(key), r.get(key)
            if table in ('concepts', 'concept_edges'):
                value = right or left
            elif comparable(table, left) == comparable(table, right) or comparable(table, right) == comparable(table, before):
                value = left
            elif comparable(table, left) == comparable(table, before):
                value = right
            else:
                conflicts.append({'table': table, 'key': key})
                continue
            if value is not None:
                merged[key] = value
        result['tables'][table] = list(merged.values())
    result['files'] = {}
    for name in sorted(base['files'].keys() | local['files'].keys() | remote['files'].keys()):
        b, l, r = (m['files'].get(name) for m in (base, local, remote))
        if l == r or r == b:
            value = l
        elif l == b:
            value = r
        else:
            conflicts.append({'table': 'files', 'key': name})
            continue
        if value is not None:
            result['files'][name] = value
    # Parent deletion concurrent with changes to dependent data is a conflict,
    # not permission to silently drop notes, translations or original files.
    docs = {r['id'] for r in result['tables']['documents']}
    comparisons = {r['id'] for r in result['tables']['compare_sessions']}
    folders = {r['id'] for r in result['tables']['folders']}
    for table in transfer.DOC_TABLES:
        for row in result['tables'][table]:
            if row['doc_id'] not in (docs | comparisons if table == 'chats' else docs):
                conflicts.append({'table': table, 'key': row['doc_id']})
    for table in ('folders', 'document_folders'):
        for row in result['tables'][table]:
            parent = row.get('parent_id' if table == 'folders' else 'folder_id')
            if parent and parent not in folders:
                conflicts.append({'table': table, 'key': parent})
    for name in result['files']:
        if name.split('/')[1] not in docs | comparisons:
            conflicts.append({'table': 'files', 'key': name})
    if conflicts:
        raise SyncConflict(conflicts)
    return result


def write_snapshot(manifest, sources, destination):
    """Assemble a merged ZIP from verified source ZIPs without loading blobs."""
    opened = []
    try:
        inventories = []
        for source in sources:
            archive = zipfile.ZipFile(source)
            opened.append(archive)
            inventories.append((archive, json.loads(archive.read('manifest.json'))['files']))
        with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as target:
            for name, checksum in manifest['files'].items():
                source = next((a for a, files in inventories if files.get(name) == checksum), None)
                if source is None:
                    raise transfer.InvalidArchive('Missing synchronization file.')
                with source.open(name) as reader, target.open(name, 'w', force_zip64=True) as writer:
                    shutil.copyfileobj(reader, writer, length=1024 * 1024)
            payload = dumps(manifest).encode()
            if len(payload) > transfer.MAX_MANIFEST_BYTES:
                raise transfer.InvalidArchive('Synchronization manifest is too large.')
            target.writestr('manifest.json', payload)
        if Path(destination).stat().st_size > transfer.MAX_ARCHIVE_BYTES:
            raise transfer.InvalidArchive('Synchronization archive exceeds 4 GiB.')
        read_snapshot(destination)
    finally:
        for archive in opened:
            archive.close()


def save_checkpoint(conn, username, peer, manifest, request_id='', request_hash='', response_path=''):
    conn.execute('INSERT OR REPLACE INTO library_sync_peers VALUES (?,?,?,?,?,?,?)',
                 (username, peer, manifest['sync']['revision'], dumps(manifest), request_id, request_hash, str(response_path)))


def storage_root():
    from config import _get_config_dir
    root = Path(_get_config_dir()) / 'library-sync'
    root.mkdir(parents=True, exist_ok=True)
    return root


def raw_fingerprint(username, conn=None):
    if conn is not None:
        return digest(transfer._snapshot(conn, username))
    with closing(db.get_db()) as connection:
        return digest(transfer._snapshot(connection, username))


def apply_snapshot(username, source, expected_raw, *, peer, checkpoint, request_id='', request_hash='', response_path=''):
    from services.sync_transaction import SyncTransaction
    ensure_schema()
    context = SyncTransaction(username, expected_raw, peer, checkpoint, request_id, request_hash, response_path)
    return transfer.import_archive(username, source, preserve_user_settings=True, sync_context=context)


def exchange(username, incoming, destination_dir):
    """Commit a server merge and retain its exact response for safe retries."""
    local = read_snapshot(incoming)
    meta = local['sync']
    peer, request_id = meta['account'], meta.get('request_id', '')
    if meta.get('expected_account') and meta['expected_account'] != account_id(username):
        raise transfer.InvalidArchive('The signed-in server account changed. Preview again.')
    if not transfer.SAFE_ID.fullmatch(request_id) or len(request_id) > 80:
        raise transfer.InvalidArchive('Invalid synchronization request ID.')
    policy = meta.get('policy', 'merge')
    if policy not in ('merge', 'replace_local', 'replace_remote'):
        raise transfer.InvalidArchive('Invalid synchronization action.')
    request_hash = digest({'content': content(local), 'control': meta})
    previous = peer_state(username, peer)
    if previous and previous['request_id'] == request_id:
        if previous['request_hash'] != request_hash:
            raise transfer.InvalidArchive('A retry must contain the original synchronization request.')
        response = Path(previous['response_path'])
        if not response.is_file():
            raise transfer.InvalidArchive('The saved synchronization response is unavailable.')
        return response
    if policy == 'merge' and meta.get('baseline', '') != (previous['revision'] if previous else ''):
        raise SyncConflict([{'table': 'checkpoint', 'key': 'stale'}])
    with tempfile.TemporaryDirectory(prefix='easypaper-sync-server-') as temp:
        current_path = Path(temp) / 'current.zip'
        current = export_snapshot(username, current_path)
        expected_raw = raw_fingerprint(username)
        if policy != 'merge' and meta.get('expected_remote') != fingerprint(current):
            raise SyncConflict([{'table': 'confirmation', 'key': 'server changed since preview'}])
        if policy == 'replace_local':
            merged = copy.deepcopy(current)
        elif policy == 'replace_remote':
            merged = copy.deepcopy(local)
        else:
            merged = merge_snapshots(previous['manifest'] if previous else None, local, current)
        merged['sync'] = {'protocol': PROTOCOL, 'account': account_id(username), 'revision': uuid.uuid4().hex,
                          'request_id': request_id}
        root = Path(destination_dir)
        root.mkdir(parents=True, exist_ok=True)
        response = root / (digest([username, peer]) + '-' + request_id + '.zip')
        write_snapshot(merged, [incoming, current_path], response)
        try:
            if fingerprint(merged) == fingerprint(current):
                with closing(db.get_db()) as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    if raw_fingerprint(username, conn) != expected_raw:
                        raise SyncConflict([{'table': 'library', 'key': 'changed during exchange'}])
                    save_checkpoint(conn, username, peer, merged, request_id, request_hash, response)
                    conn.commit()
            else:
                apply_snapshot(username, response, expected_raw, peer=peer, checkpoint=merged,
                               request_id=request_id, request_hash=request_hash, response_path=response)
        except Exception:
            response.unlink(missing_ok=True)
            raise
    if previous and previous.get('response_path') and previous['response_path'] != str(response):
        try:
            Path(previous['response_path']).unlink(missing_ok=True)
        except OSError:
            pass  # A stale retry archive must not turn a committed sync into an error.
    return response
