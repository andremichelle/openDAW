# Contests

A reusable contest page at `/contests/{name}`. The first contest is `2026`: an uplifting song for the openDAW feature reel. Entrants submit the project they have open. We receive an Opus mixdown plus the project bundle and inspect both in admin.

## Decisions

1. Contest definitions are JSON on the API server, one file per contest. A new contest needs no studio deploy.
2. The submission is the open project. The button reads "Upload {project name}".
3. Mixdown is Opus at best quality: 48 kHz, stereo, 510 kbps, complexity 10 (the `AudioFormats` Opus encoder).
4. Each submission is capped at 250 MB (mixdown and bundle together), checked in the browser and on the server.
5. The deadline is 6.12.2026 23:59:59 Cologne time (`2026-12-06T23:59:59+01:00`). A countdown shows days, hours, minutes and seconds. At zero the upload button is replaced by "Submissions closed" in the same space, so nothing jumps. The server rejects late uploads too.
6. One email can submit more than once. Each submission is added, none is replaced.
7. Prizes: 1st 250 EUR, 2nd openDAW sweatshirt, 3rd openDAW shirt.
8. The contest has its own terms, separate from /privacy. They must be accepted before the upload starts.
9. One submission per email every 24 hours. The contest page says so.
10. Each submission sends a notification email to andre.michelle@opendaw.org.
11. Submissions are only visible to us, in admin.opendaw.studio.
12. No jury is named on the page. The organiser judges.
13. openDAW's built-in samples, soundfonts and presets are allowed. AI-generated audio is not.
14. No grace period. An upload that finishes after the deadline is rejected.
15. Prizes ship worldwide.
16. Entries that do not win are deleted 3 months after the winners are announced.
17. Terms are in English only.
18. Opus is encoded with WebCodecs, falling back to FFmpeg Opus where WebCodecs cannot.
19. A header link sits between the left and right side, added only once the contest is officially announced.

## Contest JSON

`api.opendaw.studio/contests/{name}/contest.json`, fetched by the studio as a plain file (CORS and `Access-Control-Expose-Headers: Date` set in `contests/.htaccess`; the `Date` header gives the countdown the server clock). The endpoints read the same file, so the deadline and limits shown are the ones enforced:

1. `name`, `title`, `subtitle`
2. `deadline`: ISO 8601 with offset
3. `brief`: paragraphs (the uplifting song, what the reel is for)
4. `bonus`: "Bonus points for using openDAW devices instead of finished music loops, drum loops and soundfonts"
5. `prizes`: `[{place, label, detail, url?}]`. The shirts link to the shop: `https://opendaw-shop.fourthwall.com/en-eur/products/opendaw-sweatshirt` and `https://opendaw-shop.fourthwall.com/en-eur/products/opendaw-organic-cotton-shirt`
6. `rules`: list ("No copyright-infringing assets, all original work", ...)
7. `terms`: `{version, sections: [{heading, paragraphs}]}`. The version is stored with each submission.
8. `maxBytes`: 262144000
9. `maxSeconds`: 60. Measured at the end of the last region, converted with the tempo map. The page blocks the upload before rendering when it ends later ("“Morning Light” ends at 1:12, the limit is 1:00"). The mixdown itself may run longer, so reverb and delay tails render fully.
10. `cooldownHours`: 24

Name format `^[a-z0-9-]{1,32}$` in the client and the server.

## Studio (openDAW)

### Route
1. `{path: "/contests/*", factory: ContestPage}` in `App.tsx`.
2. `ContestPage` fetches the JSON. If it is missing it shows "Contest not found". While loading it shows a placeholder with the same layout.
3. Styling follows the studio pages (ManifestoPage/PrivacyPage sass, studio colours, no inline colours, no font sizes in dialog content).

### Design (agreed in the preview https://claude.ai/artifact/R9KE2X2PHetRiktpeKCwxZ)

