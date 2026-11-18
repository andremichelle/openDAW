# Custom Server Backup (PHP)

> **Status:** Plan. Nothing implemented.

## TL;DR

A third backup provider next to Dropbox and Google Drive, named "Custom Server" in the UI. openDAW generates a single PHP file with a secret token baked in, the user uploads it to any PHP webspace (Strato, IONOS, all-inkl and the like) and pastes its URL and the token into openDAW. From then on the backup behaves exactly like Dropbox and Google Drive, because the PHP file implements the six operations of `CloudHandler`.

1. One file, no setup step, no account. The token is generated in the browser, only its SHA-256 hash is in the file, so nobody can claim a freshly uploaded file.
2. Only GET and POST, so hosts that block PUT, DELETE or WebDAV methods work anyway.
3. Big files are uploaded in chunks and assembled on the server.
4. No size cap and no quota from our side. The server's own limits apply.
5. The user must accept a disclaimer before the file is generated and before the first connect.

---

## What already exists

### Providers

`packages/studio/core/src/cloud/CloudHandler.ts`
The interface: `upload(path, data, progress?)`, `exists`, `download`, `list`, `delete`, `alive`.

`DropboxHandler.ts`
One `filesUpload` call per file. **No chunking.** The Dropbox SDK call is limited to 150 MB per request, larger files fail today.

`GoogleDriveHandler.ts`
One multipart POST or media PATCH per file. **No chunking**, no progress.

`NextcloudHandler.ts`
**Has chunking.** Nextcloud chunked upload v2 above 10 MB (session folder, numbered chunks, final MOVE), retries on transient failures (`Promises.guardedRetry`, 4 attempts, never on abort), upload progress through XHR, abort through an `AbortSignal`. It is used for project sharing (`NextcloudDialogs`, `SharedFolderSync`), not for the backup.

The new handler follows the Nextcloud handler: same chunk loop, same retry rules, same XHR progress and abort handling.

### Backup flow

`CloudBackup.backup(cloudAuthManager, service)` asks for approval with a Dropbox specific text, gets the handler from `CloudAuthManager.getHandler(service)`, then runs the lock file and the seven backup stages (samples, projects, templates, soundfonts, presets, scripts, wclaps). `CloudService` is `"Dropbox" | "GoogleDrive"`.

Entry points: the Backup submenu in `StudioMenu.ts` and the "Backup & Sync" rail in `ui/dashboard/Backup.tsx`.

---

## The PHP file

### Generation

The template lives in the app (`packages/app/studio/src/custom-server/opendaw-server.php`), because studio-core builds with plain `tsc` and cannot ship a raw text import. `CustomServerFile.generate` next to it fills the template. openDAW replaces three placeholders and offers the result as a download named `opendaw.php`.

1. `TOKEN_HASH`: hex SHA-256 of the token.
2. `ORIGINS`: `https://opendaw.studio`, `https://dev.opendaw.studio` and `location.origin` of the page that generated the file. A file generated on localhost therefore also works on DEV and PROD.
3. `DATA_FOLDER`: `opendaw-data-` plus 32 hex characters derived from the token (`SHA-256("folder:" + token)`). Deterministic, so regenerating the file from the same token (update to a new version) finds the same data.

The token is 32 random bytes, base64url. openDAW shows it once with a copy button and asks the user to keep it in their password manager.

### Protocol

Every request is `opendaw.php?action=<name>&path=<path>` with the header `X-OpenDAW-Token: <token>`. Not `Authorization`, because Apache with FastCGI (common on shared hosting) drops that header before PHP sees it. Responses are JSON except downloads.

| action | method | does |
|---|---|---|
| `alive` | GET | `{version}`, also removes chunk sessions older than 24 hours |
| `exists` | GET | `{exists: bool}` |
| `download` | GET | streams the file with `readfile`, 404 if missing |
| `list` | GET | `{names: [...]}`, child names of a folder, empty for a missing folder |
| `delete` | POST | deletes a file or a folder recursively, 404 counts as success |
| `upload` | POST | raw body, written to a temp file and renamed into place |
| `chunk` | POST | `&session=<uuid>&index=<n>`, raw body, stored in the session folder |
| `commit` | POST | `&session=<uuid>&count=<n>&size=<bytes>`, concatenates the chunks into a temp file, checks the total size, renames into place, removes the session |

A chunk is idempotent (same session and index overwrite), so the client can retry it.

### Security

