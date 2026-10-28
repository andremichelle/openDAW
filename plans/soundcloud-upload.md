# SoundCloud Upload

Upload the mixdown of the current project straight to the user's SoundCloud account, from the Project Info panel.

## Findings (tested by hand 2026-10-28, `public/soundcloud-test.html`)

1. SoundCloud app `t2NZPSxHxTi38C9g6gCMfMr7V1zjdEPa`, one app per account, one redirect URI:
   `https://opendaw.studio/auth-callback.html`. Login and upload work from production only.
2. Authorization code + PKCE works from the browser. The authorize page answers 403 `redirect_uri_mismatch` for any
   other origin.
3. The token exchange needs the client secret, PKCE alone answers 401 `invalid_client`. Refresh needs it too.
4. The token endpoint, `GET /me` and `POST /tracks` all accept CORS requests from our origin.
5. Access tokens live one hour. Refresh tokens are single use.
6. `POST https://api.soundcloud.com/tracks` (multipart `track[title]`, `track[sharing]`, `track[asset_data]`) answers
   201 with the track, including `permalink_url`. Uploaded audio cannot be replaced afterwards.

## Design

The secret stays on api.opendaw.studio. The browser only asks the server to swap the code for a token. The audio goes
directly from the browser to SoundCloud and never touches our server (Strato refuses bodies over 8 MiB anyway).

### Server (sibling repo `api.opendaw.studio`)

1. `soundcloud/config.php` holds client id and secret, gitignored like `music/config.php`, uploaded once by hand.
2. `soundcloud/token.php` takes `code`, `code_verifier`, `redirect_uri`, adds `client_id` + `client_secret`, posts to
   `https://secure.soundcloud.com/oauth/token` and returns the JSON unchanged.
3. Guards: POST only, `Access-Control-Allow-Origin: https://opendaw.studio` (not `*`), `redirect_uri` must equal the
   registered one, `grant_type` fixed to `authorization_code`.
4. No refresh endpoint. The refresh token is dropped and the user logs in again after an hour.

### Client

1. `CloudAuthManager` gets a third id, `SoundCloud`, in `boot.ts` next to Dropbox and Google Drive.
2. `#oauthPkceFlow` gets an optional token exchanger, so SoundCloud posts the code to `api.opendaw.studio/soundcloud/token.php`
   instead of the provider. Dropbox stays bit-identical.
3. A new `SoundCloudApi` in `studio-core/src/cloud/` (not a `CloudHandler`, that one is the backup file store) with
   `me()` and `upload(title, description, sharing, blob, progress)`. The upload uses `XMLHttpRequest` for upload
   progress, fetch has none.
4. The token is memoized for one hour like Dropbox. A 401 clears it, the next attempt logs in again.

### Project Info panel (`ui/info-panel/ProjectProfileInfo.tsx`)

1. A new block at the bottom, below the music page publish block, with the same layout: one line of text
   ("Upload your mixdown to SoundCloud") and an "Upload to SoundCloud" button.
2. The panel's fields are the track's metadata: Name → `track[title]`, Tags → `track[tag_list]`, Description →
   `track[description]`, Cover → `track[artwork_data]`. Artist is the SoundCloud account itself and is not sent.
   Every track is marked as made in openDAW: the description gets a last line "Made with openDAW
   https://opendaw.studio" (SoundCloud turns it into a link), and the tag "openDAW" is added to the tags. Possibly also
   `track[purchase_url]` = `https://opendaw.studio` with `track[purchase_title]` "Made with openDAW", which shows as a
   button on the track, to be tested on a free account first.
3. Like Publish, the button first saves the field values, then shows a small dialog with an "Upload privately"
   checkbox (`track[sharing]` private or public). No format choice, the song is uploaded as 24-bit WAV at 48 kHz.
   In the panel the row reads "Upload" as label and a "SoundCloud" button on the right.
   No quota check or warning, SoundCloud's error is shown if the account is out of upload time. The whole song is
   rendered, no section selector.
4. Flow: dialog, login if no valid token, render (progress dialog), encode, upload with progress and cancel.
5. Done notification shows the track link (`permalink_url`) with an "Open" button. Upload errors show SoundCloud's
   message.
6. Rendering reuses `OfflineEngineRenderer.start` and `WavFile.encodeInts24`, nothing new in the engine.

### Other

1. Privacy page: add SoundCloud to the cloud services paragraph (what is sent: the rendered audio, title, description).
2. Local and dev cannot log in (redirect URI). The menu entry is visible everywhere, the login fails with a clear
   message off production.

## Open questions

1. Send BPM from the project tempo and a genre field?

## Decided

1. Fire and forget: every click uploads a new track. Nothing is stored in the project, no `ProjectMeta` field, no
   update or delete from openDAW. The track is managed on SoundCloud afterwards.

## Phases

1. Server endpoint + deploy, verify with the test page against production.
2. `CloudAuthManager` exchanger + `SoundCloudApi`, verified with the test page replaced by the real flow.
3. Project Info panel block + dialog + upload flow.
4. Privacy page, delete `public/soundcloud-test.html`.
