# Sample disposal: free PCM on AudioFileBox delete + live heap stats

## Symptom

Scrubbing a Sync Log backward never reclaims sample memory. Once the 808 set loads, the engine's
linear memory stays high through the whole rewind.

## Verified root cause (measured, not theorized)

A throwaway harness drove the real `engine.wasm` through `test.odsl`, replicating the worklet's load
handshake with real allocations (256 KiB per sample), logging `heap_used` and the `AudioFileBox`
count per transaction:

```
INIT          files=0  heap_used=1,115,696
fwd step 32   +16 AudioFileBox  files=16  heap_used=5,366,558   (~4 MiB of PCM allocated)
END           files=16 heap_used=5,389,162
bwd 33->32    inverse of +16    files=0   heap_used=5,337,008   (only ~52 KiB returned)
REWOUND       files=0  heap_used=5,314,704                      (~4.2 MiB still resident)
```

So the 16 `AudioFileBox`es are created at step 32 (the 808 set, NOT the Init project) and ARE deleted
from the box graph on rewind (`files` 16 -> 0). The engine reclaims their box structures (~52 KiB) but
NOT the 4 MiB of sample PCM.

The reason is a dropped field. The engine's apply path decodes a delete WITHOUT the box name
(`crates/boxgraph/src/updates.rs:164`):

```rust
"delete" => Update::Delete {uuid: read_uuid(reader)?, name: String::new(), settings: Vec::new()},
```

The sample-free observer matches on that name (`crates/engine/src/lib.rs:953`):

```rust
Update::Delete {uuid, name, ..} if name == "AudioFileBox" => { SAMPLES.get().free(*uuid); }
```

`name` is always empty, so the guard never matches and `free()` is NEVER called. The forward `New`
branch DOES read the name (`updates.rs:150`), which is why `request` + allocate work but free does not.
This affects every lifecycle delete observer, but `AudioFileBox` is currently the only one.

The wire is not at fault and must not change: the delete `UpdateTask` is `{type:"delete", uuid}` by
WASM CONTRACT (`packages/lib/box/src/sync.ts:10`), shared with the real studio. The name is simply not
on the wire. But the engine still HAS the box when it decodes the transaction (it is removed later,
inside `BoxGraph::transaction`), so the engine can resolve the name from its own graph.

## Why no reference-counting / no TS divergence

The existing model (free on `AudioFileBox` delete) already mirrors TS exactly: `EngineProcessor.ts`
325-332 calls `sampleManager.remove(uuid)` on `DeleteUpdate`. TS does NOT free on zero pointer-hub
references (it only gates playback on `pointerHub.nonEmpty()` and keeps the loader). In this project the
808 unload DELETES the boxes when nothing references them, so box-delete IS the "no references" moment.
The fix is to make the existing delete path fire, not to add a pointer-hub refcount. (An earlier draft
of this plan proposed exactly that divergence; it was wrong, based on an unverified Init-project theory.)

## Fix

### 1. Resolve the delete name in the engine apply path (`crates/engine/src/lib.rs`, `apply_updates`)

Decode into a `mut` list and, before `transaction` (which removes the boxes), fill each delete's name
from the still-present graph:

```rust
let mut updates = decode_forward(&mut reader).map_err(|_| ())?;
for update in &mut updates {
    if let Update::Delete {uuid, name, ..} = update {
        if name.is_empty() {
            if let Some(found) = self.graph.find_box(uuid) {
                *name = found.name.clone();
            }
        }
    }
}
self.graph.transaction(&updates, &self.registry).map_err(|_| ())?;
```

`GraphBox.name` is public and `find_box` returns it; the box is guaranteed present pre-`transaction`.
No wire change, no contract change, no `SampleResource` change (`free` already drops the storage Vec,
and `request` re-queues a fresh handle if the same uuid returns on a forward scrub).

### 2. Emit heap stats off-render so the drop is visible (`engine-processor.ts`)

Heap stats currently emit only inside `process()` (~1 Hz, render only), so a suspended scrub never
updates the panel. Emit one `#heap.heap({heapUsed, heapClaimed, memoryTotal})` at the end of
`#applyUpdates`, after `apply_updates` + `#drainSampleRequests`, so the existing Heap-used readout
updates per transaction and visibly drops on the backward step that deletes the boxes. No new UI.

## Verification

1. Promote the throwaway harness to a real test (`packages/app/wasm/test/sample-disposal.test.ts`):
   drive the real `engine.wasm` forward through step 32 with the handshake allocating real PCM, assert
   `heap_used` rises by ~16x the per-sample size; rewind past step 32, assert `heap_used` returns to
   ~the pre-step-32 baseline. This currently FAILS (proving the bug) and PASSES after fix 1.
2. Manual: open the Sync Log page, scrub across step 32, watch Heap used rise on the way in and fall on
   the way out (relies on fix 2 to refresh the readout while suspended).

## Requirement: no retained sample data anywhere

An unreferenced sample must be removed from EVERY layer, not just the engine heap. Do NOT cache decoded
audio on the main thread to make a re-reference cheap: that keeps an unused sample resident, which is the
opposite of the goal. Re-fetch + re-decode on a forward re-scrub is the correct cost of having truly
released the sample (the scrub page is a test harness, not a scenario to optimise for). The host already
deletes its decoded copy right after writing (`engine-host.tsx` `held.delete`); the audit confirms no
other layer retains it.

## Retention audit (whole wasm app)

Every place that can hold sample PCM:

- Engine heap (`SampleResource`): freed on `AudioFileBox` delete (the fix above). OK.
- Host `held` map (`engine-host.tsx`): set on `decode`, deleted on `write` (`held.delete`). Transient,
  per-boot, owned by the boot closure. OK.
- `loadSample` (`sample-fetch.ts`): fetches + decodes fresh on every call, no module-level cache. OK.
- `SampleLoader` (`sample-loader.ts`): an RPC interface, holds no data; contract says "release the held
  copy" after write. OK.
- No module-level `Map`/`Cache`/`AudioData` state anywhere in `src/`. The wasm app does NOT use the
  studio `SampleManager`/loader caches; it has its own minimal loader. OK.

Conclusion: nothing retains an unused sample. The only resident copy is the engine heap, now released.

## Follow-up found by the audit: delete-during-load race (correctness, not retention)

If an `AudioFileBox` is deleted while its load is in flight (e.g. scrub forward past step 32 then
immediately back), the engine has already freed the slot, so `sample_allocate(handle)` returns 0
(`sample.rs` missing-slot path). The worklet passes that 0 to `loader.write(uuid, 0)`, which writes
PLANAR frames to wasm offset 0 — corrupting low memory — and `held` is released, while `sample_set_ready`
on the gone slot is a silent no-op. Not a leak, but a bad write.

Fix (separate change): guard the host `write` on a null pointer — `if (pointer === 0) {held.delete(key);
return}` — so the held copy is still released but no frames are written into a freed slot. Confirm the
engine returns 0 (not a stale pointer) for every not-`Allocated` slot.

## Out of scope

- Soundfont sample boxes (same delete-name fix benefits any future lifecycle observer for free).
