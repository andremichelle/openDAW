# Nextcloud Integration Plan

Allow openDAW to read and write projects into a **shared folder on a school's own Nextcloud**,
with **assets (samples, soundfonts) stored once in a shared sub-folder** and referenced by
many project files instead of being uploaded repeatedly.

**Model:** each school connects its *own* Nextcloud to openDAW. We run a single instance only
for our own testing; schools never use ours.

---

## 1. Approach (decided): WebAppPassword

A browser app on `opendaw.studio` cannot call a school's Nextcloud WebDAV directly: Nextcloud
sends no CORS headers by default (nextcloud/server#3131), and no popup, public-share, or
picker flow gets around it. The fix is a **server-side Nextcloud app that allowlists
`opendaw.studio`** so the browser can talk to WebDAV. This keeps the "we never touch your
files" promise (no proxy) and works fully in the browser. We deliver it in two steps:

- **Step 1 (now):** use the existing **WebAppPassword** community app. The school installs it
  and adds `opendaw.studio` to its allowed origins. Zero code from us, good for development and
  early pilot schools.
- **Step 2 (later):** publish our **own openDAW connector app** to the Nextcloud app store,
  with the `opendaw.studio` origin baked in. The school's job becomes a single click (install,
  no settings step), and we control compatibility with new Nextcloud versions instead of
  depending on a third party.

Rejected alternatives: a relay **proxy** on `api.opendaw.studio` (their files and credentials
would transit our server) and a **desktop build** (out of scope).

Access is via **WebDAV** (`https://<host>/remote.php/dav/files/<user>/...`), plain HTTP with
verbs `PROPFIND` (list), `GET`, `PUT`, `MKCOL` (mkdir), `DELETE`. It maps almost 1:1 onto our
existing `CloudHandler` interface.

---

## 2. School admin setup guide (one-time, web UI)

### Step 1: WebAppPassword (now)
1. Avatar (top right) -> **Apps** -> **Security** -> **WebAppPassword** -> **Download and
   enable**.
2. Avatar -> **Administration settings** -> **WebAppPassword** (left sidebar).
3. Enter `https://opendaw.studio` under **allowed origins** -> click **Set origins**.

### Step 2: openDAW connector app (later)
1. Avatar -> **Apps** -> find **openDAW** -> **Download and enable**. Done (origin is
   pre-configured, no settings step).

Either way the admin then creates an **app password** (Personal settings -> Security -> Create
new app password) and gives openDAW: **server URL + username + app password**.

**Fallback if the app store is unreachable** (common on locked-down/shared hosting, see
appendix G): install WebAppPassword manually by uploading its `webapppassword/` folder into
the Nextcloud `apps/` directory via SFTP, and set the origin in `config/config.php` instead of
the settings UI:
```php
'webapppassword.origins' => ['https://opendaw.studio'],
```

---

## 3. Authentication

**App password + HTTP Basic auth** (`Authorization: Basic base64(user:apppassword)`). User
enters server URL + username + app password once; works with 2FA accounts. A Login Flow v2
popup (returns `{server, loginName, appPassword}` without storing the real password) is a
nicer UX we can add later. OAuth2 is deferred: more admin setup and Nextcloud's tokens are
unscoped, so no real security win.

---

## 4. Storage layout (with shared, deduplicated assets)

The core requirement: assets are uploaded **once** into a shared sub-folder and referenced by
many projects. openDAW already content-addresses samples and soundfonts by UUID
(`samples/v2/<uuid>/`, `soundfonts/v2/<uuid>/`), so dedup is natural: the UUID *is* the
content key. Proposed layout inside the shared root folder (e.g. a Group Folder named
`openDAW`):

**Implemented:** everything lives under a fixed `openDAW/` root in the connected user's WebDAV space
(constant `Root` in `SharedFolderSync`, not user-configurable), so the rest of the account stays free
for other apps. On first upload a `openDAW/README.txt` warning ("do not edit by hand") is written
once (`ensureReadme`).

