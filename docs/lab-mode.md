# Lab Mode

Lab Mode runs on the shared EasyPaper server. A browser and a Tauri app connected
through **Data → Server connection** use the same server accounts, documents and
inference services. Tauri does not need to synchronize or download a library to
use the lab GPU. Local mode continues to use the desktop's own data and models.

## Accounts and setup

1. Start the updated server and sign in with its existing administrator account.
2. Open **Settings → Lab Mode**. Configure the common engine, allowed models and
   default model. Use an Ollama base URL or a vLLM URL ending in `/v1`.
3. Enable Lab Mode using the current administrator password. Login skipping is
   disabled. Create member accounts and give each member their temporary password.
4. Members change that password on first login, then select a common model or a
   provisioned personal CLI in Lab Mode settings.

The existing administrator is the master. Account usernames cannot change while
Lab Mode is enabled. Disabling a member revokes their sessions and cancels tracked
inference work; turning Lab Mode off retains data and permits only the master.
Turning it back on requires members to sign in again. Reset passwords are shown
once. These responses must not be recorded by a reverse proxy.

Global system configuration and installation endpoints are administrator-only.
The master does not have a document-ownership bypass. This application boundary
does not prevent the operating-system administrator from accessing server files.

## Personal CLI isolation

The application never uses its host CLI credentials while Lab Mode is on. It
connects to `EASYPAPER_LAB_RUNNER_SOCKET`, a private Unix socket served by
`deploy/lab/runner.py`. Missing runner configuration fails closed.

The runner is a separately privileged service: do not expose it over TCP or make
its socket world-accessible. The application does not receive a Docker socket or
sudo access. Use one application worker; task cancellation and scheduling are
currently process-local.

Use `docker-compose.lab.yml` for the application container, or
`deploy/lab/easypaper-lab.service` for Docker-free systemd. Both bind the app to
loopback for an HTTPS reverse proxy. The Docker data directory must be writable
by `LAB_APP_UID:LAB_APP_GID`; the runner socket group must match that GID.

Start from `deploy/lab/runner.example.json`. One-time pinned CLI runtime builds:

```sh
sh deploy/lab/build-cli-runtime.sh docker claude_code easypaper-cli:claude-2.1.311
sh deploy/lab/build-cli-runtime.sh docker codex easypaper-cli:codex-0.165.0
# Docker-free alternative, on a Debian host with debootstrap installed:
sudo sh deploy/lab/build-cli-runtime.sh systemd claude_code /srv/easypaper/claude-rootfs
sudo sh deploy/lab/build-cli-runtime.sh systemd codex /srv/easypaper/codex-rootfs
```

For systemd, select `runtime: "systemd"` and set each provider's `rootfs` to its
prepared path. The build script refuses to overwrite an existing rootfs and runs
only when explicitly invoked by the operator. It requires network package access.
These build recipes are supplied for reproducibility; images/rootfs still need
real-host validation before onboarding members.

 The supplied Claude Code 2.1.311 and
Codex 0.165.0 command arrays were checked against locally installed `--help`
output; their named images must be built once by the operator using the recipes above.
Antigravity 1.4.12 exposes no authentication subcommand in `--help`, so its
login/status/logout require an operator-provided wrapper or terminal onboarding.
Do not advertise that profile as ready until that adapter has been verified.
The example now enables automatic personal home provisioning. Reserve its UID
range (20000–29999) exclusively for this runner; do not allocate those UIDs in
another service. On first CLI status/login/inference, the runner allocates a
persistent UID and private home using a transactional registry. Existing OS UIDs
and manually configured UIDs are skipped. The root directory is runner-owned
mode 0700, homes are member-owned mode 0700, and the registry is mode 0600.
Back up this directory and registry together; never regenerate the registry while
retaining homes. Provider images/rootfs still require one-time operator setup.
Accounts are retained after deactivation so credentials are not silently deleted.

For deployments that disable automatic provisioning, operators can instead
provision an account entry for each immutable ID returned by `/api/lab/users`:

