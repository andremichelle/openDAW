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
7. Staging a uuid that is already staged no longer cuts the edges of the staged box (undo of a delete after a peer brought the box back).
8. Two regions on one spot: the participant whose concurrent change has the higher client id takes it back, a new region leaves, a moved one returns, with a toast. Only the tracks a received batch touched are checked. The room no longer runs `project.invalid()` on every batch.
9. A batch that deletes an instrument's capture but not the instrument goes through reconcile, which removes the instrument.

## Later

1. `deterministicReconcile` still scans every box when a batch fails validation. It should look only at the boxes the batch touched and what points at them.
2. Taking back a region only reverts that region. A change that touched several regions (a move that clipped a neighbour, an undo that restored one) should be taken back as a whole, otherwise the rest of it stays, and after an undo it can overlap again with nobody resolving it.
