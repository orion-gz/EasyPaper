"""Create a portable backup using SQLite's online backup API."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def create_backup(destination: Path, *, db_path: Path, library: Path, uploads: Path, archive_format: str) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    name = 'easypaper_backup_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')
    extension = '.zip' if archive_format == 'zip' else '.tar.gz'
    archive = destination / (name + extension)
    partial = destination / (name + extension + '.part')
    if not any(path.exists() for path in (db_path, library, uploads)):
        raise FileNotFoundError('No database, library or uploads to back up.')
    try:
        with tempfile.TemporaryDirectory(prefix='easypaper-backup-') as directory:
            staged = Path(directory) / 'backend'
            staged.mkdir()
            if db_path.exists():
                source = sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro', uri=True)
                target = sqlite3.connect(staged / 'easypaper.db')
                try:
                    source.backup(target)
                    if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Database snapshot failed integrity validation.')
                finally:
                    target.close()
                    source.close()
            for source, name in ((library, 'library'), (uploads, 'uploads')):
                if source.exists():
                    shutil.copytree(source, staged / name)
            if archive_format == 'zip':
                with zipfile.ZipFile(partial, 'w', zipfile.ZIP_DEFLATED) as output:
                    for path in staged.rglob('*'):
                        output.write(path, path.relative_to(directory))
            else:
                with tarfile.open(partial, 'w:gz') as output:
                    output.add(staged, arcname='backend')
            os.replace(partial, archive)
        return archive
    finally:
        partial.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--format', choices=('zip', 'tar'), default='tar')
    parser.add_argument('--output', type=Path, default=ROOT / 'backups')
    parser.add_argument('--keep', type=int, default=int(os.getenv('EASYPAPER_BACKUP_KEEP', '10')))
    args = parser.parse_args()
    if args.keep < 1:
        parser.error('--keep must be at least 1')
    result = create_backup(
        args.output,
        db_path=Path(os.getenv('DB_PATH', ROOT / 'backend/easypaper.db')),
        library=Path(os.getenv('LIBRARY_DIR', ROOT / 'backend/library')),
        uploads=Path(os.getenv('UPLOAD_DIR', ROOT / 'backend/uploads')),
        archive_format=args.format,
    )
    extension = '*.zip' if args.format == 'zip' else '*.tar.gz'
    backups = sorted(args.output.glob('easypaper_backup_' + extension), key=lambda path: path.name, reverse=True)
    for old in backups[args.keep:]:
        old.unlink()
    print(f'Backup complete: {result}')


if __name__ == '__main__':
    main()