#### General style
1. Studio colours and Rubik weight 300, body text in `--color-gray`.
2. Headings and labels in title case, never `text-transform: uppercase`.
3. Headings carry colour: hero h1 bold white with the year in blue, section headings green, sub headings orange, eyebrow ("openDAW Contest") cream.
4. Panels as in the dashboard: 8px radius, `rgba(white, 0.01)` fill, `rgba(white, 0.08)` border.
5. Inputs use the `form-element` mixin.
6. Buttons are the dashboard action pill: blue outline, blue text, white glow on hover.

#### Hero (full width, below the header)
1. Abstract background as inline SVG: dot grid, orange rings with a radial glow on the right, layered waveforms (blue, purple, orange, green, white) across the bottom, blue glow bottom left.
2. A dark gradient over the left side so the text is readable. The artwork stays at full strength on the right.
3. Left: the studio's `BackButton` component on top (purple "GO BACK TO STUDIO", Escape works too, goes to `/create` with a project open, else `/`), then eyebrow "openDAW Contest", h1 "2026" (blue) / "A Year of openDAW" (white), intro "openDAW grew a lot in 2026. To celebrate, we are making a reel of this year's new features, and we are looking for an uplifting song made in openDAW to go with it."
4. Right: countdown box (12px radius, translucent dark), heading "Submissions Close In" (orange), four cells Days, Hours, Minutes, Seconds (8px radius, blue numbers), below it "6 December 2026, 23:59 Cologne time (CET)". Ticks every second while the page is open.

#### Two columns below the hero (max 72em, they stack on narrow screens)
1. Left column:
   1. "The Brief": "An uplifting song for a short video celebrating the major features added to openDAW in 2026. Any genre, up to 1 minute."
   2. Bonus box (yellow star): "Bonus points for building your sound with openDAW's own devices instead of finished music loops, drum loops and soundfonts."
   3. "Prizes": three stacked rows (20px vertical padding). Place label, prize name on one line, detail on the right. The prize name has the colour of its place: 1st Place, 250 EUR, "Song Featured in the Reel" (orange). 2nd Place, openDAW Sweatshirt, "View in Shop" link (light grey). 3rd Place, openDAW Shirt, "View in Shop" link (darker grey). Under the rows: "Shipped free, worldwide."
   4. "Rules": all original work, no copyright-infringing assets. openDAW's built-in samples, soundfonts and presets are welcome. No AI-generated audio. One minute at most. Made in openDAW, we receive the mixdown and the project bundle. Submit as often as you like, once per email every 24 hours.
2. Right column:
   1. "Contest Terms": scroll box 200px high. The text fades 16px at top and bottom, the border does not (mask on an inner scroller). Each fade shows only while there is more text in that direction. No version label.
   2. "Submit Your Song":
      1. Name ("Name (shown in the credits)") and Email ("Email (only for contacting you)") side by side. The field name is title case, the note in brackets is not.
      2. Five required checkboxes: terms and data protection read, own original work without AI audio, not registered with a collecting society, licence granted, 18+ or 13+ with guardian consent
      3. Pill button "Upload “{project name}”"
      4. Note under it: "We render an Opus mixdown and send it together with the project bundle." / "Up to 250 MB · once per email every 24 hours"

#### Submit states (each keeps the 44px button height, nothing jumps)
1. Form incomplete: button disabled, "Fill in name and email and tick every box to upload."
2. Open a project to submit: disabled button with that text.
3. Uploading: progress bar in the button shape, "Uploading bundle · 62%", steps bundle, mixdown, Opus encoding, upload, "Please keep this tab open."
4. Received: green, "Thank you. “{project}” was received.", submission id below.
5. Within 24 hours of the last submission: disabled, "Next upload possible in HH:MM:SS".
6. Upload failed: red outline, "Upload failed · Try again".
7. Deadline passed: countdown at 00, dashed pill "Submissions closed · winners announced soon".
8. Song too long: disabled, "“{project}” ends at 1:12, the limit is 1:00", "Your last region must end within one minute. Reverb and delay tails may ring on."

