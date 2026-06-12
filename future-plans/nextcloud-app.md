# Custom Nextcloud app: feasibility and effort

## The request (for context)

Analyse the effort to create a custom Nextcloud app and whether it covers all our requirements:

1. Add CORS
2. Manage classrooms with students (add, remove, move, ...)
3. Students would have their own project folder
4. Assets should be shared for ALL students (no duplicates on the Nextcloud instance)
5. Teachers can upload projects to each student, or batch upload to all students in one classroom
6. Teachers get notified on new uploads by students
7. Anything else?

The UI should be dead simple. No rights management, just adding students and everything is good to
go. Double-check whether this app would even be possible with Nextcloud.

## Verdict

Yes, all seven are possible, and a custom app is actually the right architecture, because the app's
backend enforces the rules instead of the fragile Team Folder plus ACL setup we just fought. The key
shift: openDAW talks to the app's own REST API (CORS enabled), not raw WebDAV, so the app does all
the file work with privileges and the teacher UI needs zero permission management.

## Responsibilities and roles (studio vs app)

This is a separate feature from the current generic Nextcloud connect. The current system stays as is
(personal accounts, raw WebDAV, no app). The Classroom feature connects to our custom app.

**Single connect.** The studio sends server URL plus credentials, and the login returns the user's
role (student or teacher) and the roster. There is no "connect as teacher / connect as student"
choice, and no classroom configuration in the studio.

### openDAW studio
- One connect flow. The role from the login decides the view.
- Student view: browse, open, and upload your own projects.
- Teacher view: read access to all student projects, shown as a tree of student folders with their
  projects inside.
- Distribution: pick a project, "Upload to...", then select students or the whole class.
  Distribution lives in the studio because only the studio understands project files.
- All project and asset handling stays in the studio.
- No classroom management and no config in the studio.

### Nextcloud app
- CORS for `opendaw.studio`.
- Accounts, groups, and all classroom management (add, remove, move students) in its own Nextcloud
  UI.
- Returns the role and roster to the studio on login.
- Stores blobs only: per-student project storage, one shared deduplicated asset store, access
  control, and teacher notifications.
- Never parses or assembles projects. It is storage plus roster plus rules.

### Templates (teacher uploads)
- A project a teacher uploads into a student's folder is a template.
- It is immutable for the student. The student cannot override it.
- Opening a template creates a copy in the student's own space, so the original stays intact. The
  studio performs the copy on open (it understands projects). The app keeps the template read-only
  for the student.

### Distribution flow
- The studio (as teacher) reads the roster from the app, the teacher picks targets in "Upload to...",
  and the studio writes the project into each selected student's folder as a template through the
  app's authorized write API. The app only checks that this teacher may write to those students.

## Feasibility per requirement

1. **Add CORS.** Yes. A Nextcloud app exposes API controllers with the `#[CORS]` attribute plus an
   OPTIONS preflight route. Those endpoints accept Basic auth or an app token (not cookies), which is
   exactly how openDAW would call them from the browser. The `opendaw.studio` allowance is baked into
   the app, replacing the WebAppPassword step.
2. **Manage classrooms (add, remove, move students).** Yes. The app creates accounts and groups in
   PHP via `IUserManager::createUser` and `IGroupManager::createGroup`, and moves members between
   groups. A "classroom" is just a group plus an app database record.
3. **Per-student project folder.** Yes. The app backend creates and owns each student's storage.
   Because openDAW goes through the app API, the app decides where projects live and enforces that a
   student only touches their own.
4. **Shared assets, no duplicates, no trolling.** Yes, and this is the big win. openDAW uploads
   assets through the app, which stores each one once, content addressed by UUID, in a store only the
   app writes to. Students never get direct write access to the asset store, so no one can delete or
   overwrite a shared asset. This is the requirement that was basically unsolvable with raw WebDAV
   plus ACLs, and it falls out naturally with an app-mediated API.
5. **Teacher uploads to one student or batch to a whole class.** Yes. The teacher calls one app
   endpoint ("distribute project X to classroom Y") and the backend writes it into each student's
   space, reusing the already-stored shared assets.
6. **Notify teacher on student uploads.** Yes. On upload the app fires a Nextcloud notification
   (`OCP\Notification`) to the teacher, optionally an email digest.
7. **Dead-simple UI, no rights management.** Yes, because of the above. There are no ACLs for a
   teacher to touch. The teacher screen is "add student / remove student", and the app sets up
   everything behind the scenes.

So nothing on the list hits a Nextcloud wall.

## Anything else to plan for

- **Identity**: simplest is one real Nextcloud account per student, provisioned by the app (auth then
  comes for free). Lightweight in-app identities would mean building auth yourself, which CORS
  endpoints do not give you. Use accounts.
- **Large uploads**: soundfonts can be 50 MB or more, so the asset endpoint needs chunking, or large
  assets stay on a direct upload path. Plan for it.
- **Asset garbage collection**: refcount assets in the app database so deleting a project can free
  truly unused assets.
- **Install on locked-down school hosting**: the app must also install via SFTP, like WebAppPassword,
  since some hosts block the app store.
- **App store review**: a hardcoded CORS origin may draw scrutiny in review. Workable, but expect
  questions.
- **Version maintenance**: Nextcloud major versions move fast (we saw Group to Team folders and a
  sub-admin bug). Ongoing upkeep is a real cost.
- **openDAW side**: a new transport that speaks the app API instead of WebDAV. This is meaningful
  openDAW work, not just server work.
- **Quotas, backup, export, GDPR**: per-student quota, and the strong selling point that all data
  stays on the school's server.

## Effort

This is a real project, not a weekend. Components:

- App backend (PHP): API controllers (CORS), classroom/student model, project plus shared-asset store
  with dedup and refcount GC, distribution, notifications.
- Teacher UI (Vue, the Nextcloud frontend stack): add/remove/move students, upload/distribute, see
  activity.
- openDAW integration: a new API-based transport, plus the connect/auth flow.
- Packaging: app store submission, manual install fallback, version testing.

Rough ranges for someone fluent in Nextcloud app development:

- MVP (CORS, provisioning, per-student projects, shared deduped assets, teacher distribute, basic
  notifications, minimal UI): about 4 to 8 weeks server side, plus 1 to 2 weeks openDAW side.
- Hardened and store-published (chunked uploads, GC, polished UI, multi-version testing): add several
  more weeks, then ongoing maintenance.

The largest risks are the openDAW-side transport rework and long-term version churn, not any missing
Nextcloud capability.

## Recommendation

It is feasible and it cleanly meets all seven, and it is genuinely simpler for teachers than the
WebDAV plus ACL route because the app owns the rules. The cost is a multi-week build in PHP plus Vue
plus openDAW changes, with continuous maintenance.

## Sources

- [CORSMiddleware](https://docs.nextcloud.com/server/13/developer_manual/api/OC/AppFramework/Middleware/Security/CORSMiddleware.html)
- [REST APIs (developer manual)](https://docs.nextcloud.com/server/stable/developer_manual/digging_deeper/rest_apis.html)
- [IUserManager](https://docs.nextcloud.com/server/13/developer_manual/api/OCP/IUserManager.html)
- [IGroupManager](https://docs.nextcloud.com/server/13/developer_manual/api/OCP/IGroupManager.html)
- [Notifications (developer manual)](https://docs.nextcloud.com/server/stable/developer_manual/exapp_development/tech_details/api/notifications.html)