```json
{
  "runtime": "docker",
  "memory": "4g",
  "accounts": {
    "ACCOUNT_ID_FROM_LAB_USERS": {"uid": 20001, "home": "/var/lib/easypaper-cli/alice"}
  },
  "providers": {
    "claude_code": {
      "image": "YOUR_PINNED_CLI_IMAGE",
      "run": ["claude", "--permission-mode", "dontAsk", "--tools", "", "--output-format", "text", "--model", "{model}", "--print", "-"],
      "login": ["claude", "auth", "login"],
      "status": ["claude", "auth", "status"],
      "logout": ["claude", "auth", "logout"]
    }
  }
}
```

Use a real 32-character account ID, an unprivileged UID, and a directory owned by
that UID with mode 0700. The example is a configuration schema, not a prevalidated
provider image. Verify the installed CLI's commands before enabling a provider.
Commands are operator-owned arrays, never shell strings supplied by members.
`run` receives the prompt on stdin and must emit answer text on stdout. Providers
using structured output need a wrapper inside the image/root filesystem to emit
text. Add `codex` and `antigravity` profiles using verified commands for the pinned
versions. Do not put tokens in these command arrays.

For Docker the runner starts a read-only container with no capabilities, an
unprivileged UID, bounded memory/processes, private temporary storage, and only
that account's home mounted. Replace the ordinary application Compose service's
host `.claude`, `.codex`, `.antigravitycli` and `.gemini` mounts with a mount of the
runner socket directory. Keep the existing `/data` volume.

For Docker-free systemd, set `runtime` to `systemd` and replace each provider's
`image` with `rootfs`, an absolute path to an operator-prepared root filesystem
containing that CLI and its runtime dependencies. The runner uses transient
units with `RootDirectory`, an unprivileged UID, read-only system files, private
temporary storage/devices, no capabilities and only the personal home writable.
Provide DNS and CA certificates inside that filesystem. No Docker is needed.
`deploy/lab/easypaper-lab-runner.service` is a template; adjust installation paths
and the socket-access group to the application service user.

The login button starts an isolated login process; the UI polls Connection status and displays its instructions automatically. Select Connection status to resume polling after leaving the tab. Output is kept only in runner memory and is limited to 8 KiB.
Login and inference processes time out after ten minutes. If the provider needs
an interactive terminal or a browser callback unavailable on the server, the
operator must log in inside the same isolated home/runtime. Local Tauri CLI
credentials are never transferred to the lab server.

## Synchronization and cache boundaries

The existing desktop synchronization policies and destructive-action previews
remain in effect. Synchronization is optional and includes only the signed-in
account's portable library data. Passwords, role, API keys, CLI credentials,
common inference configuration and personal model preferences are not exported.
A change of remote account stops automatic synchronization and requires a new
preview. Pending transfers are stored separately for each remote account. Lab
servers require the updated Tauri account-binding capability for synchronization;
older clients receive an upgrade message. Resuming a saved response rechecks the current remote identity first.

Library commits remain serialized for transaction safety. Ordinary requests from
other authenticated accounts are not blocked by a user's library commit.
Downloaded local copies remain on the desktop after account deactivation.

Ollama chat history is supplied by EasyPaper; `keep_alive` is not a document
session. vLLM requests use a private cache salt scoped to owner and document
revision where available, and conservatively to the prompt otherwise. Before vLLM inference, EasyPaper checks that the server OpenAPI chat request
schema declares `cache_salt`; unsupported or inaccessible schemas fail closed.
Successful contract checks are cached for 60 seconds. Proxies must expose the
server-root `/openapi.json` (and the server must honestly implement its schema).
The explicit administrator connection test also performs a one-token inference
for Ollama/vLLM; this may load a model and consumes inference capacity. A schema
check cannot prove GPU cache behavior: validate that on the actual server. This is a cache-reuse boundary, not physical GPU memory isolation.

The initial scheduler permits one inference per member and two common Ollama or
eight common vLLM requests at a time. These limits are configurable in Lab Mode. Benchmark before increasing them; limit changes govern newly admitted requests.
A CLI request is reconstructed from supplied context; this isolated runner does
not transfer provider-native conversation IDs across desktop/server environments.

## Validation and deployment status

