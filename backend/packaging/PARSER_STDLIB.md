# Standard library for dynamically installed PDF parsers

Marker and MinerU are installed after the sidecar is frozen. PyInstaller cannot
infer their transitive imports from the backend's build-time dependencies.
`parser_stdlib.py` therefore collects the build interpreter's available standard
library roots and Python package submodules, including extension modules.
Windows builds discover Windows modules; macOS builds discover macOS modules.
Package enumeration does not execute package code.

The collector excludes CPython test fixtures, Tk/IDLE/turtle GUI components, and
`antigravity`/`this`. It retains `unittest` and `unittest.mock`: ML libraries use
these at runtime. This policy covers standard-library dependencies without
bundling the incompatible Marker and MinerU third-party packages together.

## Source audit (2026-10-28)

Inspected wheels: Marker 2.0.0, MinerU 2.7.6 (the supported 2.x series), Surya
0.22.1, pdftext 0.7.1. Also scanned locally available sources for Torch,
Transformers, NumPy, SciPy, scikit-learn, SymPy, Pillow, dill, pdfminer, pypdf,
reportlab, huggingface_hub, modelscope, onnxruntime and torchvision. This source
scan is not a platform-specific dependency resolution or an end-to-end inference
run. Local dependency versions can differ from a user's installed engine.

The AST scan found 186 distinct standard-library import names. Examples:

| Import | Referencing dependency |
| --- | --- |
| `pickletools` | `torch/package/package_exporter.py` |
| `cmath` | `torch/jit/_builtins.py` |
| `xml.dom.minidom` | `sympy/printing/mathml.py`, `pypdf/xmp.py` |
| `unittest.mock` | `torch/_guards.py`, `torch/_functorch/aot_autograd.py` |
| `pdb` | `torch/distributed/__init__.py` |
| `fractions` | Transformers vision model modules |

The Linux Python 3.12 collector returned 600 names. Scan names outside that list
were Windows-only `msvcrt`/`winreg`, excluded `tkinter`/`tkinter.ttk`, and the
non-module aliases `os.path`/`typing.io`. Counts vary by Python and platform.
Computed dynamic imports and native-library dependencies are not proven by an
AST scan; broad stdlib collection avoids relying on that scan as an allowlist.

## Build verification

Both build scripts run the freshly built sidecar with
`--easypaper-check-parser-stdlib`. It imports 21 representative modules before
server startup and fails the build if any import fails. The list covers reported
failures plus serialization, XML, multiprocessing, diagnostics and compression.

Validated locally: collector/worker tests and an actual Linux PyInstaller onedir
executable built with the same collector; all 21 smoke imports passed without
PYTHONPATH/PYTHONHOME. Native Windows/macOS builds and actual Marker/MinerU model
inference still require platform validation. Third-party wheel compatibility,
model downloads and GPU/native runtime dependencies are outside this fix.