```
openDAW/                         <- fixed root in the user's files (keeps the rest of the account clean)
  README.txt                     <- auto-written once: warns humans not to touch the files
  index.json                     <- catalog of projects (uuid -> name, artist, modified, asset refs)
  projects/
    <project-uuid>/
      project.od                 <- binary BoxGraph
      meta.json                  <- ProjectMeta
      image.bin                  <- optional cover
  assets/                        <- SHARED across all projects, dedup by uuid
    samples/
      <sample-uuid>/             <- audio.wav, peaks.bin, meta.json
    soundfonts/
      <soundfont-uuid>/          <- soundfont.sf2, meta.json
```

**Dedup rule on save:** for each asset a project references, `HEAD`/`PROPFIND`
`assets/samples/<uuid>/audio.wav`; upload only if absent. Because UUIDs are stable per
content, the same sample shared between ten class projects is stored exactly once. This is the
same "exists-then-upload" pattern `CloudBackupSamples.ts` already uses, just pointed at a
shared `assets/` folder rather than a per-user private one.

**Garbage collection (implemented, Step 6):** `index.json` carries each project's asset UUID
lists (`samples`/`soundfonts`), so the reference graph is read in one request, no `project.od`
scanning. On project delete and on re-save, `SharedFolderSync` recomputes the **live set**
(union of refs across all remaining projects) and deletes any asset folder no longer in it.
Recompute-from-projects (not stored refcounts) is self-healing under last-write-wins. The new
`index.json` shape:
```json
{ "version": 1, "projects": { "<uuid>": { "meta": {...}, "samples": ["<uuid>"], "soundfonts": ["<uuid>"] } } }
```

---

## 5. Implementation roadmap (do these in order)

**Status:** Steps 1–6 and 9 done; the full browser flow (connect, browse, open, upload, delete with
GC) works end to end against `nextcloud.opendaw.studio`. Remaining: Step 7 (own connector app) and
Step 8 (school manual), plus the §6 concurrency question and the deferred parallel-upload option.

The seam for the code steps: `CloudHandler`
(`packages/studio/core/src/cloud/CloudHandler.ts`), a 6-method interface (`upload`, `exists`,
`download`, `list`, `delete`, `alive`) already implemented for Dropbox and Google Drive. We
reuse this transport but **not** the `CloudBackup` pipeline, which is a personal one-way OPFS
mirror, whereas Nextcloud is a shared multi-writer space.

### ✅ Step 1: Install Nextcloud on Strato webspace at `nextcloud.opendaw.studio`
Strato webspace has FTP but no SSH/`occ`, so install via the **Web Installer** (no large
upload, no command line):
1. **Subdomain (done):** `nextcloud.opendaw.studio` already points at the `/nextcloud` folder,
   and SSL is already active (appendix B).
2. **Create the database:** the installer creates the *tables* but not the *database* itself.
   It would only run `CREATE DATABASE` if the MySQL user had that privilege, and Strato's
   restricted `dbu#######` user does not. So create an empty database yourself: Kundenlogin ->
   **Datenbanken** -> **Datenbank anlegen**, set a password, and note the four values Strato
   assigns (**host**, **name** `dbs#######`, **user** `dbu#######`, **password**). Nextcloud
   fills it with tables in step 4 (appendix C).
3. Download Nextcloud's **Web Installer** (`setup-nextcloud.php`) from
   `https://download.nextcloud.com/server/installer/setup-nextcloud.php` (also under
   nextcloud.com/install -> Download server -> Community projects -> Web installer), and upload
   it into the `/nextcloud` folder via SFTP.
4. Open `https://nextcloud.opendaw.studio/setup-nextcloud.php`; it downloads and unpacks
   Nextcloud. Finish the web wizard: create the admin account, choose MySQL/MariaDB, and enter
   the database values from step 2.
5. Post-install: in **Administration -> Basic settings** set background jobs to **Cron** (or
   **AJAX** if webspace cron is unavailable), and clear the security/setup warnings.

A **valid TLS cert is mandatory**: openDAW is served over HTTPS and a browser will not make
cross-origin WebDAV calls to an HTTP server. There is no second/local Nextcloud; the only
instance is the Strato subdomain. `localhost:8080` refers to the openDAW dev server (the
*origin* we allowlist), not a Nextcloud host. No SSH means the `config.php` fallback (§2) is
edited via SFTP if ever needed.

