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

```
openDAW/                         <- the shared folder (group-shared or share-linked)
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

**Garbage collection:** a shared `assets/` folder accumulates orphans when projects are
deleted. Out of scope for v1; add a later "compact shared folder" admin action that scans all
`project.od` files for live asset UUIDs and deletes the rest. Note this clearly so we do not
silently leak storage.

---

## 5. Implementation roadmap (do these in order)

**Status:** Steps 1–3 done. The browser CORS gate (Step 3) passed: a cross-origin `PROPFIND`
from `https://localhost:8080` to `nextcloud.opendaw.studio` returned a full listing via
WebAppPassword. Approach validated end to end. Next: Step 4.

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

### Step 5: Shared-folder sync
New module implementing §4 (read/write `index.json`, exists-then-upload assets, open downloads
only missing assets). Reuse encode/decode from `ProjectBundle.ts` / `CloudBackupSamples.ts`.

### Step 6: UI
"Open from / Save to Nextcloud" in `StudioMenu.ts`, plus the connection dialog and an
`index.json` project browser.

### Step 7 (later): own openDAW connector app
Package the CORS allowlist as our own Nextcloud app (§1, Step 2) so schools get one-click
install instead of the WebAppPassword config step.

### Step 8 (ongoing): school installation manual
Write a standalone, school-facing manual for setting up their own Nextcloud to work with
openDAW: prerequisites (admin access, app installs allowed), install WebAppPassword (store or
manual SFTP fallback), allowlist `opendaw.studio`, create the shared folder, and connect from
openDAW. Distil it from §2 and appendix G as the real flow stabilises. **Living document,
update this step as each preceding step lands and as we learn more from pilot schools.**

---

## 6. Open questions

- **Concurrency:** is a "shared project file" truly multi-writer, or is it shared assets plus
  per-student project copies? v1 = last-write-wins with a warning.
- **Asset GC:** the shared `assets/` folder accumulates orphans on delete. Accept in v1, add a
  "compact shared folder" tool later.

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
