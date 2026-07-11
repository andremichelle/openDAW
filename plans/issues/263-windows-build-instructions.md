# Provide Windows Building Instructions (#263)

**Doability:** ⭐⭐⭐⭐⭐ (5/5) — documentation-only, the blocking points are already identified.
**Type:** documentation
**Scope:** small

## What is asked
The current build instructions are Linux/bash-centric and don't run on plain Windows even with Git installed. Since most users are on Windows, the README needs Windows-specific setup/build instructions.

## Current behaviour / relevant code
Root `README.md:168-206` ("Prepare, Clone, Installation, and Run") lists prerequisites (Git, mkcert, Node.js >=23, Sass, TypeScript, OpenSSL) and steps:

```
npm run cert    (only for the very first time)
npm run clean
npm install
npm run build
npm run dev:studio | npm run dev:headless
```

The concrete Windows blocker: `package.json` scripts `cert` and `clean` shell out to bash scripts directly —

```
"cert": "bash ./scripts/cert.sh",
"clean": "bash ./scripts/clean.sh"
```

`scripts/cert.sh` (`#!/usr/bin/env bash`) creates a `certs/` dir and runs `mkcert localhost`. `scripts/clean.sh` (`#!/bin/bash`) uses `find ... -prune -exec rm -rf`. Neither runs under `cmd.exe` or plain PowerShell — `bash` is not on PATH unless the user has Git for Windows (which bundles Git Bash / MSYS `bash.exe`), WSL, or Cygwin installed. "Git installed" (as the reporter notes) is not sufficient by itself unless Git Bash specifically is on PATH or invoked directly — the standard Git-for-Windows installer does add `bash.exe` to a location resolvable from Git Bash's own shell, but not necessarily to the system `PATH` that `cmd.exe`/`powershell.exe`/`npm run` (which spawns via `cmd.exe` on Windows) will search, depending on install options chosen.

The rest of the pipeline (`npm install`, `turbo build`, Node/TypeScript/Vite) is already cross-platform — only the two `bash`-wrapped scripts and the general orientation ("which terminal do I even use") are Windows-specific gaps.

## Plan
Add a **Windows** subsection to the README's install section (`README.md`, right after or alongside the existing "Prepare, Clone, Installation, and Run" prose, ~line 168-206), covering:

1. **Recommended terminal: Git Bash.** Since `npm run cert`/`npm run clean` invoke `bash` directly, tell Windows users to run all `npm run ...` commands from **Git Bash** (installed automatically with [Git for Windows](https://gitforwindows.org/)), not from `cmd.exe` or default PowerShell — this alone makes the existing scripts work unmodified, no code changes needed.
2. **mkcert on Windows**: install via `choco install mkcert` or `scoop install mkcert`, then run `mkcert -install` once (Windows-specific: registers the local CA into the Windows cert store, not just NSS) before `npm run cert`.
3. **Node.js >= 23**: same official installer works on Windows, no change — just restate the version requirement.
4. **OpenSSL note**: unlike Linux/macOS, Windows has no OpenSSL preinstalled. Git for Windows bundles a usable `openssl.exe` reachable from Git Bash; call this out explicitly since the current README assumes it's "usually pre-installed" (true only for Linux/macOS).
5. **Alternative path: WSL2.** For users who want a fully Linux-native flow (avoids any bash/PATH ambiguity entirely), document running the whole clone/build inside WSL2 + Ubuntu, at which point every existing instruction in the README applies verbatim. Recommend this as the "if in doubt" path since it sidesteps every cross-platform gotcha in one step.
6. Keep the actual `npm run` command list identical for both platforms once inside Git Bash or WSL2 — no need to fork the command sequence itself, only the terminal/prereq setup differs.

## Risks / open questions
1. Whether to also make `scripts/cert.sh`/`scripts/clean.sh` natively cross-platform (e.g. rewritten as `.mjs` using Node, consistent with the other `scripts/*.mjs` already in the repo — `analyse-samples.mjs`, `convert-samples.mjs`, `fetch-sponsors.mjs`, etc.) is a **code change**, not documentation, and out of scope for this issue as filed (labeled documentation only) — but flag it to the maintainer as the more permanent fix, since it would remove the Git-Bash dependency entirely rather than just documenting around it.
2. mkcert's Windows CA installation step (`mkcert -install`) may prompt a Windows UAC dialog the first time — worth a one-line callout so it doesn't look like a hang.
3. No CI currently builds/tests on Windows (turbo/vitest config not verified here) — this issue only asks for docs, so no CI change is implied, but worth noting as a related gap if Windows support is meant to be more than "one contributor tried it once."
