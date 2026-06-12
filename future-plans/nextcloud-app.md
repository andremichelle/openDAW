# openDAW Nextcloud Classroom app

## Intro

The Classroom feature is separate from openDAW's existing generic Nextcloud connect, which stays as
is. This specification covers the Classroom feature, which connects to a custom Nextcloud app.

The app backend owns identity, storage, and access rules. The studio talks to the app's own REST API
(CORS enabled) and stays a thin client.

Single connect: the studio sends server URL plus credentials, and the login returns the user's role
(student or teacher) and the roster. There is no classroom configuration in the studio.

## Requirements

Each requirement notes which side does the work: the **app** (Nextcloud) or the **studio** (openDAW).

1. **App:** add CORS for `opendaw.studio` so the studio can call the app from the browser.
2. **App:** manage classrooms and students (add, remove, move) in the app's own Nextcloud UI.
3. **App:** give each student their own project storage.
4. **App:** keep one shared, deduplicated asset store for all students, so there are no duplicates on
   the Nextcloud instance.
5. **Studio:** a teacher uploads a project to one student, or batch-uploads to a whole classroom,
   from the studio ("Upload to...").
6. **App:** notify the teacher when a student uploads a project.
7. **Studio:** the teacher view reads all student projects, shown as student folders with their
   projects inside.
8. **App + studio:** a teacher upload is a template. The app keeps it read-only for the student, and
   the studio creates a copy when the student opens it.
9. **App:** the login returns the user's role, and the studio uses it to show the matching view.

Constraint: both UIs must be dead simple, with no rights management anywhere. In the app, classroom
setup is just adding students. In the studio, there is no configuration at all.

## Nextcloud app (server side)

The app owns identity, storage, and the rules. It never parses or assembles projects. It is storage
plus roster plus rules.

Responsibilities:

- CORS for `opendaw.studio`. Verified: app API controllers use the `#[CORS]` attribute plus an OPTIONS
  preflight route, authenticated by Basic auth or a token, not cookies.
- Accounts, groups, and all classroom management (add, remove, move students) in its own Nextcloud
  UI. Verified: `IUserManager::createUser`, `IGroupManager::createGroup`.
- Returns the role and roster (a teacher's classrooms and students) to the studio on login.
- Storage only: per-student project storage and one shared deduplicated asset store (content
  addressed by UUID, written only by the app), plus access control.
- Teacher notifications on student uploads. Verified: `OCP\Notification`.
- Keeps teacher-uploaded projects read-only for the student (templates).

Shared asset store: students never get direct write access to it. The app is the only writer, so an
asset cannot be deleted or overwritten by a student, which gives both deduplication and tamper
safety.

## Studio app (openDAW side)

The studio is a thin client. It holds no permission logic and no provisioning logic.

- One connect flow. The role from the login decides the view.
- Student view: browse, open, and upload your own projects.
- Teacher view: read access to all student projects, shown as a tree of student folders with their
  projects inside.
- Distribution: pick a project, "Upload to...", select students or the whole class, then the studio
  writes the project into each selected student's folder as a template through the app's authorized
  write API. Distribution lives in the studio because only the studio understands project files.
- Templates: opening a template creates a copy in the student's own space, so the original stays
  intact. The studio performs the copy on open.
- All project and asset handling stays in the studio. No classroom management and no config in the
  studio.

## Misc

Things to plan for:

- Identity: one real Nextcloud account per student, provisioned by the app, so auth comes for free.
- Large uploads: soundfonts can be 50 MB or more, so the asset endpoint needs chunking, or large
  assets stay on a direct upload path.
- Asset garbage collection: refcount assets in the app database so deleting a project can free unused
  assets.
- Install on locked-down school hosting: the app must also install via SFTP, since some hosts block
  the app store.
- App store review: a hardcoded CORS origin may draw scrutiny.
- Version maintenance: Nextcloud major versions move fast, so ongoing upkeep is a real cost.
  Test against each supported major version.
- openDAW side: a new transport that speaks the app API.
- Quotas, backup, export, GDPR: per-student quota, and all data stays on the school's server.

Effort (for someone fluent in Nextcloud app development):

- MVP (CORS, provisioning, per-student projects, shared deduped assets, teacher distribute, basic
  notifications, minimal UI): about 4 to 8 weeks server side, plus 1 to 2 weeks openDAW side.
- Hardened and store-published (chunked uploads, GC, polished UI, multi-version testing): add several
  more weeks, then ongoing maintenance.

The largest risks are the openDAW-side transport rework and long-term version churn, not any missing
Nextcloud capability.

## Hiring

Where to find a Nextcloud app developer:

- Nextcloud GmbH directly: they do paid custom development and consulting for customers. Contact via
  nextcloud.com (sales or partners). Most reliable for a real deliverable.
- Authors of similar apps on the App Store or GitHub: find education or groupfolders-style apps and
  reach out to active maintainers. They already know the framework.
- Nextcloud community: the forum (help.nextcloud.com, Development category) and the community chat
  have developers open to contract work.
- Freelance platforms: Malt (EU), Upwork, or Toptal, filtered for PHP plus Nextcloud and Vue
  experience.

Suggested start: get a quote from Nextcloud GmbH, and in parallel ping a maintainer of an existing
classroom or groupfolders app.

## Sources

- [CORSMiddleware](https://docs.nextcloud.com/server/13/developer_manual/api/OC/AppFramework/Middleware/Security/CORSMiddleware.html)
- [REST APIs (developer manual)](https://docs.nextcloud.com/server/stable/developer_manual/digging_deeper/rest_apis.html)
- [IUserManager](https://docs.nextcloud.com/server/13/developer_manual/api/OCP/IUserManager.html)
- [IGroupManager](https://docs.nextcloud.com/server/13/developer_manual/api/OCP/IGroupManager.html)
- [Notifications (developer manual)](https://docs.nextcloud.com/server/stable/developer_manual/exapp_development/tech_details/api/notifications.html)
