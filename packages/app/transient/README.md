# @opendaw/transient — Transient Lab

A local test app for **inspecting, auditioning and hand-correcting** transient detection, so we can
iterate the Rust detector (`crates/stretch`) toward "at least as good as Ableton".

It runs the `stretch-wasm` `analyze()` export over each sample and draws:

- **cyan** — our detected markers; line weight + opacity + top wedge encode `strength` (0…1)
- **orange** — an optional comparison set loaded from a `.transients.json` (**Load comparison…**), for
  eyeballing the OLD detector's markers against the current live detection on the same waveform

## Run

```sh
# 1. build the wasm detector (writes public/stretch_wasm.wasm)
npm run wasm -w @opendaw/transient
# 2. start the dev server (https://localhost:8082)
npm run dev -w @opendaw/transient
```

Test audio is served from `public/samples` → repo-root `test-files/samples` (symlink).

## Controls

| action | effect |
|---|---|
| click | play the slice `[marker → next marker]` under the cursor |
| drag a marker | move it (marks the set as edited) |
| double-click | add a marker |
| right-click | delete the nearest marker |
| wheel | zoom at cursor · shift+wheel = pan |
| ←/→ | nudge selected marker by 1 sample (shift = 16) |
| space | replay last slice |
| Export JSON | download corrected markers `{sample, seconds, strength}` |

## The loop

Audition each slice — does it include the full attack and stop before the next transient? Fix by ear
with drag/add/delete, **Export JSON**, then import the labels into the judge:

```sh
cargo run -p stretch-lab --release --bin judge -- import <name>.transients.json
```

(run from `crates/stretch-lab`; it is excluded from the workspace). That writes a **trusted**
`fixtures/<id>.onsets.txt` the detector gate scores against. The current `analyze()` is a starting point;
the target is sparse TRUE onsets in volume AND spectrum (Ableton's dense quasi-grid is NOT the goal) —
improving `crates/stretch/src/{onset,analyzer}.rs` and rebuilding the wasm is the iteration. See
`plans/enhance-stretcher.md`.
