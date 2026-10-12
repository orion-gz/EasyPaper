# User data export and import

Open **Settings → Data & System → Export / import user data**. Export downloads a
versioned ZIP. Import adds new copies to the signed-in account, preserving existing
documents. Importing twice creates two sets of copies. Reload to apply settings.

Includes PDF/web article originals (including trash), attachments, extracted content,
translations, chats and comparison chats, evidence, summaries, vocabulary, annotations,
memos, folders, graph relationships, task history, reading history/profiles and user
language/workspace settings. Browser settings, themes, favorites, tabs, reading positions,
local notes and pending reading records come from the browser performing the export.

Shared AI model, parser and translation prompt settings are included; select the
checkbox to restore them, since they affect all accounts. Passwords, API keys,
authentication sessions, CLI conversation identifiers, server deployment configuration,
global usage counters and derived search indexes are excluded. Data on another browser
must first be synchronized or exported there. The ZIP is unencrypted.

Import assigns new IDs and remaps relationships, while reusing shared concepts by name.
User/browser preferences are restored; favorites and pending reading queues are merged.
In-progress generation/reparse tasks are cancelled and may be restarted in the app.

Files are staged and verified before publication within a database transaction. Invalid
archives, missing originals, broken references and write failures roll back DB changes
and remove newly published files. Limits: 4 GiB compressed, 8 GiB expanded, 100,000 entries,
256 MiB manifest, 20 MiB browser export payload. Pause editing and background generation
for a stable backup point across DB and files.

If browser storage or shared settings restoration fails, imported documents remain
available. Keep the page open and use **Retry settings restore**, without importing the
ZIP again.

## API

Both endpoints require authentication:

- `POST /api/user-data/export`: JSON object of browser storage string key/value pairs;
  `{}` exports server data only. Returns a ZIP download.
- `POST /api/user-data/import`: raw ZIP body (`Content-Type: application/zip`). Returns
  document count, ID mappings, browser data and non-secret shared settings. API clients
  apply browser settings themselves and may explicitly save shared settings through
  the existing `/api/settings/system` endpoint.

`manifest.json` uses format `easypaper-user-data`, version `1`, and SHA-256 file checksums.
Administrator archives from `scripts/backup_data.py` are a separate deployment recovery
format and are not accepted by this endpoint.
