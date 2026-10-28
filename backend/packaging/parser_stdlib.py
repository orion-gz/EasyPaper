"""Collect the installed interpreter's stdlib for post-build parser installs.

Do not import packages while enumerating them: some stdlib modules open a
browser or start a GUI. Platform-specific extensions come from find_spec on
this build interpreter, never from a list generated on another platform.
"""
import importlib.util
from pathlib import Path
import sys

# Desktop parsers do not provide a Python IDE or Tk GUI. Excluding these avoids
# shipping Tcl/Tk and CPython's test suites; unittest itself remains included.
_EXCLUDED = {"antigravity", "this", "idlelib", "tkinter", "turtle", "turtledemo",
             "_tkinter", "test", "_testcapi", "_testinternalcapi", "_testbuffer",
             "_testmultiphase", "_testimportmultiple", "_xxtestfuzz"}


def parser_stdlib_modules():
    modules = set()
    for name in sorted(sys.stdlib_module_names - _EXCLUDED):
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            continue
        if spec is None:
            continue  # e.g. winreg on macOS, or fcntl on Windows
        modules.add(name)
        for location in spec.submodule_search_locations or ():
            root = Path(location)
            for source in root.rglob("*.py"):
                relative = source.relative_to(root)
                if any(part in {"test", "tests", "__pycache__"} for part in relative.parts):
                    continue
                parts = list(relative.with_suffix("").parts)
                if parts[-1] == "__init__":
                    parts.pop()
                if all(part.isidentifier() for part in parts):
                    modules.add(".".join([name, *parts]))
    return sorted(modules)