### Upload flow (new `ContestSubmission.ts`, modelled on `PublishMusic.ts`)
1. `ProjectBundle.encode(profile.copyForUpload())`
2. `OfflineEngineRenderer.start(profile.project.copy(), Option.None, progress, undefined, 48_000)`
3. Encode Opus through the shared `AudioFormats` Opus format. If `isSupported()` is false, load `FFmpegWorker` and encode Opus there at the same settings.
4. Check the combined size against `maxBytes` before uploading
5. `contests/start.php` with name, email, contest, terms version, and the ticked checkboxes → `{upload}` or 429 (cooldown, with the time remaining) or 403 (closed)
6. 4 MiB chunks to `contests/upload-chunk.php?upload=&file=mixdown|bundle&offset=` (same resume and 409 logic as music)
7. `contests/finish.php?upload=` moves the chunks into the submission folder, writes `meta.json` and sends the mail
8. The submit button stays disabled during the upload, so there are no double submissions

### Header link (separate deploy, after the announcement)
1. A link in the studio header between the left and the right group, pointing to `/contests/2026`.
2. It is not part of the first release. Until then the page is reachable only by URL.

### To verify in the studio
1. The open project stays alive when navigating from the workspace to `/contests/2026` (`WorkspacePage` is `reuse: true`, the profile lives in `StudioService`).
2. The FFmpeg build includes the libopus encoder.

## API server (api.opendaw.studio, sibling repo)

### Files
No new location. Everything follows what the api already does: a feature folder inside the api host (like `music/` and `users/`), private files blocked by `.htaccess` (like `users/`), chunks in PHP's temp folder (like `music/chunks.php`).

```
api.opendaw.studio/contests/
  .htaccess                 CORS as in users/, private files denied
  start.php                 validate + rate limit + create pending upload
  upload-chunk.php          chunked body, 4 MiB
  finish.php                verify, assemble, meta.json, mail
  config.php                paths, limits, mail address (denied by .htaccess)
  2026/
    contest.json            public, read by the studio and the endpoints
  submissions/              never web reachable, in .gitignore
    .htaccess               deny all, no script execution
    .ratelimit.json         hashed email and hashed IP → timestamps (flock)
    2026/
      {yyyymmdd-hhmmss}-{id}/
        mixdown.opus
        bundle.odb
        meta.json

sys_get_temp_dir()/opendaw-contest-{upload}-{file}.part    pending chunks, stale ones removed after 24 h
```

`deploy.sh` only adds files and never deletes on the server, so a deploy never touches `submissions/`.

### meta.json
`{id, contest, name, email, projectName, submittedAt, termsVersion, consents: {...}, mixdownBytes, bundleBytes, encoder}`. The consents record proves what was accepted and when.

### Rules on the server
1. Reject when `now > deadline` in start, upload-chunk and finish. No grace period.
2. Rate limit: 24 h per email hash (lowercased, trimmed), recorded in finish so a failed upload does not block the entrant
3. Size: running total per upload ≤ `maxBytes`
4. Validate name length, email with `filter_var(FILTER_VALIDATE_EMAIL)`, all required consents true
5. Mail with PHP `mail()` (Strato). Subject `[Contest 2026] {name}: {projectName}`. Body: email, sizes, admin link. No attachments.
6. Strato body limit is 8 MiB, so 4 MiB chunks as in music
7. Every error answers `{error, code, retryAfter?}`. `error` is a sentence the page shows as is (for example "This email address submitted within the last 24 hours. You can submit again in 3 hours 12 minutes."), `code` lets the page pick the matching state.
8. The HMAC secret is created on first use in `submissions/.secret`. No host-only config file.
9. Space guard: start refuses with a clear message when the free webspace is below twice the submission plus 256 MB, and mails a warning at most once per hour. Zip bomb guard: unpacked bundle at most 4 × 250 MB.

## Security

Every upload is hostile until proven otherwise. A crafted request can skip the studio entirely, so the server trusts nothing the client sends.