### ✅ Step 2: Enable browser access (WebAppPassword) and validate WebDAV
1. As admin: **Apps** -> **Security** -> install **WebAppPassword**.
2. **Administration settings** -> **WebAppPassword** -> in the **WebDAV/CalDAV** allowed
   origins field (the essential one; files-sharing and preview fields are optional) add the
   openDAW dev origin `http://localhost:8080` and `https://opendaw.studio` -> **Set origins**.
3. Create an **app password** (Personal settings -> Security).
4. Confirm a WebDAV round-trip by `curl` (a request tool preinstalled on macOS; see the
   appendix if unfamiliar, or use the Cyberduck GUI alternative):
```bash
curl -u admin:APPPASSWORD -T project.od \
  https://nextcloud.opendaw.studio/remote.php/dav/files/admin/openDAW/test/project.od
curl -u admin:APPPASSWORD -X PROPFIND -H "Depth: 1" \
  https://nextcloud.opendaw.studio/remote.php/dav/files/admin/openDAW/
```

### ✅ Step 3: Validate CORS from the browser
From the openDAW dev origin's devtools console, run a `fetch` `PROPFIND` against the instance.
If the preflight passes and the listing returns, the whole approach is proven end to end. Do
not write feature code before this succeeds.

### ✅ Step 4: Transport (`NextcloudHandler implements CloudHandler`)
Done: `packages/studio/core/src/cloud/NextcloudHandler.ts`, WebDAV over `fetch`
(`PUT`/`GET`/`PROPFIND`/`DELETE`, auto-`MKCOL` parents, 404 -> `Errors.FileNotFound`, multistatus
parsed via `DOMParser`), constructed from `{baseUrl, username, appPassword}` with Basic auth.
Exported from `cloud/index.ts`. **Verified** by a debug-menu entry **"Validate Nextcloud
Access..."** (`packages/app/studio/src/service/NextcloudDebug.tsx`): prompts for credentials,
then runs a live connect -> upload -> download (byte-verified) -> list -> delete round-trip and
reports the result.

Deferred to Step 6 (belongs with the persisted connection UI, not a one-off dialog): adding
`"Nextcloud"` to `CloudService` and a `CloudAuthManager` branch. The debug entry constructs the
handler directly, so the transport is fully exercised without that wiring.

### ✅ Step 5: Shared-folder sync
Done: `packages/studio/core/src/cloud/SharedFolderSync.ts` (exported from `cloud/index.ts`).
Implements §4 against a `CloudHandler`:
- `saveProject(handler, profile, progress)` -> uploads `projects/<uuid>/{project.od,meta.json,
  image.bin}`, enumerates the project's `AudioFileBox`/`SoundfontFileBox` references, and
  uploads each asset once into `assets/samples/<uuid>/` and `assets/soundfonts/<uuid>/`
  (reads the files straight from local storage; only a sample not present locally is fetched via
  the loader). **Dedup uses `index.json` as the source of truth** (the union of all projects' asset
  refs), not folder probing; an asset is recorded in the project's entry **only once it is actually
  present** (already known or uploaded this run), so a failed upload is left out and re-attempted on
  the next save (self-healing) and the catalog never claims an absent asset. A failed asset upload
  also deletes its partially-written folder. Updates `index.json`.
- `listProjects(handler)` -> reads `index.json` into `{uuid, meta}` entries.
- `openProject(env, handler, uuid, progress)` -> downloads `project.od`, decodes it, and
  downloads **only the assets missing from local OPFS**, returns a `ProjectProfile`.
Reachable in-app via **Nextcloud > Browse projects... / Upload project...** (Step 6). The debug
menu keeps only **"Validate Nextcloud Access..."** (`NextcloudDebug.validateAccess`), a connect ->
upload -> download -> list -> delete round-trip into a visible `openDAW/opendaw-connection-test/`
folder that is removed afterwards. Robustness learned during testing and folded in:
- WebDAV PUT to a missing parent returns **404** (not 409); `NextcloudHandler.upload` retries
  after creating parents on 404/409, and caches created collections to avoid MKCOL spam.
- Local asset presence is checked by **listing the parent folder**, not by opening the file
  (opening takes an exclusive OPFS handle that can hang when the engine holds the sample).