1. **Token:** `hash_equals(TOKEN_HASH, hash("sha256", token))`. 256 bits cannot be guessed, no rate limit needed. Wrong or missing token answers 401 without detail.
2. **HTTPS only**, except when the server host is `localhost` or `127.0.0.1` (testing with `php -S`).
3. **CORS:** `Access-Control-Allow-Origin` only for the listed origins, `Vary: Origin`, allowed headers `X-OpenDAW-Token` and `Content-Type`. An unknown origin gets 403 before anything else. The preflight is answered before the token check. No cookies, so CSRF does not apply.
4. **Paths:** split at `/`, no empty segment, no segment starting with `.` (covers `.` and `..` and keeps the internal `.tmp`, `.sessions` and `.htaccess` out of reach), at most 200 bytes, no control characters and none of `\ : * ? " < > |`. The backup paths (`samples/<uuid>.wav`, `projects/<uuid>/project.od`, `wclaps/<id>.tar.gz` and so on) all pass. After creating parents, the folder must still resolve inside the data folder.
5. **Stored files never execute:** every file gets a `.bin` suffix on disk (stripped again by `list`), the data folder gets an `.htaccess` with `Require all denied` and an empty `index.html`. On nginx, where `.htaccess` is ignored, the unguessable folder name still hides it and `.bin` still never runs.
6. **No server information leaks:** errors are generic JSON with a status code (`507` when a write fails for lack of space).
7. **Header:** a short "provided as is, without warranty" licence block and the version.

---

## openDAW side

1. `CustomServerHandler` in `packages/studio/core/src/cloud/`, implements `CloudHandler`. Chunk size 1 MB, four chunks in flight at once. Strato's Apache throttles every HTTP/2 upload stream (measured 0.5 to 0.7 MB/s per request, 2.4 MB/s with four in parallel, 3.5 MB/s over HTTP/1.1, which browsers do not use when HTTP/2 is offered). PHP does not apply `post_max_size` to raw bodies (tested). Files at or below one chunk use `upload`, larger ones `chunk` plus `commit`.
2. `CloudService` gains `"CustomServer"` (additive for SDK users). `CloudAuthManager.getHandler` opens the connect dialog instead of OAuth.
3. `CloudBackup.backup` gets a per service approval text. The Dropbox text stays as it is.
4. **Connect dialog** (app): server URL and token in a form (password manager friendly), "Create server file" button, "Forget server" button. URL and token are stored in `localStorage` for this origin, so the dialog appears only once per origin.
5. **Create server file dialog:** disclaimer checkbox, then generate token, show token with copy button, download `opendaw.php`.
6. **Version check:** when `alive` reports an older version, openDAW offers "Update server file", generated from the stored token.
7. Entries in the Backup submenu of `StudioMenu.ts` and in `ui/dashboard/Backup.tsx`, with help linking to the new manual.
8. Manual `/manuals/custom-server`: requirements (PHP 7.4 or newer, HTTPS), setup in three steps, updating, forgetting, the disclaimer.

### Disclaimer text

"This runs on your own server. You are responsible for its security, backups, limits and costs. openDAW accepts no liability for data loss, unauthorised access or any other damage. Keep your token secret, anyone who has it can read and delete your backup."

---

## Phases

1. ~~**PHP file plus tests.** Template, protocol, security rules. Test suite in node against `php -S localhost` (skipped when `php` is missing): wrong token, wrong origin, path traversal (`..`, encoded, absolute, dot segments), `.php` upload never executes, chunk retry, commit with missing chunk, commit with wrong size, recursive delete, stale session cleanup.~~ Done: `opendaw-server.php`, `CustomServerFile.ts`, `CustomServerFile.test.ts` (53 tests).
2. ~~**Handler.** `CustomServerHandler` plus tests against the same local server, including a file of several chunks and an aborted upload.~~ Done: `CustomServerHandler.ts` (exported, plus `version()` for the update check), `CustomServerHandler.test.ts` (16 tests, jsdom XHR with real CORS preflight, 503 retries through a router script).
3. ~~**Backup integration.** `CloudService`, `CloudAuthManager`, approval text.~~ Done: `CloudService` gains `"CustomServer"`. `CloudAuthManager.create(clientIds, customServer?)` takes a connector that returns a connected handler (the app's dialog in phase 4), memoized like the OAuth handlers, plus `forget(service)`. `CloudBackup` has its own approval text for the custom server and shows "Custom Server" in its headlines, Dropbox and Google Drive texts unchanged. `CloudAuthManager.test.ts` (5 tests).
4. ~~**Dialogs and entries.** Connect, create, update, forget, menu and rail.~~ Done: `CustomServerDialogs` (one dialog: intro, disclaimer, Server File row with "Accept and Download", Address, Token with Copy, a one line status, Forget only when something is stored). The dialog opens on every connect, filled in from storage, so the user can always change or forget the server. Clicking "Accept and Download" is the acceptance, no extra checkbox. The approval dialog before it has its own inviting text and headline. `IconSymbol.Server` added at the end of the enum. Checked in Chrome against a local `php -S`: wrong token, bad address, unreachable server, a full backup (426 MB, no leftovers), Copy, Forget.
5. **Real host.** Backup and restore on Strato webspace from localhost, then from DEV.
6. **Manual and changelog.**

---

## Decisions

1. Name in the UI: "Custom Server".
2. Icon: chosen later by André.
3. Dropbox and Google Drive stay as they are, no chunking.
