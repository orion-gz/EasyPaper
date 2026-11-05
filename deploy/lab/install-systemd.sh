#!/usr/bin/env bash
# Fresh Ubuntu 24.04 installation. Run from a cloned EasyPaper checkout.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash deploy/lab/install-systemd.sh' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Requires Ubuntu 24.04.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ ! -e /opt/easypaper && ! -e /etc/systemd/system/easypaper-lab.service ]] || { echo 'Existing installation found; refusing to overwrite it.' >&2; exit 1; }
apt-get update
apt-get install -y python3 python3-venv python3-dev build-essential curl ca-certificates rsync tesseract-ocr tesseract-ocr-all
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  setup_file=$(mktemp)
  trap 'rm -f "$setup_file"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup_file"
  bash "$setup_file"
  apt-get install -y nodejs
fi
id easypaper >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/easypaper --shell /usr/sbin/nologin easypaper
install -d -o easypaper -g easypaper -m 700 /var/lib/easypaper
install -d /opt/easypaper
rsync -a --exclude=.git --exclude=node_modules --exclude=.venv --exclude=venv --exclude=.env --exclude=lab-data --exclude=worktrees --exclude=library --exclude=uploads --exclude=cache --exclude='*.db' "$source_dir/" /opt/easypaper/
python3 -m venv /opt/easypaper/venv
/opt/easypaper/venv/bin/pip install -r /opt/easypaper/backend/requirements.txt
(cd /opt/easypaper/frontend && npm ci && npm run build)
install -m 644 /opt/easypaper/deploy/lab/easypaper-lab.service /etc/systemd/system/easypaper-lab.service
systemctl daemon-reload
systemctl enable --now easypaper-lab.service
systemctl --no-pager status easypaper-lab.service
