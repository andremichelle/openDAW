# Live room: local preview and recording

## Goal

In a live room, the device dialog preview and a recording stay on the own client until they are finished. The audio engine still plays them. Nothing reaches the room before Ok or before the take ends.

## Done on `live-room-stability`

1. The preview runs in a local layer of the box graph. The room never sees a pick.
2. Ok reverts the preview, runs the chosen device again against the current room and publishes it as one edit. The new instrument's note region is created on Ok, not on a pick.
3. When a peer's change breaks the preview, the dialog closes with an info message.
4. Two audio units may share an index for a while. Ok resolves it for the preview, and the timeline shows both rows.
5. `unstageBox` checks pointers before it removes a box, so a failed delete or undo leaves the graph and the engine in step.
6. Recording is local until the take ends. The recording user's name turns red with a record icon.

## Later

1. Do not reconcile everything on every received batch. Today each remote batch runs the conflict check (`project.invalid()`, a scan of every track) and, on a failure, `deterministicReconcile` over every box. Both should look only at the boxes the batch touched and what points at them.
2. Two peers placing a region at the same spot leave overlapping regions. This already happens on `main`. The fuzz excludes its `region` action by default until this is solved.
3. With 4 peers, fuzz seed 1274963 (`FUZZ_SEEDS=162 FUZZ_EXCLUDE=region`) diverges: an instrument unit without its capture sits in the graph untouched, and a later batch attaches it, so `AudioUnitBoxAdapter` panics and the batch is rejected even after reconcile ("Could not remove"). The rank repair hid it by chance.
4. `conflict` is passed to `YSync.joinRoom` but dropped by `YSync.populateRoom`, so the client that opened the room never checks it.
