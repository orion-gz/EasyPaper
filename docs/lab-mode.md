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

Start from `deploy/lab/runner.example.json`. The supplied Claude Code 2.1.311 and
Codex 0.165.0 command arrays were checked against locally installed `--help`
output; their named images must still be built/provisioned by the operator.
Antigravity 1.4.12 exposes no authentication subcommand in `--help`, so its
login/status/logout require an operator-provided wrapper or terminal onboarding.
Do not advertise that profile as ready until that adapter has been verified.
 Operators provision an account entry
for each immutable ID returned by `/api/lab/users`:

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

The login button starts an isolated login process; use Connection status to read
its instructions. Output is kept only in runner memory and is limited to 8 KiB.
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
revision where available, and conservatively to the prompt otherwise. The vLLM
server must support `cache_salt`; unsupported servers must not silently ignore
it. This is a cache-reuse boundary, not physical GPU memory isolation.

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
