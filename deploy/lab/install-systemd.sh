#!/usr/bin/env bash
# Fresh Ubuntu 24.04 installation; interrupted installations can be resumed.
set -euo pipefail

app_dir=/opt/easypaper
state_dir=/var/lib/easypaper
unit_file=/etc/systemd/system/easypaper-lab.service
lock_file=/run/lock/easypaper-lab-install.lock
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

supported_node() {
  command -v node >/dev/null && command -v npm >/dev/null &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'
}

require_supported_host() {
  [[ $EUID -eq 0 ]] || { echo 'Run with sudo bash deploy/lab/install-systemd.sh' >&2; return 1; }
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Requires Ubuntu 24.04.' >&2; return 1; }
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || { echo 'Requires a host booted with systemd (not a plain Docker container).' >&2; return 1; }
}

install_systemd() (
  set -euo pipefail
  require_supported_host
  exec 9>"$lock_file"
  flock -n 9 || { echo 'Another EasyPaper installation is running.' >&2; exit 1; }
  local pending="$app_dir/.lab-installing"
  local template="$source_dir/deploy/lab/easypaper-lab.service"
  if [[ -e $app_dir || -L $app_dir || -e $unit_file || -L $unit_file ]]; then
    # Only an unfinished installation owned by this installer may be resumed.
    if [[ -L $app_dir || ! -f $pending || -L $pending || -L $unit_file ]] ||
       { [[ -e $unit_file ]] && ! cmp -s "$template" "$unit_file"; }; then
      echo 'Existing installation found; refusing to overwrite it.' >&2
      exit 1
    fi
  else
    install -d -m 755 "$app_dir"
    install -m 600 /dev/null "$pending"
  fi
  trap 'echo "Installation interrupted. Fix the reported error, then rerun: sudo bash deploy/lab/install-systemd.sh" >&2' ERR
  # Stop only the service registered by this unfinished installation.
  if [[ -e $unit_file ]]; then systemctl stop easypaper-lab.service; fi
  apt-get update
  apt-get install -y python3 python3-venv python3-dev build-essential curl ca-certificates rsync tesseract-ocr tesseract-ocr-all
  if ! supported_node; then
    local setup_file
    setup_file=$(mktemp)
    trap 'rm -f "${setup_file:-}"' EXIT
    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup_file"
    bash "$setup_file"
    apt-get install -y nodejs
  fi
  supported_node || { echo 'Node.js 22.13+ and npm are required. Check the node executable on PATH.' >&2; exit 1; }
  id easypaper >/dev/null 2>&1 || useradd --system --user-group --home-dir "$state_dir" --shell /usr/sbin/nologin easypaper
  install -d -o easypaper -g easypaper -m 700 "$state_dir"
  rsync -a --chown=root:root --exclude=.git --exclude=node_modules --exclude=.venv --exclude=venv --exclude=.env --exclude=.lab-installing --exclude=lab-data --exclude=worktrees --exclude=library --exclude=uploads --exclude=cache --exclude='*.db' "$source_dir/" "$app_dir/"
  python3 -m venv "$app_dir/venv"
  "$app_dir/venv/bin/pip" install -r "$app_dir/backend/requirements.txt"
  (cd "$app_dir/frontend" && npm ci && npm run build)
  install -m 644 "$template" "$unit_file"
  systemctl daemon-reload
  systemctl enable --now easypaper-lab.service
  # Type=simple can report active before Python has finished importing the app.
  if ! curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 3 --max-time 5 http://127.0.0.1:8000/ >/dev/null; then
    journalctl -u easypaper-lab.service --no-pager -n 30 >&2 || true
    exit 1
  fi
  systemctl is-active --quiet easypaper-lab.service
  rm -f "$pending"
  echo 'EasyPaper is ready at http://127.0.0.1:8000. Persistent data: /var/lib/easypaper'
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  install_systemd
fi
