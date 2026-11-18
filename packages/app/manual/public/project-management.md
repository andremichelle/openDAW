# Project Management

openDAW stores everything locally on your device. There is no account and no server holding your music, so it is worth knowing where your projects live, how to back them up, and how to share them.

## Where your projects are stored

Projects, samples and soundfonts are saved in your browser's [private file system](/manuals/private-file-system) (OPFS), a storage area that belongs to opendaw.studio on your device. Save your project with **Ctrl/Cmd + S** or via **openDAW menu > Save**. Saved projects appear in the **Projects** list on the dashboard, where you can reopen, rename or delete them. **Save As...** creates a copy under a new name, and **Save as Template...** stores the current project as a starting point for new ones.

Because this storage belongs to the browser, it is also cleared with it: deleting site data, uninstalling the browser or switching to another device or browser profile means your projects will not be there. For anything you care about, keep a backup.

## Backing up to your own cloud

openDAW can synchronize all projects and samples with a cloud account you control. Your files go directly from your browser to your provider, never through openDAW servers.

- [Google Drive and Dropbox](/manuals/cloud-backup) via **openDAW menu > Cloud Backup**. A one-time OAuth login connects the account, every further backup is one click.
- [Nextcloud](/manuals/nextcloud) for a self-hosted cloud, ideal for schools where every student has an account on one server.

Both are also reachable from the **Backup & Sync** section on the dashboard.

## Sharing a project with a friend

Export a **Project Bundle** via **openDAW menu > Export > Project Bundle...**. This creates a single `.odb` file containing the project, its cover and all samples and soundfonts it uses, so it plays identically anywhere. Send it like any file.

Your friend opens it with **Open Bundle** on the dashboard or via **openDAW menu > Import > Project Bundle...**. Importing never overwrites an existing project, it always creates its own copy.

To exchange a project with another DAW instead, use **Export > DAWproject...**, the open [DAWproject](https://github.com/bitwig/dawproject) format supported by several DAWs.

### What a DAWproject carries

A DAWproject exported by openDAW comes back into openDAW with its tracks, regions, clips, automation, sends, groups, markers, tempo and signature changes, and every device with its settings. Another DAW sees the arrangement and the mixer, and openDAW's own devices by name only. WebCLAP plugins travel as CLAP plugins, so a DAW with the same plugin installed loads it with its sound.

The format has no place for grooves, key and chord tracks, note chance and repeats, region gain, curve shapes of automation and fades, or the loop area. These are left out. When a file holds something openDAW cannot read, the import lists what was skipped or replaced.

Importing a DAWproject from another DAW replaces plugins openDAW does not have with a placeholder that keeps their place, and a CLAP plugin that exists as a WebCLAP is loaded with its settings.

## Working together instead

If you want to make music with someone rather than hand over a file, open a [Live Room](/manuals/live-rooms) and share the link. Everyone edits the same session in real time.
