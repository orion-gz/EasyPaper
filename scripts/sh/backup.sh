#!/bin/bash
# SQLite WAL의 커밋도 포함하는 스냅샷으로 DB/library/uploads를 백업한다.
set -e
cd "$(dirname "$0")/../.."
if [ -x backend/.venv/bin/python ]; then
    BACKUP_PYTHON=backend/.venv/bin/python
else
    BACKUP_PYTHON=python3
fi
exec "$BACKUP_PYTHON" scripts/backup_data.py --format tar "$@"
