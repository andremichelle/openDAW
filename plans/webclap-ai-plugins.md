# Make your own WebCLAP with AI

Status 2026-11-23: implemented, uncommitted (open-webclap main + this repository's manual), not deployed.

## Result

1. Skill `open-webclap/skill/opendaw-webclap/`: SKILL.md, references/kit.md, kit (`opendaw_kit.h` C++ kit, `opendaw-kit.js` page kit), templates audio-effect / instrument / midi-effect, scripts setup, new, build, check, preview, share. `skill/assemble.mjs` adds `opendaw_page.h`, `panel.js/css` and two docs at publish time.
2. Site: `/preview` page (local build, reload on rebuild with settings and input kept), `/.well-known/agent-skills/` served from the build (vite plugin `agentSkills`).
3. Toolchain: emsdk 3.1.51 at its release tag (works with macOS' Python 3.9), CLAP headers at the commons commit, `~/.opendaw-webclap`. Local archives are byte identical to the commons check's.
4. check.mjs: ~40 tests per plugin, among them a page change sounding as the host's, the same output at any block size (notes within one frame), silence after reset, damaged state refused, 8 bytes per edit.
5. Verified: `npx skills add` from the built site into a throwaway HOME, a fresh toolchain install from scratch, the three templates through the commons validator, the preview in Chrome (panel and window, drag, rebuild reload, width report), five trial agents (tilt EQ, chorus, bitcrusher, synth, arpeggiator) built from prompts, all pass after one or two rounds. Their feedback is folded into SKILL.md, kit.md and the scripts.
6. Manual: `create-webclap-with-ai.md`, linked from Community WebCLAPs and Connect AI Agent.
7. Open: Windows only through WSL. Publishing needs the open-webclap push (site deploy). The share flow `--yes` was only dry-run tested.

## Goal

A guide in the manual for ANY openDAW user, with or without coding skills, plus a skill that teaches their coding agent (Claude Code, Codex, Cursor and others) the whole job.

1. The user runs ONE line, then just prompts, for example "make a tape saturation with drive, tone and wow"
2. The agent builds the WebCLAP, the user tests it on the open-webclap site (webclap.opendaw.studio)
3. When done, the user imports it into the Studio and uses it
4. Optionally the agent opens a pull request to opendaw-commons for them (needs a GitHub account)

The user never reads code, a terminal message or a build error. The agent handles all of it and talks in plain words.

## What already exists

1. Sharing
   opendaw-commons takes WebCLAPs as source (`wclaps/<slug>/meta.json` + `source/build.sh`), the CI builds with Emscripten 3.1.51 and CLAP 1.2.10, loads the plugin, comments, attaches `wclap-bundles`. Rules in `CONTRIBUTING.md`, schema `schemas/wclap.meta.json`, example `wclaps/simple-sine` (plain C).
2. Manual
   `packages/app/manual/public/community-webclaps.md` (using and sharing), listed in `packages/app/manual/src/Manuals.ts`.
3. Guidelines and kit (open-webclap, MIT)
   `docs/building-for-opendaw.md` (checklist), `docs/device-panel-design.md`, `docs/porting-a-midi-effect.md`, `modules/opendaw-clap/opendaw_page.h`, `modules/opendaw-page/panel.js` + `panel.css`, reference ports WetChorus, Helm, Note Lab, `ports/note-lab/check.mjs`.
4. Preview
   webclap.opendaw.studio runs bundles in openDAW's engine, Import in the header loads any `.wclap.tar.gz`.
5. Studio import
   WebCLAP device, Load Plugin > Import WebCLAP...

Missing: the agent skill, a local toolchain identical to the commons CI, a one click preview of a local build, the manual page.

## 1. The one liner

```
npx skills add https://webclap.opendaw.studio -g
```

Installs the skill `opendaw-webclap` for the user's agents. The skill installs the rest itself on first use, so the user never runs a second command:

1. Emscripten 3.1.51 via emsdk into `~/.opendaw-webclap/emsdk` (no Homebrew, no admin rights)
2. CLAP 1.2.10 headers into `~/.opendaw-webclap/clap`
3. Both pinned to the commons CI versions, so the local build is the build that gets reviewed

Requirements: node (needed for the one liner itself), git, python3 (emsdk needs it). The agent checks them and installs what is missing itself where the system allows it, otherwise it tells the user in one plain sentence what to click (macOS asks once to install the command line tools).

## 2. The skill

Lives in `open-webclap/skill/opendaw-webclap/`, published under `webclap.opendaw.studio/.well-known/agent-skills/`.

1. `SKILL.md`
   The workflow below and the hard rules from the guide: WASI imports only, no threads, no allocation in `process`, parameter events at their sample, one gesture per drag, versioned state, the 176 px device panel in our design.
2. `references/`
   The three open-webclap docs, copied at publish time.
3. `templates/`
   One for each device kind the Studio hosts:
   1. `audio-effect` from WetChorus, reduced to one gain stage plus panel
   2. `instrument` NEW, a small polyphonic synth with one filter and a panel (simple-sine has no page, Helm is too big)
   3. `midi-effect` from Note Lab (CLAP note effect), reduced to a transpose plus panel
   Every template already IS a commons folder: `meta.json`, `source/build.sh` (CI conform), the plugin source, the page, and the kit files (`opendaw_page.h`, `panel.js`, `panel.css`) copied into `source/` because the CI provides only the CLAP headers.
4. `scripts/` (node)
   1. `setup.mjs` installs the toolchain (section 1), idempotent
   2. `build.mjs` runs `source/build.sh` exactly as the CI does (`$CLAP_INCLUDE`, `$OUT`), then packs `<slug>.wclap.tar.gz`
   3. `check.mjs` the guide's checklist as pass or fail where a machine can decide: imports, `clap_entry`/`malloc`/table exports, panel features and width, parameter texts both ways, state versioned and round tripping, bytes per edit, no allocation during render, events at their sample, finite output, CPU per block. The rest is printed as a short manual list.
   4. `preview.mjs` serves the archive locally and opens the site preview (section 3), rebuilds reload it
   5. `share.mjs` checks `meta.json` against the commons schema and the slug rules, then forks and opens the pull request with the GitHub CLI after the user says yes. Needs a GitHub account: the agent installs `gh` if missing and runs `gh auth login`, which opens the browser for the user to sign in. Afterwards it reads the check's comment on the pull request and fixes what it lists.

## 3. Preview on webclap.opendaw.studio (site addition)

`preview.mjs` opens `https://webclap.opendaw.studio/preview?src=http://localhost:<port>/<slug>.wclap.tar.gz`. The new preview page loads the archive like Import does, shows the device panel and the window, input source, keyboard and transport as today, and reloads when the file changes. The local server answers CORS and Chrome's private network preflight (`Access-Control-Allow-Private-Network: true`). Firefox and Safari fall back to Import.

## 4. Workflow the skill prescribes

1. Ask kind (audio effect, instrument, MIDI effect), name, 3 to 8 parameters with units
2. `setup.mjs` once
3. Ask whether to check the toolchain, the user may skip it. The check is just: `emcc --version` reports 3.1.51 and `clap/clap.h` exists in the CLAP folder. Same versions as the commons CI means the same build there
4. Copy the template into `./<slug>/`, fill `meta.json`
5. Write the DSP, then the page
6. `build.mjs` and `check.mjs` until green
7. `preview.mjs`, the user listens and asks for changes, repeat
8. Tell the user how to import it into the Studio
9. On request, `share.mjs`

## 5. Manual

New page `packages/app/manual/public/create-webclap-with-ai.md`, "Create a WebCLAP with AI", listed in `Manuals.ts` next to Community WebCLAPs, linked from `community-webclaps.md` and `connect-ai-agent.md`.

Written for users without coding skills.

1. What you need: a coding agent (links to install one), node, a GitHub account only for sharing. Everything else the agent installs.
2. The one liner
3. A first prompt to copy, and how to ask for changes ("make the knob range wider", "it crackles at high drive")
4. Test it on webclap.opendaw.studio, the agent opens it for you
5. Use it: Import in the Studio
6. Share: "ask your agent to share it", with a link to Community WebCLAPs for what happens after the pull request

## 6. Order of work

1. ~~Toolchain: `setup.mjs` + `build.mjs`, build `simple-sine` and WetChorus locally, byte compare with the commons CI build~~
2. ~~Templates: audio effect and MIDI effect from the ports, the new instrument, each building in the commons CI as a test PR~~
3. ~~`check.mjs`~~
4. ~~Site preview page + `preview.mjs`~~
5. ~~`SKILL.md`, references, `share.mjs`~~
6. ~~Test with a fresh agent: five prompts (tilt EQ, chorus, bitcrusher, polysynth, arpeggiating MIDI effect), each must pass the checks, preview, import and the commons check~~
7. Publish the skill on webclap.opendaw.studio (the one liner tested against a local build of the site, goes live with the open-webclap push)
8. ~~Manual page~~

## 7. Risks

1. emsdk on Windows and on machines without python3
   Fallback: `@yowasp/clang` (clang + lld as Wasm on npm, no python) if it produces CI identical modules, to test in step 1.
2. Generated code that hangs or is very slow
   Caught locally by `check.mjs`, in the commons CI and by the human review before merge.
3. Agents drifting from the guidelines
   The templates carry the panel, hover, gestures and state, the agent only changes DSP, parameters and drawing.
4. Review load in commons
   Many AI made PRs. The check comment must be clear enough that most fixes happen before a maintainer looks.
