#!/bin/sh
# Run explicitly as the host operator. Never called by the web application.
set -eu
runtime=${1:?Usage: build-cli-runtime.sh docker|systemd claude_code|codex OUTPUT}
provider=${2:?Missing provider}
output=${3:?Missing image tag or new absolute rootfs directory}
case "$provider" in
  claude_code) package='@anthropic-ai/claude-code@2.1.311' ;;
  codex) package='@openai/codex@0.165.0' ;;
  *) echo 'Supported build profiles: claude_code, codex' >&2; exit 2 ;;
esac
case "$runtime" in
  docker)
    script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    exec docker build --build-arg "CLI_PACKAGE=$package" -f "$script_dir/Dockerfile.cli" -t "$output" "$script_dir"
    ;;
  systemd)
    test "$(id -u)" = 0 || { echo 'Root is required to prepare a root filesystem.' >&2; exit 2; }
    case "$output" in /*) ;; *) echo 'Use an absolute rootfs path.' >&2; exit 2 ;; esac
    test ! -e "$output" && test ! -L "$output" || { echo 'Output must not already exist.' >&2; exit 2; }
    command -v debootstrap >/dev/null
    debootstrap --variant=minbase --include=nodejs,npm,ca-certificates,python3 trixie "$output" https://deb.debian.org/debian
    chroot "$output" npm install --global "$package"
    chroot "$output" npm cache clean --force
    mkdir -p "$output/home/user"
    echo "Prepared $output; set the provider rootfs in lab-runner.json."
    ;;
  *) echo 'Runtime must be docker or systemd.' >&2; exit 2 ;;
esac
