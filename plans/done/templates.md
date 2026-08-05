# Templates

Personal project templates (issue #168). A template is a saved snapshot of the current project that
the user can re-open later as a fresh, unsaved copy. The flow is:

1. "Save as Template..." in the main menu, asks for a name, writes a template.
2. The Dashboard lists all templates between Projects and Samples, with delete.
3. Opening a template instantiates it with fresh box identities and opens it unsaved, so the first
   Save triggers Save As.

A template is structurally identical to a project (a serialized `BoxGraph` plus `ProjectMeta` plus
optional cover). We exploit this: templates reuse the exact project on-disk format and almost all of
the project storage and sync code, just under a separate folder. The cover is stored and synced like
a project's, it is simply not rendered in the Dashboard template list.

The one place templates differ from a plain project copy: opening a template must regenerate box
UUIDs (see "Open template" below). A project is forked once by Save As, a template is stamped many
times, so each instance needs its own identities.

## Storage decision

Store templates in OPFS in their own versioned folder, mirroring the project layout one-to-one:

```
templates/v1/{uuid}/project.od     // ProjectSkeleton.encode(boxGraph), identical format to projects
templates/v1/{uuid}/meta.json      // ProjectMeta
templates/v1/{uuid}/image.bin      // optional cover
templates/v1/trash.json            // tombstones for deleted templates, for sync
```

The cover is stored, the Dashboard list just renders name plus time (no thumbnail).

Why this and not the alternatives:

- A template is just a project graph. Reusing `ProjectSkeleton`, `ProjectMeta`, and the same three
  file names means `ProjectProfile.#writeFiles`, `Project.loadAnyVersion`, and the whole migration
  path work unchanged. We do not invent a new container format.
- A separate top-level folder (not a subfolder of `projects/v1`) keeps templates out of
  `ProjectStorage.listProjects()` and out of the existing project cloud sync, so the Dashboard
  Projects list and project backup behavior stay exactly as they are.
- Samples and soundfonts are referenced by UUID inside the graph, never embedded. Templates inherit
  the same reference-by-UUID model as projects. On open, `replaceMissingFiles` resolves them, and
  because samples and soundfonts are already synced to the cloud, a template restored on another
  machine resolves its assets the same way a project does. No need to bundle audio into templates.

### Sync (backup) decision

Templates must be included in the Dropbox / Google Drive backup (the `CloudBackup` catalog sync,
Nextcloud is a separate per-project flow and out of scope). The project sync in `CloudBackupProjects`
is a self-contained module (catalog `index.json` plus per-uuid folder, with upload / trash / download
phases). We clone it as `CloudBackupTemplates` pointing at a `templates` remote folder and reading
from `TemplateStorage` instead of `ProjectStorage`.

Remote layout (mirrors the existing `projects/` remote layout):

```
templates/index.json               // catalog: uuid -> {name, modified, created, tags, description}
templates/{uuid}/project.od
templates/{uuid}/meta.json
templates/{uuid}/image.bin         // optional
```

Wire it into `CloudBackup.backupWithHandler`: change `Progress.split(..., 4)` to `5` and add
`await CloudBackupTemplates.start(...)` after the projects step. The lock, retry, and
`StorageUpdated` signal logic all stay as-is and cover templates for free.

## Storage layer (studio-core)

New files next to the project equivalents in `packages/studio/core/src/project/`.

`TemplatePaths.ts` mirrors `ProjectPaths.ts` with `Folder = "templates/v1"` and reuses the same
`project.od` / `meta.json` / `image.bin` file names:

```ts
export namespace TemplatePaths {
    export const Folder = "templates/v1"
    export const ProjectFile = "project.od"
    export const ProjectMetaFile = "meta.json"
    export const ProjectCoverFile = "image.bin"
    export const projectFile = (uuid: UUID.Bytes): string => `${templateFolder(uuid)}/${ProjectFile}`
    export const projectMeta = (uuid: UUID.Bytes): string => `${templateFolder(uuid)}/${ProjectMetaFile}`
    export const projectCover = (uuid: UUID.Bytes): string => `${templateFolder(uuid)}/${ProjectCoverFile}`
    export const templateFolder = (uuid: UUID.Bytes): string => `${Folder}/${UUID.toString(uuid)}`
}
```

`TemplateStorage.ts` mirrors `ProjectStorage.ts`: `listTemplates`, `loadTemplate`, `loadMeta`,
`loadCover`, `deleteTemplate` (writes to `templates/v1/trash.json`), `loadTrashedIds`. It is a copy
of `ProjectStorage` with `ProjectPaths` swapped for `TemplatePaths` and method names retargeted. The
`ListEntry` / `List` shape is identical.

A static writer that takes the current profile and a chosen name and writes a new template under a
fresh uuid. The bytes are stored as-is (no UUID remap, that happens on open), but the chosen name
and fresh dates must be written into the embedded `ProjectMetaBox`, not only into `meta.json`. The
reason is loophole 1 below: on open, the `ProjectProfile` constructor calls `#readMeta()` and the
embedded box wins over any meta we pass in. So we work on a copy and push the values through a
throwaway profile (the constructor first reads the source box, then `updateMetaData` overrides it in
both the box and the meta), then encode that copy:

```ts
export const saveAsTemplate = async (profile: ProjectProfile, name: string): Promise<void> => {
    const uuid = UUID.generate()
    const project = profile.project.copy()
    const meta = ProjectMeta.copy(profile.meta)
    delete meta.radioToken // never carry a publish token into a template
    const template = new ProjectProfile(uuid, project, meta, profile.cover, true)
    template.updateMetaData("name", name)
    template.updateMetaData("created", new Date().toISOString())
    template.updateModifyDate()
    await Workers.Opfs.write(TemplatePaths.projectFile(uuid),
        new Uint8Array(project.toArrayBuffer()))
    await Workers.Opfs.write(TemplatePaths.projectMeta(uuid),
        new TextEncoder().encode(JSON.stringify(template.meta)))
    await profile.cover.match({
        none: () => Promise.resolve(),
        some: cover => Workers.Opfs.write(TemplatePaths.projectCover(uuid), new Uint8Array(cover))
    })
}
```

`TemplateStorage` also needs a `listUsedAssets(type)` cloned from `ProjectStorage.listUsedAssets`
(scanning `TemplatePaths.Folder`) for loophole 2 below.

Export `TemplatePaths`, `TemplateStorage`, and `CloudBackupTemplates` from the studio-core barrel so
the app and cloud modules can import them.

## Save as Template (menu + dialog + service)

### Menu entry

`packages/app/studio/src/service/StudioMenu.ts`, immediately after the "Save As..." item
(line 38-42):

```ts
MenuItem.default({
    label: "Save as Template...",
    selectable: service.hasProfile
}).setTriggerProcedure(() => service.projectProfileService.saveAsTemplate()),
```

No global shortcut needed for a first version.

### Name dialog

The existing `ProjectDialogs.showSaveDialog` returns a full `ProjectMeta`, which is more than we
need. Add a lightweight `ProjectDialogs.showTemplateNameDialog(suggested: string): Promise<string>`
in `packages/app/studio/src/project/ProjectDialogs.tsx` (a single text input prefilled with the
current project name, resolves the typed name, rejects with `Errors.AbortError` on cancel just like
`showSaveDialog`, so the `Promises.tryCatch` in `saveAsTemplate` sees `status === "rejected"`). It
must reject input with no character after trimming (loophole 5). Reuse the same dialog chrome as
`showSaveDialog`.

### Service method

`packages/app/studio/src/service/ProjectProfileService.ts`, new method modeled on `saveAs`:

```ts
async saveAsTemplate(): Promise<void> {
    return this.#profile.ifSome(async profile => {
        const {status, value: name} = await Promises.tryCatch(
            ProjectDialogs.showTemplateNameDialog(profile.meta.name))
        if (status === "rejected") {return}
        await TemplateStorage.saveAsTemplate(profile, name)
        RuntimeSignal.dispatch(ProjectSignals.StorageUpdated)
    })
}
```

Saving a template does not touch the current profile's saved/unsaved state. The user keeps editing
the same project.

## Dashboard: Templates tab

`packages/app/studio/src/ui/dashboard/Resources.tsx`. Insert Templates between Projects (value 0)
and Samples, and renumber:

```tsx
elements={[
    {value: 0, element: (<h3>Projects</h3>)},
    {value: 1, element: (<h3>Templates</h3>)},
    {value: 2, element: (<h3>Samples</h3>)},
    {value: 3, element: (<h3>Soundfonts</h3>)}
]}
```

Switch cases shift accordingly: `case 1` renders the templates browser, Samples becomes `case 2`,
Soundfonts becomes `case 3`.

### TemplateBrowser component

New `packages/app/studio/src/project/TemplateBrowser.tsx`, cloned from `ProjectBrowser.tsx`. The list
is identical to the project list, no differences. The only changes are the data source and what the
row click does:

- Source list from `TemplateStorage.listTemplates()` instead of `ProjectStorage.listProjects()`,
  same sort by `modified` descending.
- Same row layout (name + relative time), same delete icon with the "Delete Template?" confirm
  dialog calling `service.deleteTemplate(uuid)` (see below), same `row.remove()` on success.
- The `select` callback opens the template rather than loading a project (see below). In
  `Resources.tsx` the `case 1` block wires `select` to the open-template flow.

It refreshes on the `ProjectSignals.StorageUpdated` signal the same way `ProjectBrowser` does, so a
freshly saved template appears without a reload.

## Open template (copy with new identities, opens unsaved)

This must not just reuse `Project.copy()`. `Project.copy()` re-encodes and reloads the identical
bytes (`Project.load(env, this.toArrayBuffer())`), so every box keeps its UUID (`ProjectBundle.decode`
is the same, it only guards against re-opening the same project UUID). For a template, which is
stamped into many independent projects, sharing box UUIDs collides in any shared context, live rooms
key the shared graph by box UUID, so two projects from one template would clash.

The fix is to regenerate box UUIDs on open while preserving the asset boxes, and to make it reusable
since "Duplicate Project" and "Save as Copy" would want the exact same thing. So add it as a method on
`Project`, a sibling to `copy()`, that drives the box serialize-plus-remap over the whole graph.

Despite the name, the two functions we use here touch no clipboard. `serializeBoxes` and
`deserializeBoxes` only import `lib-std`, `lib-box`, and `BoxIO`, they are pure: `serializeBoxes`
builds a throwaway `BoxGraph`, copies the boxes in, and returns an `ArrayBuffer`, while
`deserializeBoxes` reads that buffer back into a target graph with remapped UUIDs. The actual
clipboard read/write lives in the handlers under `ui/clipboard/types/` that call them. Because the
name and location are misleading (and to keep `project/` from importing `ui/`), relocate these two
helpers to a neutral top-level core util `packages/studio/core/src/BoxGraphCopy.ts` (alongside
`AudioUtils.ts`), and have `ClipboardUtils` re-export them so the existing copy/paste handlers are
untouched. The new method then imports from that neutral module:

```ts
copyWithNewIdentities(env?: Partial<ProjectEnv>): Project {
    const data = BoxGraphCopy.serializeBoxes(this.boxGraph.boxes())
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    boxGraph.beginTransaction()
    BoxGraphCopy.deserializeBoxes(data, boxGraph, {mapPointer: (_pointer, address) => address})
    boxGraph.endTransaction()
    boxGraph.verifyPointers()
    const skeleton: ProjectSkeleton = {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}
    return Project.fromSkeleton({...this.#env, ...env}, skeleton)
}
```

`fromSkeleton` runs `ProjectValidation.validate` and, with the default `followFirstUser = true`,
follows the first `UserInterfaceBox`, exactly like the normal `load`/`loadAnyVersion` open path. We
keep that default (not the `false` the JSON-import path uses), since a template comes from a saved
project and always has a UI box, and we want the opened instance to behave like a normally opened
project.

What it leans on, all already present: `deserializeBoxes` keeps every `resource === "preserved"` box
(`AudioFileBox`, `SoundfontFileBox`, `NeuralAmpModelBox`, so their shared samples/soundfonts/NAM
resolve through `replaceMissingFiles`) and gives every other box a fresh `UUID.generate()`, rewriting
all pointers through its UUID map. The `mapPointer` fallback is the identity function and is never
actually reached, a whole-graph copy has no external references. Mandatory boxes are located by type,
not by fixed UUID, so regenerating their UUIDs is fine.

There is no separate `instantiateTemplate`. Opening a template is just `loadAnyVersion` followed by
`copyWithNewIdentities`. The remap must run on open, never at save time, saving a remapped graph
would freeze one identity set and every instance would again share UUIDs.

Crucial: migration and validation must run when a template is opened, exactly as for a project. A
template persists across app versions like any project file, so a template saved under an older
format must be migrated up before it is used. The chain guarantees this and must not be shortcut:

- `loadAnyVersion` decodes, then runs `ProjectMigration.migrate(env, skeleton)`, then `fromSkeleton`
  which runs `ProjectValidation.validate`. Migration happens here, on the original template, and the
  migrated graph is validated.
- `copyWithNewIdentities` then runs `verifyPointers()` on the remapped graph and `fromSkeleton`
  again, so validation runs a second time on the post-remap graph plus a pointer-integrity check.

Never decode template bytes straight into a graph (for example via `ProjectSkeleton.decode` or
`Project.load`) on the open path, that would skip `ProjectMigration.migrate` and an older template
would load unmigrated. `loadAnyVersion` is the only sanctioned entry point.

`loadAnyVersion` builds a `Project` we immediately discard (we only harvest its migrated graph). That
is intentional and safe, verified: the `Project` constructor and `follow()` only create subscriptions
internal to that throwaway's own graph, they start no engine and register nothing global, so the
discarded instance is a self-contained island that is garbage collected once dropped. Do not
"optimize" this into reusing the intermediate `Project` directly, it would keep the original
(colliding) box UUIDs.

Service method on `ProjectProfileService`, modeled on `load` but instantiating and leaving the
profile unsaved (the `hasBeenSaved` constructor arg defaults to `false`, matching how `loadFile`
opens an imported `.od` at line 178-179):

```ts
async openTemplate(uuid: UUID.Bytes, meta: ProjectMeta) {
    const {status, value: project, error} = await Promises.tryCatch(
        TemplateStorage.loadTemplate(uuid)
            .then(buffer => Project.loadAnyVersion(this.#env, buffer))
            .then(template => template.copyWithNewIdentities()))
    if (status === "rejected") {
        await RuntimeNotifier.info({headline: "Could not open template", message: String(error)})
        return
    }
    await this.#sampleService.replaceMissingFiles(project.boxGraph, this.#sampleManager)
    await this.#soundfontService.replaceMissingFiles(project.boxGraph, this.#soundfontManager)
    const cover = await TemplateStorage.loadCover(uuid)
    this.#setProfile(UUID.generate(), project, ProjectMeta.copy(meta), cover)
}
```

Because the new profile is created with `hasBeenSaved = false`, `ProjectProfileService.save()`
routes to `saveAs()`, so the first Save prompts for a name and creates a real project. The template
itself is never modified by opening it. The working name is the template name, which `saveAsTemplate`
already baked into the embedded `ProjectMetaBox`, so the constructor's `#readMeta()` reproduces it
(the `meta` argument is only a fallback). That name lives in the in-memory profile until the first
Save writes it to OPFS, the same way an imported `.od` holds its name today.

## Delete template

`StudioService` (`packages/app/studio/src/service/StudioService.ts`) gets a `deleteTemplate(uuid)`
mirroring its existing `deleteProject`, calling `TemplateStorage.deleteTemplate(uuid)` and
dispatching `ProjectSignals.StorageUpdated`. The tombstone in `templates/v1/trash.json` lets the
next cloud backup remove it remotely, exactly like project deletion.

## Cloud sync

New `packages/studio/core/src/cloud/CloudBackupTemplates.ts`, a copy of `CloudBackupProjects.ts`
with:

- `static readonly RemotePath = "templates"`.
- `ProjectStorage` calls swapped for `TemplateStorage` (`listTemplates`, `loadMeta`, `loadTemplate`,
  `loadCover`, `loadTrashedIds`).
- `ProjectPaths` swapped for `TemplatePaths` in the download writes.
- The "Delete Projects?" prompt text changed to templates.

`packages/studio/core/src/cloud/CloudBackup.ts`:

- Import `CloudBackupTemplates`.
- `Progress.split(progress => progressValue.setValue(progress), 4)` becomes `5`, destructure the
  extra `progressTemplates`.
- Add `await CloudBackupTemplates.start(cloudHandler, progressTemplates, log)` after the projects
  step (line 96).

Nextcloud (`NextcloudDialogs`) is a separate per-project upload/browse flow, not part of this
catalog sync. Leave it out of the first version unless we decide templates belong there too.

## File change list

New files:

- `packages/studio/core/src/project/TemplatePaths.ts`
- `packages/studio/core/src/project/TemplateStorage.ts`
- `packages/studio/core/src/cloud/CloudBackupTemplates.ts`
- `packages/app/studio/src/project/TemplateBrowser.tsx`
- `packages/studio/core/src/BoxGraphCopy.ts` (top-level core util, like `AudioUtils.ts`): the two pure
  `serializeBoxes`/`deserializeBoxes` helpers moved here out of `ui/clipboard/ClipboardUtils.ts`.

Edits:

- `packages/studio/core/src/project/index.ts` barrel: add `export * from "./TemplatePaths"` and
  `export * from "./TemplateStorage"`. `CloudBackupTemplates` needs no barrel export (neither does
  `CloudBackupProjects`, it is internal to `CloudBackup`).
- `packages/studio/core/src/ui/clipboard/ClipboardUtils.ts`: re-export the two helpers now in
  `BoxGraphCopy.ts` so the existing copy/paste handlers keep working unchanged. Optional
  `export * from "./BoxGraphCopy"` in `src/index.ts` if other packages need them.
- `packages/studio/core/src/cloud/CloudBackup.ts`: 5-way split, run templates step.
- `packages/studio/core/src/project/Project.ts`: `copyWithNewIdentities()`, sibling to `copy()`,
  drives the box serialize-plus-remap over the whole graph (reusable by a future "Duplicate Project").
- `packages/app/studio/src/service/StudioMenu.ts`: "Save as Template..." menu item.
- `packages/app/studio/src/service/ProjectProfileService.ts`: `saveAsTemplate`, `openTemplate`.
- `packages/app/studio/src/service/StudioService.ts`: `deleteTemplate`.
- `packages/app/studio/src/project/ProjectDialogs.tsx`: `showTemplateNameDialog`.
- `packages/app/studio/src/ui/dashboard/Resources.tsx`: Templates tab + renumbered cases.
- `packages/app/studio/src/ui/browse/SampleSelection.ts` and `SoundfontSelection.ts`: include
  `TemplateStorage.listUsedAssets(...)` in the deletion-safety check (loophole 2).

## Resolved decisions

- Unsaved name is held in the in-memory profile (`ProjectMeta` plus `ProjectMetaBox`). The template
  name is baked into the box at save time, the constructor reproduces it on open, and it is written
  to OPFS only on first Save. No extra storage. See loophole 1.
- Templates are stored, synced, and listed exactly like projects, no differences. A cover is stored
  and synced, and the Dashboard list shows name plus time (the project list does not render the cover
  either).
- Nextcloud is out of scope.
- Opening a template regenerates box UUIDs (preserving asset boxes) via the box serialize-plus-remap
  helpers, so each instance is independent. `Project.copy()` is not enough because it preserves UUIDs.
- Save As name prefill on first save keeps the template name as the default (no "Copy of ..." prefix).
- Opening a template runs migration and validation exactly like opening a project. `loadAnyVersion`
  migrates (and validates) the stored template, then `copyWithNewIdentities` validates and
  pointer-checks the remapped graph. The open path must never bypass `loadAnyVersion`, that would
  skip migration for older templates. Saving a template stores the current, already-migrated live
  project, so no migration is needed at save time.
- The UUID remap is a reusable `Project.copyWithNewIdentities()` method, a sibling to `copy()`, not
  template-specific code. It drives the pure box serialize-plus-remap helpers (relocated out of
  `ClipboardUtils`, which despite its name touches no clipboard) over the whole graph. There is no
  separate `instantiateTemplate`, opening a template is `loadAnyVersion(...).copyWithNewIdentities()`,
  and a future "Duplicate Project" or "Save as Copy" reuses the same method.

## Loopholes and risks

### 1. Write the name the way a project does, into the graph (handled)

A project's name does not live in `meta.json` alone, it lives inside the graph in the
`ProjectMetaBox`, and a `ProjectProfile` reads its name from that box on open. `saveAs` writes the
box and `meta.json` together, so a project stays consistent. The template must do the same. Writing
the chosen name only into `meta.json` would leave the box holding the source project's name, so
opening the template would default to the old name instead of the one the user typed.

**Why it matters: the template name offered as the editable default only sticks if it is stored in
the box like a real project name, otherwise the opened template defaults to the source project's
name.** Fixed by writing the name into the box (on a project copy) in `saveAsTemplate`, exactly as
project save does.

### 2. The asset-in-use check must include templates (handled)

Before deleting a sample or soundfont, `SampleSelection`/`SoundfontSelection` call
`ProjectStorage.listUsedAssets`, which walks every folder under `projects/v1` and collects which
projects reference each asset UUID so it can warn "Used by project(s): ...". Templates live under
`templates/v1`, which that scan never opens, so a sample referenced only by a template counts as used
by nobody: delete the original project, then delete the sample (dialog reports zero usages), and the
template loses that sound with no way to restore it.

**Why it matters: the guard that stops users deleting in-use assets is blind to templates, so one
delete can permanently break every template built on that asset.** Fixed by adding
`TemplateStorage.listUsedAssets` and folding it into both deletion checks.

### 3. `Project.copy()` alone is not enough, so `copyWithNewIdentities` reuses the clipboard remap (low risk, verify once)

`Project.copy()` re-saves and reloads the same bytes, so it keeps every box UUID. That is the
collision risk: two projects stamped from one template would share box UUIDs and clash in a live
room. The new `Project.copyWithNewIdentities()` gives each instance fresh UUIDs while keeping the
asset boxes (so their samples still resolve), by reusing the box serialize-plus-remap that copy/paste
already performs: a new UUID for every box except `resource === "preserved"`, with all pointers
rewritten. Running it over a whole project rather than a pasted selection is the easy case, every
reference is internal so nothing hits the external-pointer fallback. Note those two helpers
(`serializeBoxes`/`deserializeBoxes`) touch no clipboard despite their `ClipboardUtils` name, they are
pure box-to-buffer functions, so this plan relocates them to a neutral box-util module and re-exports
them from `ClipboardUtils` for the existing handlers.

**Why it is only a note, not a redesign: it reuses the same proven serialization as copy/paste, it
has just never been run over an entire graph, so it needs one test (clone a real project, confirm it
passes `verifyPointers` and opens) rather than a new mechanism.**

### 4. A template would inherit the source project's radio publish token (handled)

`ProjectMeta` carries an optional `radioToken`, the credential that authorizes updates to one
published openDAW radio entry, which is why `copyForUpload` already deletes it before sharing.
`ProjectMeta.copy` keeps it, so without intervention every project stamped from the template would
carry the same token.

**Why it matters: several unrelated projects sharing one publish token means saving any one of them
could overwrite another's published radio entry.** Fixed by `delete meta.radioToken` in
`saveAsTemplate`.

### 5. The template name must contain at least one character (handled)

If the name dialog resolves an empty string, `saveAsTemplate` would write a template whose
`meta.name` is blank and the Dashboard row would render with no label.

**Why it matters: a blank-named template is impossible to pick out in the list.** The name dialog
must reject input that has no character after trimming.

