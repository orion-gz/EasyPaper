"""Fail closed when multiple application processes share one Lab database.

The scheduler intentionally runs in one process. OS locks are released on crash;
no PID-file deletion or stale-lock timeout can create two scheduler owners.
"""
import os
import threading
from pathlib import Path

from fastapi import HTTPException

_handles = {}
_mutex = threading.Lock()


def ensure_owner():
    from services import db
    path = str(Path(db.DB_PATH).resolve()) + '.lab-runtime.lock'
    with _mutex:
        existing = _handles.get(path)
        if existing and existing[0] == os.getpid():
            return
        if existing:
            existing[1].close()
            del _handles[path]
        handle = open(path, 'a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise HTTPException(503, 'Lab Mode requires one backend worker per database. Stop duplicate workers and retry.')
        _handles[path] = (os.getpid(), handle)


def release_owner():
    from services import db
    path = str(Path(db.DB_PATH).resolve()) + '.lab-runtime.lock'
    with _mutex:
        entry = _handles.pop(path, None)
        if entry:
            entry[1].close()
