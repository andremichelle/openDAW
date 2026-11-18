# {icon:Server} Custom Server

## What is a Custom Server?

A Custom Server keeps a backup of your projects, samples, presets and more on your own webspace, the same way
as the [Cloud Backup](/manuals/cloud-backup) with Dropbox or Google Drive. Instead of an account at a cloud
service, openDAW talks to one small PHP file that you upload to your webspace.

openDAW talks to that file straight from the browser. Your files and your token never pass through an openDAW
server.

---

## What you need

1. A hosting package with **PHP** (7.4 or newer). Most providers include it.
2. **HTTPS** for that webspace. Browsers refuse to send your backup to a plain HTTP address.
3. A way to upload a file, for example the file manager of your provider or SFTP.

---

## Set it up

1. Open **Backup & Sync > Custom Server** on the dashboard (or openDAW menu > Backup > Custom Server) and click
   **Sync**.
2. Click **Accept and Download**. openDAW creates a new personal token and saves `opendaw.php` with that token
   inside.
3. Upload `opendaw.php` to your webspace, for example into a folder named `openDAW`.
4. Enter the address of the file or of its folder, for example `https://example.com/openDAW/`, and click
   **Connect**. The backup starts right away.

The token field is filled in for you. Keep the token in your password manager (the browser offers to save it
when you connect) or click **Copy**. You need it again in another browser, on another computer, or on
another openDAW address.

---

## Run a backup

Every time you click **Custom Server**, the dialog opens with your server address and token filled in. Click
**Connect** to start the backup. openDAW uploads new and changed files and downloads what is missing in this
browser, so the same server keeps several browsers and computers in sync.

---

## Another browser or computer

Open **Custom Server**, enter the same address and token, and click **Connect**. The backup brings your
projects and samples into this browser. You do not need to upload the file again.

---

## Change or forget the server

**Forget** removes the address and token from this browser. Your backup stays on the server.

Clicking **Accept and Download** again creates a new token and a new server file. A new token starts an empty
backup, the old backup stays where it is until you delete it.

---

## What is stored on your webspace

The server file keeps your backup in a folder named `opendaw-data-` followed by a long random code, next to
`opendaw.php`. On Apache servers that folder is closed to visitors, on all others its random name keeps it
hidden. Every file in it carries an extra `.bin` ending, so nothing
in it can ever run as a script. Please do not rename or edit those files by hand, openDAW relies on its own
catalog.

When openDAW offers a newer server file, download it and replace `opendaw.php` on your webspace. Your backup
stays as it is.

---

## Remove your data

Delete `opendaw.php` and the `opendaw-data-...` folder from your webspace, then click **Forget** in openDAW.

---

## Your responsibility

You run the file on your own server and are responsible for its security, backups, limits and costs. openDAW
accepts no liability for data loss, unauthorised access or any other damage. Keep your token secret, anyone
who has it can read and delete your backup.
