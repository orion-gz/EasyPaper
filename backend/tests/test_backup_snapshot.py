import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import zipfile

import pytest


@pytest.mark.parametrize('archive_format', ['zip', 'tar'])
def test_online_backup_includes_wal_and_restores_backend_layout(tmp_path, archive_format):
    database = tmp_path / 'source.db'
    source = sqlite3.connect(database)
    try:
        source.execute('PRAGMA journal_mode=WAL')
        source.execute('CREATE TABLE documents (content TEXT)')
        source.commit()
        source.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        source.execute("INSERT INTO documents VALUES ('latest committed memo')")
        source.commit()
        assert Path(str(database) + '-wal').stat().st_size > 0
        library = tmp_path / 'library'; library.mkdir()
        (library / 'article.txt').write_text('saved document')
        output = tmp_path / 'backups'
        script = Path(__file__).resolve().parents[2] / 'scripts/backup_data.py'
        subprocess.run([sys.executable, str(script), '--format', archive_format, '--output', str(output)], check=True,
                       env={**os.environ, 'DB_PATH': str(database), 'LIBRARY_DIR': str(library), 'UPLOAD_DIR': str(tmp_path / 'missing')})
        archive = next(output.iterdir())
        restored = tmp_path / 'restored'
        if archive_format == 'zip':
            with zipfile.ZipFile(archive) as handle:
                handle.extractall(restored)
        else:
            with tarfile.open(archive) as handle:
                handle.extractall(restored, filter='data')
        with sqlite3.connect(restored / 'backend/easypaper.db') as snapshot:
            assert snapshot.execute('SELECT content FROM documents').fetchall() == [('latest committed memo',)]
        assert (restored / 'backend/library/article.txt').read_text() == 'saved document'
    finally:
        source.close()