Automated tests cover account permissions, session invalidation, salts, model
selection, request/snapshot gates, desktop sync resumption and the settings UI.
Before deployment, validate the actual GPU/model, pinned CLI profiles, container
images or systemd root filesystems, login callbacks and runtime cleanup. Those
host-specific checks cannot be substituted by unit tests.

The example Antigravity profile runs `agy_adapter.py` **inside** its image/rootfs
and explicitly reports `terminal_required` for authentication operations. Install
that adapter at `/opt/easypaper/agy_adapter.py` inside the runtime. This avoids
pretending that unsupported web authentication is available. The operator must
perform login/logout in the member's isolated runtime; a real inference request
is the final authentication check.

Browser-only account state is archived in IndexedDB on account switches and is
not included in another account’s localStorage export. Durable work restores its
document owner on restart; disabled accounts’ pending work is cancelled.

## Acceptance checks on the lab host

Use two member accounts and two documents. Verify these before calling the
installation production-ready:

1. Build both CLI runtimes; first member login must create its private home
   without editing the runner account map. Login/status/logout must reflect the
   actual provider. Antigravity `terminal_required` is never reported as connected.
2. Run the Lab inference connection check for each intended engine/model. An old
   vLLM server without a declared `cache_salt` must reject inference before prompts
   are sent. Confirm cache behavior with the chosen vLLM server's metrics/logs.
3. In browser and actual Tauri builds, switch between both accounts, edit separate
   documents, synchronize and resume transfers. Neither account may read the
   other's library or archived browser state. Revocation must block new work.
4. Start concurrent inference, disable one account, and check process/container
   cleanup and the other account's continued access. Restart the application and
   runner and verify personal login persistence and cancellation of disabled work.
5. Exercise both Docker and systemd installations with the intended GPU models.
   Keep one app worker and one runner worker; benchmark configured concurrency.

Personal CLI requests deliberately reconstruct supplied document context for each
invocation. Provider-native conversation resumption is not enabled: Codex runs
with `--ephemeral`, and Claude uses a fresh print request. This avoids retaining
hidden cross-document conversation state; native session IDs are not portable
between web, desktop and server. App document history remains the source of truth.

## Installation and connection guides

Settings → Lab Mode offers an **Installation guide** and a **Connection guide**.
Finish all installation scenes to unlock the connection guide. Each command has
its own animation and copy icon; scenes advance only when Next is selected.
SSH host, username and ports, or the HTTPS domain, update the command examples.
The completed installation and connection methods are remembered in this browser; credentials
and server addresses are not stored by the guide. Changing an installation choice
locks the connection guide until that path is reviewed again.

The installation scripts target an **Ubuntu 24.04** server booted with systemd,
with sudo privileges and internet access. Download this repository and open its
EasyPaper folder first. Choose one application deployment (both use port 8000).
The guide shows only the selected deployment's script and prerequisites:

| Deployment | Run from the EasyPaper folder | Automation | Persistent data |
| --- | --- | --- | --- |
| Docker | `sudo bash deploy/lab/install-docker.sh` | Docker/Compose if absent, image build, data directories, container and health check | `lab-data` by default |
| systemd | `sudo bash deploy/lab/install-systemd.sh` | Python/Node.js dependencies, app build, service user, boot service and health check | `/var/lib/easypaper` |

`sudo bash deploy/lab/install.sh docker` and `sudo bash deploy/lab/install.sh systemd`
are explicit aliases. Calling `install.sh` without a deployment prints usage and
makes no changes. The scripts also work when invoked by absolute path from another
directory. Ollama, HTTPS and optional personal CLI setup remain separate steps.

- Docker: installs Ubuntu's `docker.io` and `docker-compose-v2` packages only when
  Docker is absent. An existing Docker installation must already have Compose v2
  and an accessible daemon; the script does not replace vendor-managed packages.
  Compose reads `.env` in the project folder, including `LAB_DATA_DIR`,
  `LAB_APP_UID` and `LAB_APP_GID` (default `1000:1000`). Put overrides there because
  sudo may remove shell environment variables. The script changes ownership only
  of the data directory and its `home` directory, never existing files recursively.
  Existing data must be writable by the selected non-root UID/GID. Rerunning
  rebuilds/recreates the app while preserving its data. Concurrent script runs are
  blocked and success requires a healthy application container within 180 seconds.
