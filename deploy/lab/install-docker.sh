#!/usr/bin/env bash
# Ubuntu 24.04: install Docker when absent, then deploy the Lab application.
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
lock_file=/run/lock/easypaper-lab-docker-install.lock

require_supported_host() {
  [[ $EUID -eq 0 ]] || { echo 'Run with sudo bash deploy/lab/install-docker.sh' >&2; return 1; }
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Requires Ubuntu 24.04.' >&2; return 1; }
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || { echo 'Requires a host booted with systemd.' >&2; return 1; }
}

install_docker() (
  set -euo pipefail
  require_supported_host
  if [[ -e /var/lib/easypaper-deployment/docker.json ]]; then
    echo 'This deployment is managed by update.sh. Use sudo bash deploy/lab/update.sh --deployment docker.' >&2
    exit 1
  fi
  exec 9>"$lock_file"
  flock -n 9 || { echo 'Another Docker installation is running.' >&2; exit 1; }
  cd "$source_dir"

  # Do not mix Ubuntu packages with an existing vendor-managed Docker install.
  local fresh_docker=false
  if command -v docker >/dev/null; then
    docker compose version >/dev/null || {
      echo 'Docker exists but Compose v2 is unavailable. Install its matching Compose plugin, then rerun.' >&2
      exit 1
    }
    docker info >/dev/null || {
      echo 'Cannot access the existing Docker daemon. Start it or fix access, then rerun.' >&2
      exit 1
    }
  else
    fresh_docker=true
  fi
  apt-get update
  apt-get install -y python3 curl ca-certificates
  if [[ $fresh_docker == true ]]; then
    apt-get install -y docker.io docker-compose-v2
    systemctl enable --now docker
  fi
  docker compose version >/dev/null
  docker info >/dev/null
  local compose=(docker compose -f "$source_dir/docker-compose.lab.yml")
  local app_user
  # Resolve .env and environment overrides through Compose itself.
  app_user=$("${compose[@]}" config --format json | python3 -c '
import json, re, sys
user = json.load(sys.stdin)["services"]["easypaper"]["user"]
if not re.fullmatch(r"[0-9]+:[0-9]+", user) or any(int(x) == 0 for x in user.split(":")):
    sys.exit("LAB_APP_UID and LAB_APP_GID must be nonzero numeric IDs")
print(user)
')
  echo 'Building EasyPaper…'
  "${compose[@]}" build easypaper
  echo 'Preparing data directories…'
  # Preserve existing files and their ownership; only prepare the two directories.
  "${compose[@]}" run --rm --no-deps --user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint sh easypaper \
    -c 'mkdir -p /data/home && chown "$1" /data /data/home' sh "$app_user"
  echo 'Starting EasyPaper…'
  "${compose[@]}" up -d --wait --wait-timeout 180 easypaper
  echo 'EasyPaper is ready at http://127.0.0.1:8000.'
  echo 'Next: configure inference and access using the Lab installation guide.'
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  install_docker
fi
