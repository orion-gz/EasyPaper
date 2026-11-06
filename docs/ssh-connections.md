# HTTP(S), SSH and multiple inference servers

In Settings → Lab Mode, an administrator can register several Ollama or vLLM
servers, select a default server and allow models on each server. Members select
a server and model in their personal settings. The same server registry also
works in personal mode. Registration alone does not change personal model settings.
Save a personal server/model selection to activate it, or choose “Use existing
personal model settings” to restore the regular settings. Personal and Lab
selections are independent and retained when switching modes. For vLLM, include `/v1` in the service URL.

Save a server with an empty model list first if necessary, test its connection
to list available models, then configure allowed models and a default model.
Once a default model is configured, the connection test also performs a minimal
completion and verifies vLLM's cache_salt contract through the same connection.
Requests use the selected server; there is no load balancing or automatic
fallback. Changing or deleting a server with active inference requests is rejected.

## SSH

Choose SSH, enter the SSH host, port (default 22), username, and either a password
or an OpenSSH/PEM private key. Encrypted private keys accept a passphrase. The
service URL is resolved from the SSH server, e.g. `http://127.0.0.1:11434`.
Verify the displayed host-key fingerprint with the server administrator before
confirming it. Changed keys require explicit verification again.

The backend opens a loopback-only forwarding port on demand and reconnects on the
next request after a disconnection. In-flight inference is not automatically
replayed by the tunnel layer. HTTPS certificate verification and the original
TLS server name are preserved inside the SSH tunnel.

In the desktop connection dialog, the same controls connect the desktop app to
an EasyPaper server. Login cookies and synchronization stay isolated by the SSH
host, account and service URL. Synchronization and offline-account verification use the same tunnel as API calls.
Offline library locking and account isolation remain in effect; Lab configuration
and personal model settings continue to address the connected server.

A browser cannot create an SSH tunnel to reach EasyPaper initially. Open EasyPaper
via HTTP(S), or create a tunnel outside the browser first. Subsequent inference
connections are opened by the EasyPaper backend, not by the browser. When a
desktop connects to remote EasyPaper, that remote backend owns inference tunnels.

## Credential storage

Storage is opt-in. Without it, credentials live only in backend memory and must
be entered again after restart. Blank secret fields retain the existing secret.
Removing a server removes its stored credentials. Unchecking storage deletes its
persistent credentials while retaining them for the current process.

Desktop persistence requires macOS Keychain, Windows Credential Locker, or Linux
Secret Service. No plaintext fallback is used. OS-specific packaging and secure
storage should be smoke-tested on each release platform.

Web persistence requires `EASYPAPER_CONNECTION_KEY`, a Fernet key supplied by the
operator, separately from the database and backups. Generate one in the backend
environment with:

```sh
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Keep this key stable across restarts and supply it through the deployment's secret
management. Encrypted records are stored in `connection-secrets` under the app
configuration directory. Docker images use `/data/connection-secrets`, covered
by the `/data` volume; retain this volume and the encryption key when replacing
containers. Missing/invalid keys disable persistent saves; changing
the key requires re-entering credentials. Do not expose web login/settings over
an untrusted plaintext network when entering credentials.

Existing single-server configuration migrates to one stable default server.
Existing API keys remain readable from the legacy configuration until that server
is explicitly saved; saving moves the key to the selected memory/secure storage
and removes the legacy record. This preserves existing installations without
silently discarding keys where no secure store has been provisioned.

## APIs

- `GET/POST /api/inference/servers`: list/create servers.
- `PUT/DELETE /api/inference/servers/{id}`: edit/delete a server.
- `POST /api/inference/servers/{id}/default`: select the global default.
- `POST /api/inference/servers/{id}/check`: connect and list remote models.
- `POST /api/inference/ssh/host-key`: retrieve a candidate host key for approval.
- `PUT /api/me/model-settings`: accepts `server_id`, `provider`, and `model`.
- Existing `/api/lab/inference` endpoints address the default server.

Only administrators can configure connections or probe hosts. Member responses
contain names and allowed models, without connection details or credentials.
Existing Lab model preferences retain the migrated server identity even if the
global default changes. Failed desktop SSH authentication leaves the previous
connection and credentials intact.

SSH credentials never appear in configuration responses.

Deleting a migrated server also removes its legacy API-key record. Changing the
connection transport or SSH host, port, username, or pinned host key invalidates
model-derived result caches. The updated cache format recomputes older cached
results on first use; it does not delete source documents.