- systemd: clone the repository and run
  `sudo bash deploy/lab/install-systemd.sh`. The script installs dependencies,
  builds the app in `/opt/easypaper`, creates the service user and registers
  `easypaper-lab.service`. Requires a host booted with systemd and Node.js 22.13+
  (installed when missing or too old). It refuses to overwrite a completed or
  unmanaged installation. An interrupted installation retains a private
  `.lab-installing` marker: fix the reported error and rerun the same command.
  Do not add this marker to an existing deployment. Concurrent installers are
  blocked; success requires both an HTTP response and an active service.
  Persistent data is in `/var/lib/easypaper`. This installs the application;
  optional isolated personal CLI runtimes still require the setup above.

Both deployment templates write logs inside their writable data directories:
`/data/logs` for Docker and `/var/lib/easypaper/logs` for systemd.

### Shared Ollama setup

The guide runs one script for the selected deployment. From the original project
folder on the Ubuntu 24.04 server:

```sh
sudo bash deploy/lab/install-inference.sh --deployment docker --model qwen3:4b
# For a native application, choose --deployment systemd instead.
```

This installs Ollama if absent, adds an EasyPaper-owned systemd drop-in, restarts
it, downloads the model and performs one generated token from the application's
network environment. Docker uses the host bridge; systemd uses loopback. Existing
unmanaged `90-easypaper.conf` files are not overwritten: migrate them manually
before using the installer. A failed check restores the previous managed drop-in.
Downloaded binaries/models are retained on failure so the command can be retried.
This does not install GPU drivers or configure a remote vLLM server. Verify GPU
acceleration separately. The test can load the model into memory.

For Docker, the host firewall must permit the app container to reach that bridge
address. Keep port 11434 private. Custom `host-gateway` overrides or rootless
Docker require matching network configuration. An existing shared Ollama service
may have other clients: inspect its listener and drop-ins before changing them;
do not blindly replace its address with the example.

In **Settings → Lab**, select Ollama and set:

| Deployment | Engine URL | Allowed/default model |
| --- | --- | --- |
| Docker | `http://host.docker.internal:11434` | The model downloaded above |
| systemd | `http://127.0.0.1:11434` | The model downloaded above |

Save and run the connection test before enabling Lab mode. The guide separately
shows initial administrator login, **Settings → Account** password change, shared
inference configuration, Lab activation, and member invitation. Password change
keeps the current session signed in; use the new password for later logins.

For SSH access, run the generated tunnel command on your PC, enter your SSH
password in the terminal, and keep it open. Use `http://localhost:18000` (or your
chosen local port) as the desktop server URL or browser address. SSH forwarding
must be permitted by the server. The EasyPaper login uses its own account, not
SSH credentials. The final connection example keeps the local port read-only.
To change it, return to the tunnel scene, edit the port, and restart the SSH
command before using the updated URL.

For HTTPS, first use the private SSH tunnel to change the initial `admin / admin`
password in Settings → Account. Register a domain, point its DNS A record to the
server public IPv4, and allow/forward TCP ports 80 and 443 through the router and
server/cloud firewalls. Run the generated command (replace the example addresses):

```sh
sudo bash deploy/lab/install-https.sh --domain lab.example.com --public-ip 203.0.113.10
```

The script checks that **all** DNS A/AAAA records match the supplied addresses;
repeat `--public-ip` for additional IPv4/IPv6 addresses. It installs Caddy if
missing, preserves existing Caddyfile content and imports a separate managed
site. A domain already managed elsewhere is rejected. Caddy configuration is
validated before reloading, then HTTPS hostname/trust and the new route are
checked. Failed validation/certificate checks restore the previous configuration.
Private backups are stored under `/var/backups/easypaper-https`. DNS registration,
router/cloud firewall rules and administrator credentials are not changed by the
script. The server must be able to reach its public HTTPS address for verification.

### Installation diagnostics

