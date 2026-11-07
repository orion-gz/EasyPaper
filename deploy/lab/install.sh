#!/usr/bin/env bash
# Install the shared EasyPaper application using the Lab Compose configuration.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"

for tool in docker python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Required tool missing: $tool" >&2; exit 1; }
done
docker compose version >/dev/null
docker info >/dev/null
compose=(docker compose -f "$project_dir/docker-compose.lab.yml")

# Resolve .env and environment overrides exactly as Compose does.
app_user="$("${compose[@]}" config --format json | python3 -c '
import json, re, sys
user = json.load(sys.stdin)["services"]["easypaper"]["user"]
if not re.fullmatch(r"[0-9]+:[0-9]+", user) or any(int(x) == 0 for x in user.split(":")):
    sys.exit("LAB_APP_UID and LAB_APP_GID must be nonzero numeric IDs")
print(user)
')"

printf 'Building EasyPaper…\n'
"${compose[@]}" build easypaper
printf 'Preparing data directories…\n'
# Only change the two application directories, never recursively rewrite data.
"${compose[@]}" run --rm --no-deps --user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint sh easypaper \
    -c 'mkdir -p /data/home && chown "$1" /data /data/home' sh "$app_user"
printf 'Starting EasyPaper…\n'
"${compose[@]}" up -d easypaper
printf '\nEasyPaper started at http://127.0.0.1:8000\n'
printf 'Next: configure HTTPS, sign in as administrator, and configure Settings → Lab Mode.\n'
printf 'Inference servers and the optional personal CLI runner are configured separately.\n'