### Nothing uploaded can run on the server
1. `contests/submissions/.htaccess`: `Require all denied`, `php_flag engine off`, `RemoveHandler .php .phtml .phar`, `RemoveType .php`, `Options -ExecCGI -Indexes`, `SetHandler none`. No URL serves an upload, and nothing in there can run even if the deny were lost.
2. Phase 1 verifies with curl that every path under `submissions/` answers 403, and that a `.php` file placed there is never executed.
3. The server chooses every file name: `mixdown.opus`, `bundle.odb`, `meta.json`. Client names are never used in paths.
4. Every id is checked by regex before use (`upload ^[a-f0-9]{32}$`, `contest ^[a-z0-9-]{1,32}$`, `file mixdown|bundle`), and the final path is checked with `realpath` to lie inside the data folder (no `..`, no symlinks).
5. No uploaded byte is ever passed to `exec`, `shell_exec`, `include`, `unserialize`, ffmpeg or an image library on the server.

### Content checks in finish.php
1. Mixdown: starts with `OggS` and contains `OpusHead`, otherwise rejected.
2. Bundle: starts with `PK\x03\x04` and opens with `ZipArchive`. Only the expected entries (`version`, `uuid`, project file, meta, cover, `samples/…`, `soundfonts/…`), no absolute paths or `..` in entry names, total uncompressed size capped (zip bomb).
3. Sizes: every chunk ≤ 4 MiB, running total ≤ 250 MB, checked before writing.
4. Assembly into a temp folder, then one atomic `rename` into `submissions/`. Half-finished uploads never appear.

### Upload sessions
1. start.php issues a random 128 bit upload id plus an HMAC token (server secret). upload-chunk and finish need both. Unknown or expired sessions are rejected.
2. Sessions expire after 24 h, their chunks are deleted.
3. Deadline checked on the server clock in start, every chunk and finish.

### Abuse and disk space (limits need your approval)
1. At most 4 started uploads per IP per hour (agreed). Proposal: at most 20 pending uploads at once (all users), and a total disk cap per contest (amount open). Above a cap start.php answers 503 and a warning mail goes out.
2. IPs only as salted hash, only for this limit, kept 24 h.
3. CORS only for `https://opendaw.studio` and `https://dev.opendaw.studio`, not `*`. This stops other websites using the endpoints from a browser, not scripts, which the checks above cover.

### Input and mail
1. Name ≤ 80 and email ≤ 254 characters, control characters stripped, email via `filter_var`.
2. meta.json written with `json_encode`, never string concatenation.
3. Mail: fixed `From` and `To`, user input never in a header. The subject has line breaks stripped (header injection).

### Admin side
1. Session-checked endpoints only. Files streamed with a fixed `Content-Type`, `Content-Disposition: attachment` for the bundle, `X-Content-Type-Options: nosniff`.
2. Name, email and project name rendered as text, never as HTML (XSS through the name field).
3. A bundle can contain scripts (script devices, script views) and WebCLAP code that run when the project opens. Open submissions in a separate browser profile, never in the profile logged into admin or other accounts. Check what the studio already sandboxes before the contest starts.
4. Mixdowns play in the browser's own decoder only.

## Admin (admin.opendaw.studio, sibling repo)

1. `?contests` opens a contests screen (before the catalogue router, which would rewrite the address). The catalogue sidebar has a "Contests · Submissions" entry, the contests screen links back to the catalogues.
2. Sidebar: one folder per contest with its count. List: submitted, project, name, email, mixdown and bundle size. Inspector: the fields plus Preview (play/stop the Opus mixdown, also double click on a row), Bundle and Mixdown downloads, Copy Email, Delete.
3. Endpoints, all behind `require_admin`: `contest-submissions.php` (list), `contest-file.php?contest=&id=&file=mixdown|bundle` (fixed type, nosniff, bundle as attachment), `contest-delete.php` (POST, removes the folder).
4. The mixdown is private, so the preview fetches it with the token and plays a blob url.
5. Path: `'contests' => getenv('CONTESTS_PATH') ?: '../../api.opendaw.studio/contests/submissions'`, ids checked by pattern and `realpath` inside that folder. Dev has no PHP, the screen works on the deployed admin only.

## Terms content (German law, to be checked by a lawyer)

The text is versioned in the JSON. This is not legal advice. With a cash prize, a lawyer should look at it once.

