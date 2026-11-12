# Fine adjustment for arrangement fades

Hold Shift while dragging a fade length or curve handle to use one fifth of normal pointer movement. Shift can be pressed or released during the drag without moving the handle on its own. Fine mode snaps within two percentage points of 25%, 50%, and 75%. The square edits fade length as a share of the clip; the round handle edits curve shape (50% is linear). A tooltip beside the pointer shows the current value and closes on release or Escape.

Shift now slows the square handle instead of switching it to curve editing. The dedicated curve handle still edits the curve. Its center-axis behavior from #547 is unchanged.

## AI-assisted work

Built on the merged #547. Used one relative motion tracker for both handles and kept the existing edit transactions. Added project-graph tests for Shift transitions, detents, Undo and cancel. Chrome with a generated WAV confirmed a 25% length snap, a 75% curve snap, tooltip position and dismissal, and Escape restoring the curve.
