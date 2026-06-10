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

## Part A: one time instance setup (admin)

Do this once for the whole school.

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
3. Enter the server URL, a username, and an app password (see Part C for how to create one), then
   confirm. openDAW runs a connect, upload, download, list, and delete round trip and reports
   whether it succeeded. A success message means WebAppPassword and the allowed origin are set up
   correctly.

---

## Part B: create a student account

Repeat this for every student. Each student needs their **own** account. This is what stops one
student from changing or deleting another student's work. A Nextcloud app password grants the full
access of its account, so handing out different passwords for one shared account would **not**
isolate anyone.

1. Sign in as the admin.
2. Click your avatar (top right), then **Users**.
3. Click **+ New account** (top left).
4. Fill in:
   1. **Username** (the login name), for example `student-anna`. Keep it short, lowercase, no spaces.
   2. **Display name**, for example `Anna M.`.
   3. **Password**. Set an initial one. The student can change it later in their own settings.
   4. **Email** (optional). Lets the student reset their own password.
   5. **Quota** (optional), for example `2 GB`, to cap how much each student can store.
5. Click **Add new account**.
6. Repeat for every student.

**Whole class at once:** on the **Users** page, open the {icon:MainMenu} menu (top left) and choose
**Import accounts**, then upload a CSV file with one row per student
(`username,displayname,password,email,quota`).

That is all the isolation you need. Signed in as their own account, each student only ever sees and
writes their own openDAW folder.

---

## Part C: connect from openDAW

Each student does this on their own computer (and again whenever they sit down at a shared computer,
because openDAW never stores the username or password).

1. Sign in to Nextcloud as your own account.
2. Click your avatar, then **Settings**, then **Security**. Scroll to **Devices & sessions**, type a
   name such as `openDAW`, then click **Create new app password**. Nextcloud shows a one time app
   password. Copy it now, it is not shown again.
3. In openDAW, open the **Nextcloud** menu, then **Browse projects...** (to open) or
   **Upload project...** (to save the current project).
4. In the connect dialog enter:
   1. **Server URL**, for example `https://nextcloud.your-school.org`.
   2. **Username**, your login name.
   3. **App password**, the value you copied in step 2.
5. Click **Connect**.

openDAW now lists and saves projects in your own Nextcloud space. The connect dialog appears every
time, so different students can use the same computer in turn. Only the server URL is remembered
(to save retyping); the username and app password are never stored.

---

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