### Organiser and contest type
1. Organiser: openDAW, Cologne, Germany, hello@opendaw.org. This is a Preisausschreiben under §661 BGB: the deadline is stated, no jury is named, so the organiser judges (§661 (2) BGB), and the decision is final.
2. Judging criteria: uplifting character, musical quality, use of openDAW devices (bonus).
3. Winners are notified by email. If a winner does not reply within N days the prize passes on.
4. The organiser may disqualify entries that break the rules and may end the contest early for good reason.

### Eligibility
1. 13 or older. Under 18 needs consent of a parent or legal guardian (§§106 to 108 BGB, the licence grant is not purely advantageous). Checkbox: "I am 18 or older, or I am 13 or older and my parent or legal guardian agrees to these terms."
2. Winners under 18, and any entry used in the reel, must send a consent form signed by a guardian before payout or publication. A minor is credited only with that consent, an artist name is fine.
3. Excluded: the organiser and people involved in judging.

### Originality and third-party rights
1. The entrant created the work alone or holds all rights, including those of co-authors and performers (§§73 ff. UrhG, vocals and players).
2. No copyright-infringing assets. openDAW's built-in samples, soundfonts and presets are allowed.
3. No AI-generated audio. Checkbox together with the originality statement.
4. Collecting societies: if the entrant is a GEMA member (or PRS, SACEM...) the society holds the rights and the entrant cannot grant the licence below. The entrant confirms the work is not registered with a collecting society, or discloses it. Checkbox.
5. The entrant indemnifies the organiser against third-party claims from false statements.

### Licence grant (§31 UrhG, purposes must be named explicitly)
1. Non-exclusive, worldwide, royalty-free, unlimited in time
2. Purposes: the openDAW feature reel, its publication on opendaw.studio, YouTube, social media and in presentations
3. Editing: shortening, fading, mixing under voice-over and syncing to picture (§23 UrhG)
4. Attribution with the entrant's name or chosen artist name (§13 UrhG). The name field doubles as the credit, or add a separate "credit as" field?
5. Copyright stays with the entrant. They may release the song elsewhere.
6. The licence applies to the winning and selected entries. Entries that are not used get no licence beyond judging. Withdrawal is possible until judging, after which the licence for a selected entry cannot be revoked.
7. Checkbox: "I grant openDAW the licence described above."

### Prizes
1. 250 EUR via bank transfer or PayPal. Taxes are the winner's responsibility.
2. Shirts are shipped free, worldwide. Customs duties in the winner's country are the winner's responsibility.
3. No cash alternative for physical prizes, prizes cannot be transferred

### Data protection (Art. 13 GDPR, inside the contest terms)
1. Controller: the organiser
2. Data: name, email, project bundle, mixdown, time of submission
3. Purpose and legal basis: running the contest, Art. 6(1)(b) GDPR.
4. Recipients: hosting provider (Strato, Germany), mail provider for the notification. No transfer outside the EU (check the mail provider for opendaw.org).
5. Retention: non-winning entries and contact data deleted 3 months after the winners are announced. Winners kept as long as the reel is published, plus legal retention for the payout.
6. Rights: access, rectification, erasure, restriction, objection, withdrawal of an entry, complaint to the supervisory authority (LDI NRW).
7. Checkbox: "I have read the terms and the data protection information."

### Other
1. German law. Mandatory consumer protection of the entrant's home country stays in force.
2. Liability limited to intent and gross negligence, except for injury to life, body and health.
3. Terms in English only.

## Phases

1. API server: contest.json for 2026, the endpoints, rate limit, mail. Tested with curl.
2. Studio: route, page, countdown, form, upload with the FFmpeg fallback. Browser check on DEV.
3. Admin: contests catalogue, list, player, bundle download, delete.
4. Terms text final, lawyer check, then PROD (page reachable by URL only).
5. After the official announcement: header link, PROD.
6. 3 months after the winners are announced: delete the non-winning entries in admin.

## Open

1. Pending uploads cap (proposal 20) and the disk cap per contest (needs the free Strato quota).
2. What the studio already sandboxes when a foreign bundle with scripts or WebCLAPs is opened.