```sh
sudo bash deploy/lab/diagnose.sh --deployment docker --model qwen3:4b
sudo bash deploy/lab/diagnose.sh --deployment systemd --model qwen3:4b --domain lab.example.com --json
```

Checks cover the EasyPaper API, container health or service state, a temporary
write probe using the application identity, private port binding, and optional
model availability/HTTPS. The command reports all failed checks with actionable
hints and exits nonzero if any fail. It does not install packages, change settings
or print account information. No inference prompt is sent by diagnostics; the
inference installer performs the actual one-token check.

### Updates and recovery

Run these from the **original Git checkout**, not `/opt/easypaper` (which has no
Git metadata). Use `--project /path/to/EasyPaper` when invoking a copied script.
The package dependencies from the original installation must still be available.

```sh
sudo bash deploy/lab/update.sh --deployment docker
sudo bash deploy/lab/update.sh --deployment systemd --ref vYOUR_RELEASE
# Replace the ID with the snapshot printed by update.sh:
sudo bash deploy/lab/rollback.sh --deployment docker --snapshot 20261107T120000Z-0123abcd
```

Update fetches `origin`, resolves `--ref` (default `origin/main`) to a commit, and
builds it separately without checking out or modifying your working tree. Local
uncommitted edits are not deployed. Docker requires a local daemon and the
supplied `/data` bind mount; systemd requires the supplied unit and no unmanaged
service drop-ins. Custom installations must be migrated manually.

The old Docker image or systemd application/runtime and service configuration are
saved before activation. The app is then stopped briefly and the complete app
data directory is archived, including SQLite WAL files, before any new process
can migrate the database. The new version starts and must pass readiness checks.
On failure, the previous application **and its data** are restored automatically.
If backup fails before activation, the original service is restarted. If recovery
also fails, the error identifies the retained snapshot for manual recovery.

Snapshots live under `/var/backups/easypaper` with private permissions because
they contain account data and configuration. They are never automatically deleted;
allow space for the old image/runtime plus full data and retain an off-host backup.
A manual rollback restores the pre-update data as well. Newer data is retained in
a sibling `*.before-restore-*` directory, not merged into the older database.
Keep that directory for manual recovery of work created after the snapshot.

Systemd releases live in `/opt/easypaper-releases` and a managed service drop-in
selects the active release. Docker's resolved active configuration is stored in
`/var/lib/easypaper-deployment/docker.json`; use the update/rollback tools after the
first update, not the fresh installer or the original Compose file. Docker recovery
recreates the container to remount restored data. External inference model stores,
HTTPS configuration, optional CLI runner homes and arbitrary custom mounts are
not part of the app snapshot; back them up separately. These commands do not update
GPU drivers, Ollama or the CLI runner. Operations and installers share locks.

### SSH launchers

The SSH scene offers **Linux/macOS** and **Windows** downloads using the current
host, account and ports. Run `bash easypaper-connect.sh` on Linux/macOS or open
`easypaper-connect.cmd` on Windows with OpenSSH installed. The launcher prints the
browser URL, binds the local tunnel only to loopback, exits on forwarding failure
and uses SSH keepalives. Password/key authentication and host-key verification
remain in OpenSSH; downloaded files contain no password or private key. Keep the
terminal open while using EasyPaper. Download a new launcher after changing host
or ports. HTTPS connection scenes do not offer SSH files.

The guide's maintenance section also shows deployment-specific diagnostic,
update and rollback commands. All privileged operations execute only when the
operator runs a script on the server; the browser never invokes sudo or Docker.

Dependency references: [Docker on Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
[Caddy installation](https://caddyserver.com/docs/install), and
[NodeSource Node.js packages](https://github.com/nodesource/distributions),
[Ollama on Linux](https://docs.ollama.com/linux), and
[Docker host networking](https://docs.docker.com/compose/how-tos/networking/).

Implementation references: [Ollama Linux service configuration](https://docs.ollama.com/linux), [Ollama generation API](https://docs.ollama.com/api/generate), [Caddy import](https://caddyserver.com/docs/caddyfile/directives/import), and [Caddy validate/reload](https://caddyserver.com/docs/command-line).
