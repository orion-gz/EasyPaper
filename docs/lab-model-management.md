# Lab model management

Lab Mode keeps `lab_preferences` separate from ordinary `inference_preferences`
and the application's personal provider settings. The AI settings tab and reader
pickers use `/api/lab/models`; they never build Lab choices from locally installed
Ollama models or personal API keys. New inference servers default to
`lab_shared=false`. Saving a server in the Lab administration UI while Lab Mode
is enabled explicitly shares it. Existing shared registrations remain shared
when edited outside Lab Mode. Legacy registrations without the field retain
compatibility with their previous shared-server semantics.

Only the Lab Master can register, edit, enable, disable, or unload shared models.
Members can select only registered models on enabled shared servers. Removal from
the allowed model list revokes that selection. Personal settings are not deleted
when modes change. CLI providers remain selectable regardless of login status.

## Authentication

The existing private Unix-socket runner provides account-specific unprivileged
UIDs and private homes inside Docker or systemd root filesystems. Authentication
input goes to an already-running login process identified by the authenticated
account and provider. Clients cannot supply executable names, arguments, paths,
or another account ID. Input is never echoed into the UI or saved by EasyPaper.
Login output is limited to an in-memory 8 KiB buffer, cleared on success/logout.
The UI clears its output when the EasyPaper account logs out. Do not enable
request-body logging on the application or reverse proxy for authentication APIs.

Commands verified against installed CLI help and official documentation:

| Provider | Login | Status | Logout |
| --- | --- | --- | --- |
| Codex | `codex login --device-auth` | `codex login status` | `codex logout` |
| Claude Code | `claude auth login` | `claude auth status` | `claude auth logout` |
| Antigravity | Not provisioned | Not provisioned | Not provisioned |

Codex uses its official browser device-code flow. Claude's authentication command
can receive browser authorization input through the app. Authentication uses
stdin/stdout/stderr pipes, not a general-purpose shell or full terminal emulator.
The deployed CLI must support that interaction mode.

The installed Antigravity CLI has no authentication-only subcommand in its help,
and the existing pinned runner image has no auth adapter. It reports
`unsupported`; it is not reported as authenticated. Enabling its interactive
agent as an authentication shell would violate the command restriction. A
verified authentication-only adapter is still required to complete Antigravity
login/logout support. Actual OAuth flows need validation with provisioned test
accounts. Automated tests include a real subprocess which accepts login input,
plus controlled runner/provider responses. Failed logins no longer suppress a
fresh authentication status command.

References: [Codex commands](https://learn.chatgpt.com/docs/developer-commands),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Antigravity authentication](https://antigravity.google/docs/install).

## Status and scheduling

`/api/lab/models/events` supplies SSE updates. Provider observations are coalesced
and cached for three seconds per application event loop, rather than polled once
per connected desktop. Events contain only model metadata and aggregate counts;
prompts, outputs, account identities, and credentials are excluded.

Ollama residency and VRAM come from `/api/ps`. vLLM uses `/v1/models`, `/health`,
and `/is_sleeping` when that optional endpoint exists. A missing sleep endpoint
is supported; an unavailable health endpoint fails closed. vLLM VRAM is unknown
unless measured by the operator. Application request counters distinguish waiting,
loading, and active requests; they do not measure individual GPU kernel activity
or requests submitted outside EasyPaper. Cancellation unwinds only that request's
queue entry, active count, and memory reservation.

The queue serves the oldest eligible request. A user or model at its concurrency
limit does not prevent other eligible users/models from proceeding. Existing
request-local identity, session ownership checks, cache salts, streaming response
ownership, and per-account cancellation are reused. CLI requests bypass the shared
GPU queue and use the runner's account/provider lock.

## Memory policy

Lab shared inference requires a saved memory policy and physical GPU pool ID.
Without them, admission and the dropdown both report the model unavailable.
Ordinary-mode requests without a memory policy retain their previous behavior.
All servers on the same GPU must use the same GPU UUID as their pool ID.
Reservations and resident allocations are aggregated across the pool; differing
budgets/resident-model limits use the smallest configured values. Duplicate
endpoint registrations and Ollama :latest aliases do not double-count allocations. Model estimates use parameter count, weight quantization, context length,
KV bytes per token, concurrent sequences, and a 20% margin. A measured allocation
acts as a lower bound. Ollama request context lengths are capped to the configured
estimate. The UI supplies conservative starting inputs, not architecture detection:
verify KV layout and actual allocations for the deployed model and runtime.

Admission accounts for observed resident models and in-flight reservations before
allowing a cold model request. Over-budget or unknown allocations return a retryable
error without evicting another model. Concurrent requests for the same model reuse
its reservation. Model concurrency overflow waits in the shared queue. Idle Ollama
models can be explicitly unloaded by the master; server leases reject unloading
while EasyPaper work is active or queued, and maintenance blocks new admission.

Local NVIDIA telemetry and SSH-host telemetry use fixed `nvidia-smi` arguments.
SSH queries reuse the verified connection and are permitted only when the
inference URL is loopback on that host, preventing a jump host's GPU from being
attributed to another server. Remote HTTP-only endpoints report telemetry
unavailable. The pool UUID selects the exact GPU; free memory from a different
GPU is never used to admit work. Suggested combinations are bounded greedy plans
under the saved budget and selected GPU free memory when available. They are estimates, not guaranteed optimal placements.

Operational limits:

- Automatic architecture detection and HTTP-only remote GPU telemetry are not
  implemented. Remote pool IDs must be provisioned correctly by the master.
- Run one EasyPaper backend worker per database. An OS advisory lock rejects
  duplicate Lab processes at startup/request time instead of permitting split
  counters and reservations. This is not a distributed GPU scheduler.
- vLLM process creation, allocation, sleep/wake, tensor parallel placement, and
  unloading remain operator-managed. The app does not call disruptive development
  control APIs. Configure vLLM context/concurrency and memory allocation to match
  the saved policy. [vLLM sleep lifecycle](https://docs.vllm.ai/en/latest/features/sleep_mode/).
- Out-of-band inference, nonstandard model aliases, external memory consumers, runtime overhead,
  and inaccurate estimates can invalidate available-memory assumptions. Dedicated
  serving endpoints and measured margins are required for reliable enforcement.
- GPU/OAuth hardware integration and two real desktop clients were not exercised
  in this development environment. Tests cover mocked provider observations,
  concurrent admission, account boundaries, mode restoration, and browser input.

The catalog uses the same pool admission calculation as inference. A lost SSE
connection disables shared selections until fresh status arrives; malformed
responses never switch the UI back to personal mode. Unloading or reconfiguring
an idle server alias is blocked when related endpoint/pool work is active.