- Only the library **fetch** is time-bounded (60s); uploads are not, a 57 MB soundfont
  legitimately took ~1 min as a single PUT. (Dedup originally listed the shared asset folders; it
  now uses `index.json` as the source of truth instead, see `saveProject` above. Folder listing
  remains only for GC existence checks, `existingOrphans`.)
- The shared project is **self-contained**: every referenced sample is materialized (library
  samples are downloaded into local storage on demand via the loader) and uploaded,
  deduplicated by UUID. A sample that cannot be materialized (e.g. the openDAW library is
  unavailable) is **reported as a failure** (counted, name logged, warning in the result),
  never silently skipped, because whoever opens the shared project may not have library access.

### ✅ Step 6: UI
Done: a **"Nextcloud"** submenu in `StudioMenu.ts` directly below "Cloud Backup", icon
`IconSymbol.Nextcloud` (the brand logo, added to `IconSymbol` + `IconLibrary.tsx` as an SVG
symbol). Its children are **Browse...**, **Save...** (profile-gated) and **Disconnect** (shown only
while connected). It runs the connection
dialog (`NextcloudDialogs.showCredentialsDialog`, extracted from the debug entry and reused by
it), an `alive()` check, then the project browser (`project/NextcloudBrowser.tsx`, modelled on
`ProjectBrowser`). The browser reads `index.json` once and shows a count line
(`N projects · M samples · K soundfonts`), lets you **delete** a project (with GC of orphaned
assets, see §4; behind a progress bar that advances over the project-folder delete, each orphan
asset delete, and the catalog upload — `deleteProject` takes a `Progress.Handler`) and **open** one
(downloads only locally-missing assets, behind a cancellable progress bar). Asset counting is instant because refs
live in `index.json`. A delete tears the browse dialog down (the delete-progress dialog clears
`Surface.flyout`, which holds the browse dialog), so the browser signals `reopen` and
`NextcloudDialogs.browse` loops to **recreate** a fresh browse dialog with the updated catalog.

**"Save to Nextcloud..."** (`NextcloudDialogs.save`, `selectable` only with a profile) runs the
credentials dialog + `alive()` then `SharedFolderSync.saveProject` behind a cancellable progress
bar, and reports any assets that failed to upload. The debug "Sync Project to Nextcloud..." entry
remains as a save+list+reopen round-trip test.

**Load strategy (after open):** a Nextcloud project, once downloaded and ready, is **persisted
into local OPFS** so it becomes a normal saved project (`NextcloudDialogs.store`). If a project
with the **same UUID already exists locally** (`ProjectStorage.exists`), it asks: **Override**
(default; overwrite the local copy at the same UUID with the Nextcloud version) or **Copy** (prompt
for a name, then write under a fresh UUID via `Project.copy()`, leaving the existing one intact);
Escape/cancel aborts without installing. No conflict: it is written under its own UUID. Both the
override and no-conflict paths reuse `ProjectProfile.saveAs` on the unsaved profile (writes at the
current UUID and marks it saved). Note: the `ProjectProfile` constructor reads meta back from the
copied graph's `ProjectMetaBox`, so the **Copy** path applies the chosen name via `saveAs(newMeta)`
(not the constructor arg), otherwise the copy keeps the old name.

**Transient-failure robustness:** `NextcloudHandler` retries on transient network failures
(`ERR_HTTP2_PROTOCOL_ERROR`, dropped connections) and transient statuses — **423 (WebDAV file
lock)** plus 502/503/504 — via `Promises.guardedRetry` (up to 4 attempts, 1s apart). Both the read
path (`#fetch`: GET/PROPFIND/DELETE/MKCOL/MOVE) and the upload path (`#put`, idempotent within a
chunk session; its XHR `onload` rejects on a transient status so the retry sees it) are covered;
aborts are never retried and surface as `AbortError`. Prompted by an intermittent
`ERR_HTTP2_PROTOCOL_ERROR` on a `project.od` download and a `423 Locked` on an `index.json` PUT
during delete, both of which succeed on retry. Delete's orphan-asset GC (`deleteOrphans`) also lists
each shared asset folder once and only DELETEs assets that exist, so a stale catalog reference no
longer logs a 404.

