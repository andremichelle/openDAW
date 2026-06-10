# {icon:Nextcloud} Nextcloud

## What is Nextcloud?

[Nextcloud](https://nextcloud.com) is free, open source software for your own private cloud. Think
of it as a self hosted alternative to Dropbox or Google Drive: it runs on a server you (or your
school) control, gives every person their own account, and stores files you can reach from any
device.

A school typically runs one Nextcloud for many classes and students. The administrator creates an
account per student, and openDAW connects to each account to store that student's projects.

## How openDAW uses it

openDAW can read and write your projects directly in a **Nextcloud** instance you control, using
**WebDAV** (the standard protocol Nextcloud speaks for file access). Samples and soundfonts are
stored once in a shared `assets/` folder and reused across projects, so they are never uploaded
twice.

openDAW talks to your Nextcloud straight from the browser. Your files and credentials never pass
through an openDAW server.

Everything openDAW stores is kept inside a single **`openDAW/`** folder in your account, so the rest
of your Nextcloud is free for other apps. Please do not rename or edit those files by hand (a
`README.txt` in that folder says the same), as openDAW relies on its own catalog and shared assets.

---

## What you need

1. A Nextcloud instance where you are the **administrator** (self hosted, or a managed instance such
   as Hetzner Storage Share where you hold admin). A free shared account on someone else's instance
   will not work, because openDAW needs an admin level app install and an origin setting.
2. A valid **HTTPS** certificate on the instance. Browsers refuse cross origin WebDAV to a plain
   HTTP server. Managed hosts and Let's Encrypt provide this automatically.

---

## Set up Nextcloud for openDAW

Do this once for the whole school, as the admin.

> **Heads-up on the name:** the app you install below is called **WebAppPassword**, but despite the
> name it has nothing to do with per-user "app passwords". It is the small bridge that lets a browser
> app (openDAW) talk to your Nextcloud, by allowing requests from `opendaw.studio`. You install and
> configure it once, and students never need to create any kind of app password (see Connect from
> openDAW).

1. Sign in as the admin. Click your avatar (top right), then **Apps**.
2. Open the **Security** category, find **WebAppPassword**, then click **Download and enable**.
   If it is not listed (some locked down hosting blocks the app store), install it manually:
   download the `webapppassword` release archive, upload the unpacked `webapppassword/` folder into
   your Nextcloud `apps/` directory via SFTP, then enable it under **Apps**.
3. Click your avatar, then **Administration settings**, then **WebAppPassword** in the left sidebar.
4. In the **WebDAV/CalDAV allowed origins** field, add `https://opendaw.studio`, then click
   **Set origins**.
   If you cannot use the app store, set this instead in `config/config.php` via SFTP:
   ```php
   'webapppassword.origins' => ['https://opendaw.studio'],
   ```

### Test the connection (optional)

openDAW has a hidden tester that confirms the setup works before any student uses it.

1. In openDAW, open the menu, then **Preferences**, open the **Debug** section, and turn on
   **Enable Debug Menu**.
2. A new **Debug** entry now appears in the openDAW menu. Open it and click
   **Validate Nextcloud Access...**.
3. Enter the server URL, a username, and that account's password (your admin account works fine for
   this test), then confirm. openDAW runs a connect, upload, download, list, and delete round trip
   and reports whether it succeeded. A success message means WebAppPassword and the allowed origin
   are set up correctly.

---

## Create student accounts

Both options below need one Nextcloud account per student. Repeat this for every student.

1. Sign in as the admin.
2. Click your avatar (top right), then **Accounts** (called **Users** in older Nextcloud).
3. Click **+ New account** (top left).
4. Fill in:
   1. **Username** (the login name), for example `student-anna`. Keep it short, lowercase, no spaces.
   2. **Display name**, for example `Anna M.`.
   3. **Password**. Set one for the student. This username and password are exactly the credentials
      the student enters in openDAW.
   4. **Quota** (optional), for example `2 GB`, to cap how much each student can store.
5. Click **Add new account**.
6. Repeat for every student.

**Whole class at once:** on the **Accounts** page, open the {icon:MainMenu} menu (top left) and choose
**Import accounts**, then upload a CSV file with one row per student
(`username,displayname,password,quota`).

The student can change this password later in their own Nextcloud settings (**avatar**, then
**Settings**, then **Security**), if they want to or you advise them to. The username stays the same.

---

