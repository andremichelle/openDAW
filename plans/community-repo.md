# Community Repo

A public GitHub repo that holds every shareable example: project templates, presets, scripts and WebCLAP plugins.
Anyone can open a PR. After a merge the content is live in the Studio, with no Studio release.

Samples, soundfonts and ranking are out of scope for the first iteration (see Later).

Update 2026-10-22: templates and presets are dropped for now. The repo holds scripts and WebCLAPs only.
Phases 1 to 3 are live, `assets.opendaw.studio/community/{scripts,wclaps}/index.json`. Phase 4 below replaces
the old phases 4 and 5.

## Decision: deploy generated indices, never read the repo at runtime

The Studio could read the repo directly. One Git Trees API call (`/git/trees/main?recursive=1`) lists every file.
That breaks down fast:

1. The unauthenticated GitHub API allows 60 requests per hour per IP. A classroom behind one NAT uses that up in minutes.
2. A tree lists paths only. Names, durations, bpm and devices would need one fetch per file before a browser can render.
3. GitHub rejects files over 100 MB and warns at 50 MB. LFS has a monthly bandwidth quota, which a popular soundfont uses up.
4. raw.githubusercontent.com caches for about 5 minutes and is not meant as an asset CDN.

So a GitHub Action runs on every merge to `main`. It validates everything, computes the metadata and writes one
`index.json` per group. It then uploads indices and payloads to `assets.opendaw.studio/community/...`. The Studio
already reads the same kind of index (`SampleIndex`, `SoundfontIndex`, `OpenPresetAPI.list`), so the client work
is small.

## Repo layout

```
templates/<slug>/meta.json + project.odb + cover.png?
presets/<slug>/meta.json + preset.odp
scripts/<target>/<slug>/meta.json + script.(ts|js)     target = project | werkstatt | apparat | spielwerk
wclaps/<slug>/meta.json + source/ (built by the CI, no binaries in git)
LICENSE, CONTRIBUTING.md, schemas/*.json
.github/workflows/validate.yml, deploy.yml
tools/ (validator + index builder, node + @opendaw SDK packages)
```

`<slug>` is the item's folder name: a short, readable, URL-safe id made of lowercase letters, digits and hyphens,
for example `acid-bassline` or `tape-delay`. It is unique within its group and never changes after the merge,
because the GitHub link uses it and the CI derives the item's UUID from group + slug, so an updated item keeps
its UUID. The display name lives in `meta.json`, so it can be
renamed freely.

Each item is a folder. `meta.json` holds what a human writes: name, description, author, tags, license. The CI
computes everything a machine can measure (uuid, device keys, used assets, size).
Nobody types a UUID by hand.

## Validation on every PR (`validate.yml`)

Runs on `pull_request` (opened, synchronize, reopened), so every new commit pushed to any PR is checked again. It
is a required status check, so a failing PR cannot be merged. "Require branches to be up to date" makes sure the
check ran against the current `main`. The deploy runs the full validation once more as a final check and aborts
without uploading anything when it fails (a cloud sample could have been removed since the PR was checked).

1. Every `meta.json` passes its schema. Folder names are unique slugs.
2. Size limits per group (see Repo size). Every item is CC0. WebCLAP source may use any OSI license, its sounds CC0.
3. Payloads decode: `.odp` and `.odb` load into a BoxGraph through the published SDK packages.
4. Asset references in presets and templates: the CI collects every `AudioFileBox` and `SoundfontFileBox` UUID in
   the file and requires that each one exists in the cloud, `assets.opendaw.studio/samples/index.json` or
   `assets.opendaw.studio/soundfonts/index.json`. A missing reference fails the check and names the box and UUID.
   The deploy runs the same check again as a guard.
5. WebCLAP: the CI builds the bundle from `source/` with a pinned toolchain image, so the shipped binary always
   matches reviewed code. The built bundle loads in the WCLAP host harness and must pass a short render.
6. Scripts type-check against the published scripting API declarations. Project scripts run once in the headless
   core-wasm harness and must finish without a throw. Device scripts compile in their script bridge.
