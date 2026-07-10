# Automation Node Placement Behaviour (#275)

This documents how double-clicking places a value-automation node, so the behaviour is reviewable and can be
opposed. It implements [#275](https://github.com/andremichelle/openDAW/issues/275) (a follow-up to #197).

If any of this feels wrong, please comment on #275 — this doc is the spec we implemented against.

## The rule

1. Double-click on empty space places a new node.
2. The node snaps to the grid, unless snapping is disabled (holding the snap modifier). *(This part is #274.)*
3. When the snapped time already holds a node, **the side of the node your cursor is on decides which value you set**:
   - cursor on the **left** half of the node → you set the **incoming** value (left of the vertical step),
   - cursor on the **right** half → you set the **outgoing** value (right of the vertical step).
4. When a time already holds two nodes (a full step), a third double-click **overwrites** the member on the cursor's
   side, using the same left/right rule.

## Why "incoming" and "outgoing"

Two value events can share one time position, which draws as a vertical step. They are ordered by an index:

- **index 0 = incoming** — the value the curve reaches coming from the **left**.
- **index 1 = outgoing** — the value the curve leaves with, going to the **right**.

So the left member of a step is the incoming (index 0) and the right member is the outgoing (index 1). The cursor's
side simply matches: left → incoming, right → outgoing.

### Illustrations from the issue

A step (two nodes at one time), from the empty example:

![empty example](https://github.com/user-attachments/assets/11ca97cf-dc52-4873-9e20-901f841396ff)

The two placement scenarios — white = cursor on the left (incoming), red = cursor on the right (outgoing):

![white/red scenarios](https://github.com/user-attachments/assets/311fe964-21c0-4141-aa5b-cd8667d0244f)

## Decision table

Given whether an incoming (index 0) and/or outgoing (index 1) event already sits at the target time, and which side
of the node the cursor is on:

| already there            | cursor side | result |
|--------------------------|-------------|--------|
| nothing                  | either      | create a lone node (index 0) |
| incoming only            | right       | add the outgoing (index 1) = your value; the existing stays the incoming |
| incoming only            | left        | your value becomes the incoming (index 0); the existing value moves to the outgoing (index 1) |
| incoming **and** outgoing| left        | overwrite the incoming (index 0) with your value |
| incoming **and** outgoing| right       | overwrite the outgoing (index 1) with your value |

The "add left" case is the notable one: clicking the left of a lone node keeps the node's current value but pushes it
to the **right** of the new step, and your click becomes the **left** value — so the node you already see does not
change value, it just becomes the outgoing side.

## Where it lives

All in the studio app, next to the value editor:

- **Decision (pure):** `ValueEventPlacement.resolve(hasIncoming, hasOutgoing, side)` in
  `packages/app/studio/src/ui/timeline/editors/value/ValueEventPlacement.ts` — dependency-free, so it is unit-tested
  in `ValueEventPlacement.test.ts` (run by `npm run test -w @opendaw/app-studio`).
- **Execution:** `ValueEventEditing.createOrMoveEvent(...)` in the same folder runs the decision against the event
  collection.
- **Cursor side:** computed in the double-click handler in `ValueEditor.tsx` by comparing the raw cursor position to
  the snapped position (`raw < snapped` → left/incoming, else right/outgoing).
