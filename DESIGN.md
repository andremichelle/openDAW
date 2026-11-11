# openDAW Device Design

Rules for laying out device editors, collected while the Chord Keys preview (`/testing`) went from a first draft to a
design ready for production. Every rule below came from a concrete correction. To be continued.

## 1. Plan before placing

1. Decide the layout before putting a single control on the surface. Name the main element (a display, a piano, a
   matrix) and size everything else from it.
2. Use a hidden grid of equal-width columns. Wider controls span columns. In Chord Keys: five columns of 64px with a
   4px gap make exactly the 336px width of the piano. Root takes one column, Scale spans two, each toggle takes one.
3. Text never dictates a width. A label that is longer or shorter must not move a column.
4. Equal controls get equal sizes. Two toggles are the same size, two dropdowns in one row are the same height.
5. Align row edges with the main element. The first control starts at the left edge of the piano, the last one ends
   at its right edge.
6. Put the controls in a row on top and the display below when that saves space. A side column of controls next to a
   display wastes width.

## 2. Height budget

1. A device body is 192px tall (`mixins.Control`) with 8px padding at the top and bottom, which leaves 176px of
   content. Plan the rows so they add up to exactly 176px.
2. Give every row a fixed height. Content that appears or changes (a chord name, a highlighted cell) must never make
   the layout move. Verify it by measuring the element rectangles before and after the change.
3. Leave no empty space at the bottom. Distribute spare height as equal gaps around the main element, so it sits
   centred between the rows above and below.

## 3. Controls

1. Take every control from an existing device and keep its look. Device editors use label controls: a 9px name above
   a framed value (Gate, Delay, Scale Matrix).
2. Scale a component as a whole, never by shrinking only its inner text. A `DropDown` gets `font-size: 12px` on its
   button, so its minimum height of 1.5em becomes 18px and its text 9px together.
3. Toggles use the Nano size: an 18px box with a 13px check.
4. Make the whole column of a toggle clickable, its name included, so the hit area is not just the 18px box.
5. Controls that make no sense in the current state are disabled. When Chord Keys follows the project key, Root and
   Scale are disabled and show the followed key.

## 4. Displays

1. Keep canvases at a natural aspect ratio. Piano keys are about 1:4 (16px wide, 64px tall), never stretched.
2. Show fewer octaves rather than squeezing keys. When content can leave the visible range, move the range to the
   content.
3. Use the colours of the studio keyboard (`DevicePiano`): gray white keys, black black keys, the device accent for
   active keys. Dimmed keys have no contrast.
4. A display needs no outline of its own when it sits directly on the device. Round its corners by 2px.

## 5. Labels and text

1. Information labels stay visible. A chord name label shows the last chord dimmed after release and the first chord
   of the key before anything was played, instead of going empty.
2. When asked to number something, add the numbers and keep the content.
3. Repeating cells (the seven chords) are fixed-width capsules with a fully rounded outline. A number sits in its own
   fixed column, the name is centred in the rest. The name is brighter than the number, the number only indexes it.
4. Use compact symbols where a cell is narrow: `+` for augmented, `°` for diminished. Show the full name in a tooltip,
   without repeating what the cell already shows.
5. A device may end with one hint sentence that explains how it works. It stays visible regardless of the help
   preference, uses 9px text and letter-spacing that makes it span the width of the main element exactly.

## 6. Keyboard

1. A device or page that plays notes from computer keys registers them in its own `ShortcutManager` context with the
   highest priority, the way the software keyboard does. Otherwise global shortcuts take the keys (S toggles solo).

## 7. Verification

1. Check the result in the browser before reporting. Measure edges, gaps, heights and text widths with the element
   rectangles, and look at a screenshot critically. A layout that looks wrong at first sight is wrong.
2. Compute contrast from the real colour values, not from a screenshot.