**Pre-launch hardening (review pass):** dedup now trusts `index.json` and only records present assets
(self-healing, see Step 5); a failed asset upload deletes its partial folder; `readCatalog` parses
defensively (malformed/missing `projects` -> empty catalog instead of throwing); `alive()` reports a
clear message on **401** (bad credentials) and uploads report a clear message on **507** (quota
full); the per-request abort listener in `#putOnce` is detached on settle so it cannot accumulate on
the shared signal across a multi-asset upload.

**Connection (always prompt, per-user):** `ensureConnection` **always shows** the credentials
dialog and validates with an `alive()` check before each browse/upload, so a different Nextcloud
**user** can be chosen every time — essential for classrooms where each student logs in as their own
account (isolation comes from separate Nextcloud accounts; app passwords are unscoped). There is no
in-memory session cache and no "Disconnect" entry (both removed). Only the **server URL**
(non-sensitive) is remembered across reloads in `localStorage` (`nextcloud.server-url`) to pre-fill
the dialog; **username and app password are never stored or pre-filled**. The credential inputs sit
in a `<form>` (so the browser/password-manager does not warn about a password field outside a form;
submit is handled manually). Making `<form>` accept element children required a small `lib-jsx` types
fix (`RemoveIndexSignature` in `types.ts`) so tags whose DOM interface carries index signatures
(`HTMLFormElement`, `HTMLSelectElement`, …) no longer collapse their JSX children to `string`.
Login Flow v2 (§3) remains the deferred nicer-UX option.

**Configurable base folder (Step A) — built then REVERTED.** A `baseFolder`/`#resolve` prefix was
added to scope all I/O under a chosen subfolder, so each student's space could be a Team Folder
subfolder (`Classroom/<student>`) browsable by a teacher. It worked technically, but the **teacher
access via Team Folders + ACLs proved unworkable for schools**: the setup is admin-grade and very
fiddly (deny-by-default vs grant-by-default, parent-traversal 403/409, "denied at the folder can't be
re-allowed" blocking read on subfolders, and a real Nextcloud 34 sub-admin bug, server#61013, that
breaks editing an existing user's groups). The base-folder code (handler `#resolve`/`baseFolder`,
the dialog Folder field) and the manual's shared-folder option were reverted; openDAW is back to the
simple **per-student-account** model (data at the account root). Conclusion: proper teacher access
needs a **custom Nextcloud app** (expanded Step 7) or an admin-run **provisioning script** (OCS API),
not client-side base folders + manual ACLs. See §6.

### Step 7 (later): own openDAW connector app
Package the CORS allowlist as our own Nextcloud app (§1, Step 2) so schools get one-click
install instead of the WebAppPassword config step.

### Step 8 (ongoing): school installation manual
Standalone, school-facing manual for setting up a Nextcloud to work with openDAW. **Living
document, refine wording/screenshots as pilot schools test it.** Draft below.

#### Prerequisites
1. A Nextcloud instance where you are the **administrator** (self-hosted, or a managed instance
   such as Hetzner Storage Share where you hold admin). A free shared account on someone else's
   instance will not work, because openDAW needs an admin-level app install and origin setting.
2. A valid **HTTPS** certificate on the instance (browsers refuse cross-origin WebDAV to plain
   HTTP). Managed hosts and Let's Encrypt provide this automatically.

#### Part A: one-time instance setup (admin, done once for the whole school)
1. Sign in as the admin. Click your avatar (top right), then **Apps**.
2. Open the **Security** category, find **WebAppPassword**, click **Download and enable**. If it
   is not listed (locked-down hosting blocks the app store), install it manually: download the
   `webapppassword` release `.tar.gz`, upload the unpacked `webapppassword/` folder into the
   Nextcloud `apps/` directory via SFTP, then enable it under **Apps**.
3. Click your avatar, then **Administration settings**, then **WebAppPassword** in the left
   sidebar.
4. In the **WebDAV/CalDAV allowed origins** field, add `https://opendaw.studio`, then click
   **Set origins**. (No-app-store fallback: instead set `'webapppassword.origins' =>
   ['https://opendaw.studio']` in `config/config.php` via SFTP.)

