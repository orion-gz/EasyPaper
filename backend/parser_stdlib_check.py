"""Model-free import check run by the freshly frozen sidecar."""
import importlib

MODULES = (
    "pickletools", "cmath", "xml.dom.minidom", "xml.sax", "xml.etree.ElementTree",
    "multiprocessing.shared_memory", "multiprocessing.pool", "concurrent.futures",
    "unittest.mock", "pdb", "code", "fractions", "decimal", "dbm.dumb",
    "sqlite3", "ctypes", "bz2", "lzma", "gzip", "zipfile", "tarfile",
)


def main():
    for name in MODULES:
        importlib.import_module(name)
    # Exercise actual spawn and resource tracking, not just module imports.
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing
    from multiprocessing.shared_memory import SharedMemory
    import operator

    memory = SharedMemory(create=True, size=1)
    try:
        with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn")) as pool:
            assert pool.submit(operator.abs, -7).result(timeout=30) == 7
    finally:
        memory.close()
        memory.unlink()
    print(f"Parser stdlib smoke check passed ({len(MODULES)} modules)")
    return 0


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    raise SystemExit(main())