7. The CI posts a comment listing what the PR adds, with computed metadata, so a reviewer sees what goes live.

Branch protection requires the check plus one maintainer review. Scripts run code in a user's browser, so a human
review stays mandatory. CODEOWNERS can give trusted contributors review rights per folder later.

## Deploy on merge (`deploy.yml`)

1. Build the indices: `templates/index.json`, `presets/index.json` (`PresetMeta[]`), `wclaps/index.json`
   (`WclapIndex`), `scripts/index.json`.
2. Upload changed payloads under content-stable names (uuid), then the indices last, so an index never points at a
   file that is not uploaded yet.
3. Each index carries `version`, `updatedAt` and a `minApi` per item, so an older Studio hides what it cannot load.

## Studio side

1. A `CommunityAPI` next to `OpenPresetAPI` / `OpenWclapAPI`, one cached index per group.
2. Presets and WebCLAPs: the community index appears as one more top folder "Community" in
   the existing browsers, next to the stock content, which stays where it is.
3. Templates: a Community section in the dashboard Templates scope.
4. Scripts: the example dropdown becomes a script browser. It has a search field, filter by target (project,
   Werkstatt, Apparat, Spielwerk) and tags, a description, the author, a code preview and an "Open" action. All
   bundled examples move into the repo, the `*-examples.ts` lists and `StockScripts` go away (the starter script
   used for new projects stays bundled).
5. Every community item links to its folder on GitHub ("improve this example") and the browser has an
   "add your own" link to CONTRIBUTING.md.

## Repo size

GitHub has no hard repo cap, but recommends staying under 1 GB and strongly under 5 GB. Single files over
100 MB are refused, 50 MB warns, one push is at most 2 GB. Git keeps every deleted or replaced file in history,
so the repo only grows. Without samples and soundfonts the content is small. CONTRIBUTING.md documents the
GitHub file limits and the validator enforces them.

## Later

1. Samples and soundfonts as their own groups, then check 4 also accepts references into the repo.
   Needs per-file limits and a plan for large payloads (maintainer uploads with only `meta.json` + hash in git).
2. Ranking: one GitHub Discussion per item, 👍 reactions as votes, a scheduled Action writes `votes` into the
   indices, the Studio sorts by them.

## Phases

1. Repo skeleton, schemas, CONTRIBUTING.md, license policy.
2. Validator in `tools/`: schemas, decode checks, asset reference check, script type check. Tests with fixture PRs.
3. Index builder + deploy workflow to `assets.opendaw.studio/community` (DEV path first).
4. Studio `CommunityAPI` + "Community" folder for presets and WebCLAPs.
5. Script browser replacing the dropdowns. Templates section.
6. Move all bundled script examples into the repo as the first content.
7. WebCLAP source builds in CI.

## Phase 4: community scripts in the Studio

What it does for the user:

1. Every script editor (code editor, Werkstatt, Apparat, Spielwerk) gets a script browser instead of the
   Examples dropdown. Search, tags, description, author, a code preview, "Open", and a link to the item on GitHub.
   Each editor lists only the scripts of its own target.
2. "Open from link": paste a GitHub link to a script (main, a branch, a fork or a pull request) and the Studio
   loads it into the editor without saving. A reviewer tries a pull request before the merge, nothing is uploaded.
3. A project script that starts with imports loses everything before its first comment, the same rule as the
   deploy, whether it is opened, loaded from a link or pasted.
4. The bundled examples and the stock project scripts go away, Starter stays. Copies already in a user's script
   list stay where they are.

Checkpoints, each one looked at in the browser before the next:

1. Data layer: `CommunityAPI` (index fetch, cache, `minApi` filter, script download), link resolver for
   github.com blob, tree and pull URLs plus raw.githubusercontent.com, preamble stripping in one place. Tests.
2. The script browser dialog.
3. Wiring into the four editors, removal of the bundled lists, preamble stripping on paste.

## Repo

`andremichelle/opendaw-commons`, public, owned by André.
