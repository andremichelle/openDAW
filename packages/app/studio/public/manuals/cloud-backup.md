# Cloud Backup

openDAW supports privately synchronizing your projects in [Google Drive](action://backup-google-drive) and [Dropbox](action://backup-dropbox).  
Both services require a one-time **OAuth login**. OAuth is the official login method provided by many cloud services.

## Flow

- You log in directly on the provider’s website
- openDAW receives a secure access token from them
- openDAW never sees your password or personal data
- No personal data or assets are stored on openDAW servers
- Everything stays in your own cloud account

---

## How to run a backup

Every time you click openDAW menu > Cloud Backup > (Select service), openDAW synchronizes all projects and samples with
your connected cloud service, uploading new and changed files and removing those that were deleted locally.

## How it works

During backup, openDAW uploads new and modified files and updates its index.json catalog for each domain (projects and
samples). If a backup is aborted, some files may remain in the cloud without being referenced in the catalog. It is also
not recommended to modify or move the files directly in the cloud, as remote changes can confuse the backup system and
cause it to stop working as expected.

---

## How to remove your data and disconnect

### Google Drive

1. Go to [Google Drive settings](https://drive.google.com/drive/settings)
2. Click **Manage apps**
3. Find **openDAW** in the list
4. Choose one of the following:
    - **Disconnect from Drive** → removes openDAW’s access to your Drive
    - **Delete hidden app data** (if shown) → permanently deletes all files openDAW stored in your hidden appData space

### Dropbox (recommended, faster)

1. Go to [Dropbox connected apps](https://www.dropbox.com/account/connected_apps?utm_source=opendaw.studio)
2. Find **openDAW** in the list
3. Click **Disconnect**
4. When prompted, choose to also **delete all app folder data** if you want to remove files created by openDAW

---

Your projects are always under your control, and you can disconnect or delete them at any time.
