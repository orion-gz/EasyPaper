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
    print(f"Parser stdlib smoke check passed ({len(MODULES)} modules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
