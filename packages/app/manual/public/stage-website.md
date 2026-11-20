# {icon:Share} Stage Website

## What is a Stage Website?

A Stage Website is your own music website for the tracks you make in openDAW. You put it on your own webspace,
and openDAW publishes your projects to it: the mixdown, the cover, the project info and, if you want, the
project itself, so listeners can open it in openDAW.

Visitors listen to your tracks with a waveform player, and with Google login they can like, comment and follow
you. You moderate everything on a private admin page. The design is plain HTML and CSS that you can change.

openDAW sends your tracks straight from the browser to your website. Nothing passes through an openDAW server.

---

## What you need

1. A hosting package with **PHP** (8.1 or newer) and **HTTPS**. Most shared hosts include both.
2. A way to upload files, for example the file manager of your provider or SFTP.
3. The website files: download the zip of the
   [latest release](https://github.com/andremichelle/opendaw-stage/releases/latest) ("Source code (zip)"). The
   README in it lists the server requirements in detail.

---

## Set it up

1. Unpack the zip and upload the contents of its folder to a folder of your webspace, for example
   `https://example.com/music/`.
2. In openDAW, open your project, switch to **Project Info** and click **Stage**.
3. Click **Create** next to Token. openDAW creates your personal token and copies it to the clipboard. Keep it
   in your password manager.
4. Open `https://example.com/music/setup.php`, enter a title, the token and an admin password, and click
   **Set up**.
5. Back in openDAW, enter the address of your website and click **Publish**.

For likes, comments, follow and the mails to your followers, the website needs a Google login and a mail
sender. The MANUAL in the website files explains both step by step.

---

## Publish a track

openDAW saves your project, renders the mixdown and uploads it with the cover, name, artist, tags, description
and tempo from the project info. A cover is required.

1. **Allow opening in openDAW:** uploads the project with its samples, so listeners can open it in openDAW and
   continue with it.
2. **Allow downloading the mixdown:** shows a download button for the mixdown on your website.

Publishing the same project again replaces its track: the address, likes and comments stay, the mixdown, cover
and info are updated, and the comments show "Updated". openDAW says **Republished**.

---

## Change or forget the website

The dialog remembers the address and token in this browser. **Forget** removes them. Your website stays as it
is. To use a new token, click **Create**, then enter the new token on the admin page of your website under
**Settings**.

---

## Your responsibility

You run the website on your own server and are responsible for its security, backups, limits and costs, and for
everything you publish on it. Make sure all samples, soundfonts and images are cleared of copyright. openDAW
accepts no liability for data loss, unauthorised access or any other damage. Keep your token secret, anyone who
has it can publish to your website.