#### Part B: create a student account (repeat per student)
Each student needs their **own** account, this is what keeps one student from changing or
deleting another student's work (a Nextcloud app password grants the full access of its account,
so a separate password on a shared account would not isolate anyone).
1. Sign in as the admin.
2. Click your avatar (top right), then **Users**.
3. Click **+ New account** (top left).
4. Fill in:
   1. **Username** (login name), for example `student-anna`. Keep it short, lowercase, no spaces.
   2. **Display name**, for example `Anna M.`.
   3. **Password**, set an initial one (the student can change it later under their own settings).
   4. **Email** (optional), lets the student reset their own password.
   5. **Quota** (optional), for example `2 GB`, to cap how much each student can store.
5. Click **Add new account**.
6. Repeat for every student. Tip: for a whole class at once, use **Users**, then the `...` menu,
   then **Import accounts** with a CSV file (`username,displayname,password,email,quota,...`).

That is all that is required for isolation: each student, signed in as their own account, only
ever sees and writes their own openDAW folder. No extra folder or permission setup is needed for
the isolated model. (If instead you want students to *collaborate* in one shared space, create a
**Group Folder** via the Group Folders app and the per-student configurable base folder, not yet
built, see §6.)

#### Part C: a student connects from openDAW (each student, once per session)
1. The student signs in to Nextcloud as their own account.
2. They click their avatar, then **Settings**, then **Security**, scroll to **Devices & sessions**,
   type a name like `openDAW`, and click **Create new app password**. Nextcloud shows a one-time
   app password, copy it.
3. In openDAW, open the **Nextcloud** menu, then **Browse projects...** (or **Upload project...**).
4. In the connect dialog enter: **Server URL** (e.g. `https://nextcloud.your-school.org`),
   **Username** (their login name), **App password** (the value from step 2), then **Connect**.
5. openDAW now lists/saves projects in that student's own space. The dialog appears every time, so a
   shared classroom computer can be used by different students in turn (no credentials are stored;
   only the server URL is remembered to save retyping).

### ✅ Step 9: Nextcloud chunked upload + upload progress + cancel
Done in `NextcloudHandler`: files over 10 MB use **chunked upload v2** (create session
`MKCOL uploads/<user>/<id>` with `Destination`, `PUT` each 10 MB chunk `00001..`, `MOVE .file`
with `OC-Total-Length`); smaller files use a single PUT. Verified end to end (a 57 MB soundfont
uploads via chunks; cross-origin MOVE + `Destination`/`OC-Total-Length` headers pass WebAppPassword
CORS). Uploads use **XHR** so `upload.onprogress` gives byte-level progress; `CloudHandler.upload`
gained an optional `progress?: Progress.Handler`. `SharedFolderSync.saveProject` reports an
**overall** `{value, label}` (project, then each asset fills its slice), shown as a progress bar.
**Cancel:** an `AbortSignal` is threaded into the handler (aborts in-flight fetch/XHR) and into
`saveProject`/`openProject` (checked between assets); the progress dialog's cancel button triggers
it and the run reports "Sync cancelled". Also fixed: `openProject` lists the project folder and
only downloads `image.bin` when present; dedup and parent-folder creation list directories instead
of probing/MKCOL-ing (no 404/405 console spam).

Console timings showed no code stall; slowness is network + per-request latency × sequential
uploads. **Deferred option:** parallelize asset uploads (concurrency ~5) for a large speedup on
many-file projects, at the cost of coarser progress. Not done; revisit if needed.

---

## 6. Open questions

- **Concurrency:** is a "shared project file" truly multi-writer, or is it shared assets plus
  per-student project copies? v1 = last-write-wins with a warning.
- **Asset GC:** resolved in Step 6. `index.json` holds the per-project reference graph; delete
  and re-save recompute the live set and delete orphaned asset folders (see §4).

---

## Appendix: Strato setup (webspace)

Concrete one-time host setup for the test instance in §5 Step 1. All in the Strato
**Kundenlogin** (strato.de), no command line.

### A. Subdomain (done)
`nextcloud.opendaw.studio` and its target folder `/nextcloud` are already created. The Web
Installer in step D goes into that folder.