## Where projects are stored: two options

Pick one. The difference is **whether teachers can open and collect student work from inside
openDAW**. Both keep students fully isolated from each other.

- **Shared group folder** — projects live in a shared folder the teacher can also reach, so teachers
  can browse, open, and upload any student's projects. More one-time admin setup.
- **Personal accounts** — projects live in each student's own account. Nothing extra to set up, but a
  teacher cannot reach a student's projects from openDAW.

### Option 1: Shared group folder (teachers can browse and collect work)

This uses Nextcloud's official **Team Folders** app (formerly **Group folders**, app id
`groupfolders`) with one subfolder per student and per-subfolder permissions. Each student can write
only to their own subfolder, while the teacher can read and write all of them. The teacher uses their
**own** account, so no passwords are shared and a student changing their password never affects
teacher access.

1. **Install the app:** avatar → **Apps** → search **Team Folders** → **Download and enable**.
   (In older Nextcloud it is listed as **Group folders**; it is the same app. Do **not** install the
   similarly named third-party **Organisation Folders**, that is unrelated.)
2. **Create a class group:** avatar → **Accounts** → in the left sidebar click **Add group** (at the
   bottom of the sidebar) → name it e.g. `music-class`. Add every student to it (when creating each
   account, or by editing an account and setting its group). Add the teacher too, or make a separate
   `teachers` group.
3. **Create the team folder:** avatar → **Administration settings** → **Team Folders** → type a
   name, e.g. `Classroom` → add the group(s) with **read/write** → optionally set a quota.
4. **Enable Advanced Permissions (ACL)** on `Classroom`, and mark the teacher (or admin) as an
   **ACL manager** so they can edit the rules.
5. **Create one subfolder per student** inside `Classroom` (e.g. `Classroom/anna`, `Classroom/ben`).
   On each subfolder open its **permissions** and set: **allow** that student read/write, **allow**
   the teacher read/write, **deny** everyone else.
6. Students and the teacher then point openDAW at the subfolder with the **Folder** field (see
   Connect from openDAW): a student enters `Classroom/their-name`; the teacher enters the same path
   to review or collect that student's work.

Step 5 is repetitive for a whole class. For more than a handful of students, script it with the
`occ groupfolders:*` commands or the Group Folders ACL API instead of clicking each subfolder.

### Option 2: Personal accounts (simplest)

Nothing extra to set up. Each student just uses the account from **Create student accounts**, and
their projects live in their own Nextcloud space. When connecting, the **Folder** field stays
**empty**. A teacher cannot browse these projects from openDAW; to review work, the student shows it,
or the admin uses Nextcloud's server-side tools (the Impersonate app, or file access on the server).

---

## Connect from openDAW

Each student (and the teacher) does this on their own computer, and again whenever they sit at a
shared computer, because openDAW never stores the username or password.

1. In openDAW, open the **Nextcloud** menu, then **Browse projects...** (to open) or
   **Upload project...** (to save the current project).
2. In the connect dialog enter:
   1. **Server URL**, for example `https://nextcloud.your-school.org`.
   2. **Username**, the Nextcloud account name (created in Create student accounts).
   3. **Password**, that account's password.
   4. **Folder** — leave **empty** for Option 2 (personal accounts). For Option 1 enter the assigned
      group-folder path, e.g. `Classroom/anna`. The **?** next to the field explains this.
3. Click **Connect**.

The connect dialog appears every time, so different people can use the same computer in turn. Only
the server URL is remembered (to save retyping); the username and password are never stored.

**Only exception:** if an account has **two factor authentication** turned on, Nextcloud will not
accept the normal password here. That account then creates a one time **app password** in Nextcloud
(**avatar**, then **Settings**, then **Security**, then **Create new app password**) and uses that in
the **Password** field. Freshly created school accounts do not have two factor login, so this rarely
comes up.

## Using openDAW with Nextcloud

- **Browse projects...** lists everything in your space, shows how many projects and assets you
  have, lets you **open** a project (only the assets you do not already have are downloaded) and
  **delete** a project. Deleting also removes assets that no other project of yours still uses.
- **Upload project...** saves the current project and its samples and soundfonts. Assets already in
  your space are skipped, so re saving is fast.
- When you open a project that already exists on this computer, openDAW asks whether to **Override**
  it or save a **Copy** under a new name.

---

Your projects always live in your own Nextcloud account, under your control.
