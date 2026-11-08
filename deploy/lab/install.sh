#!/usr/bin/env bash
# Explicit deployment selection; never silently assume Docker.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $# -ne 1 ]]; then
  echo 'Usage: sudo bash deploy/lab/install.sh {docker|systemd}' >&2
  exit 2
fi
case "$1" in
  docker|systemd) exec bash "$script_dir/install-$1.sh" ;;
  *) echo 'Choose docker or systemd.' >&2; exit 2 ;;
esac