### B. SSL/TLS (mandatory, already active)
Newer Strato hosting auto-provisions Let's Encrypt, so there is usually no tile to toggle.
`https://nextcloud.opendaw.studio` already serves over HTTPS, so this is done. Just confirm the
browser shows a **padlock with no warning**. Only if a cert warning ever appears: Kundenlogin
-> **"SSL verwalten"** tile (or **Domains -> SSL-Verwaltung**) and assign a certificate
covering the subdomain.

### C. Database (create it yourself, the installer does not)
Strato's MySQL user cannot create databases, so the Nextcloud installer cannot make one. You
create an empty one; Nextcloud then fills it with tables.
1. Kundenlogin -> **Datenbanken** (Databases) -> create a MySQL database.
2. Note the four values Strato assigns: **host** (e.g. `rdbms.strato.de`), **database name**,
   **user**, **password**. These go into the wizard in step E.

### D. Upload the Web Installer
1. Download `setup-nextcloud.php` directly from
   `https://download.nextcloud.com/server/installer/setup-nextcloud.php` (also under
   nextcloud.com/install -> Download server -> **Community projects** -> **Web installer**).
2. Upload it into the `/nextcloud` folder via SFTP (host, user, password from the Strato
   package; any SFTP client, e.g. Cyberduck or FileZilla).

### E. Run the installer
1. Open `https://nextcloud.opendaw.studio/setup-nextcloud.php`; it downloads and unpacks
   Nextcloud into the folder.
2. In the wizard: create the **admin account**, choose **MySQL/MariaDB**, and enter the four
   database values from step C. The **Database host** must be the Strato DB host
   (`rdbms.strato.de`), **not** `localhost`, see issue 1 below.
3. After login, go to **Administration -> Basic settings**, set background jobs to **Cron** or
   **AJAX**, and clear the security/setup warnings.

### F. Testing WebDAV (curl or GUI)
`curl` is a request tool preinstalled on macOS. Open **Terminal** (Cmd+Space -> "Terminal"),
paste the command from §5 Step 2, and replace `APPPASSWORD`. `-T` uploads a file; `PROPFIND`
lists a folder. It is only a manual check that the server accepts WebDAV before any code is
written. No-Terminal alternative: **Cyberduck** with connection type **WebDAV (HTTPS)**, server
`nextcloud.opendaw.studio`, your username + app password, then drag a file in.

### G. Issues encountered on this Strato webspace (and fixes)
Recorded from the actual install, all expected to recur on similar school hosting:

1. **DB error `SQLSTATE[HY000] [2002] No such file or directory`** during the wizard. Cause:
   `localhost` makes PHP try a Unix socket, but Strato's database is on a separate host. Fix:
   set **Database host = `rdbms.strato.de`** (the value from the panel), not `localhost`.
2. **App store unreachable: "Could not fetch list of apps from the App Store."** Strato
   webspace blocks PHP's outbound HTTPS to `apps.nextcloud.com`. The first-run *recommended
   apps* screen is then a dead end (its Skip button only renders once the store loads). Fix:
   navigate away manually to `https://nextcloud.opendaw.studio/index.php/apps/files/`; it is a
   one-time screen, not a gate.
3. **WebAppPassword shows "No matching results" in the in-app store search.** Filtered out
   because the store is unreachable / version-filtered. Fix: install manually, download the
   packaged release `.tar.gz` (apps.nextcloud.com/apps/webapppassword or the GitHub releases),
   upload the `webapppassword/` folder via SFTP into `/nextcloud/apps/`, then **Settings ->
   Apps -> Enable**. (v26.5.0 declares Nextcloud 22-34; if your NC ever exceeds that, bump
   `max-version` in `apps/webapppassword/appinfo/info.xml` before enabling.) **This is the key
   takeaway:** schools on locked-down hosting will need the manual route too, which is the
   argument for our own connector app (§5 Step 7) and the `config.php` origins fallback (§2).
4. **CORS origin match is exact, scheme included.** `https://localhost:8080` and
   `http://localhost:8080` are different origins. The allowlisted entry must match the dev
   server's actual scheme/host/port (here `https://localhost:8080`).
5. **SSL needed no action.** Strato auto-provisioned Let's Encrypt for the subdomain; there was
   no tile to toggle (appendix B).
