# openDAW Device Design

Rules for laying out device editors, collected while the Chord Keys and Sampler previews (`/testing`) went from a
first draft to a design ready for production. Every rule below came from a concrete correction. To be continued.

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

## 8. Width

1. Make a device as narrow as possible, the device panel scrolls sideways and every pixel counts.
2. Parameter sets of the same shape share one group with tabs in its header. The Sampler has one Envelope group
   (Amp Envelope, Mod Envelope) and one LFO group (LFO 1, LFO 2) instead of four groups.
3. A device with a large editor window shows no miniature of that window in the panel. The Sampler panel has no
   preview of the zone ranges, the space goes to parameters.
4. The large window shows every parameter the panel has, with the same state. Nobody should have to go back to the
   panel while the window is open.
5. A preset selector does not belong in the device body. The window shows the preset name as plain text at the top
   left.

## 9. Groups

1. Group headers follow `ControlGroup` (Dattorro Reverb): 9px text in the group colour over a 1px line, with a faint
   gradient below that ends after 7px. No filled header bands, they are heavy on the eyes.
2. All groups of a device use the same header and the same 6px gap. A gap that exists between some groups and not
   between others reads as an error.
3. Group colours follow the rising hue in reading order (orange, yellow, green, blue, purple, cream last).
   Neighbours never share a colour, and colours that are close in hue (yellow and cream) are never neighbours.
4. Do not use red for a group, it is far heavier than the other colours.
5. Tabs are plain text in the header line. The active tab has the group colour, inactive tabs are gray at half
   strength.
6. Every group fills its rows. When a group would end with an empty cell, rearrange the groups or find the parameter
   that belongs there.
7. Group columns start at the same x in every row of groups.

## 10. Lists

1. A scrolling list fades out at its top and bottom edge, it never cuts rows hard. A list whose rows start
   right at its edge fades only where rows lie beyond that edge, so the rows in view stay fully visible.
2. List heads use the group header style.
3. A list of controls next to groups uses the same top offset and the same row pitch (18px rows, 4px gap), so its
   rows line up with the rows of the groups.
4. Free combinations are a list of rows the user adds (the Sampler modulation: source, target, amount), not a fixed
   grid of every combination.
5. Hovering a row that refers to other controls lights them up. A modulation row highlights the tab of its source
   and the name of its target.

## 11. Pointer and selection

1. Go very easy on custom cursors. Values, toggles, list rows, keyboards and canvases keep the default cursor. A
   resize cursor at a draggable edge is fine.
2. Buttons that trigger an action are plain text in a dim gray, without a frame.
3. Selection follows the common pattern: a click selects one item, a click on empty space deselects all, shift, cmd
   or ctrl click toggles an item, dragging on empty space draws a selection rectangle that replaces the selection
   (with a modifier it adds), and a click on one of several selected items collapses the selection to it.
4. An editor for many items offers tools that act on the whole selection, and value changes apply to every selected
   item.
5. With nothing selected the value fields stay in place and show a dash.
6. Every value that can be dragged can also be typed after a double-click, in the unit it shows.
7. Dragging moves a value in steps that fit its range. A pitch amount moves by cents, not by half semitones.
8. The button that opens a device's window sits in the device header, in green, with a pointer cursor.
9. A name the user gave (a group) is renamed by double-click.
10. A value with a few named choices opens a menu. It is not dragged.
11. Where a drop lands decides what it does: on an item it replaces or joins that item, on empty space it creates
    one at that position.
12. When several items share one place in a map, a list beside it shows them one by one. The map selects all of
    them, the list picks one.
13. A field that stands for several selected items with different values is tinted and names the range in its
    tooltip. It still shows one value, so its width does not change.
14. Positions shown in a display (start, end, loop points) are dragged in the display as well as in their fields.
15. Values of items in a list are cells in the row of their item, not controls somewhere else that follow a
    selection. A control block is only for the one thing the whole view is about.
16. A change with several rows selected sets the same value on all of them. It is never relative.
17. Actions go into one menu. A row of buttons costs height and every further action costs width.

## 12. Maps and keyboards

1. A map over the key range has the piano below it over its full width, one column per semitone.
2. The black keys sit on their semitone column. The lines between the white keys sit under the centres of the black
   keys, not at equal sevenths of the octave.
3. Grid lines mark positions inside a display. No line at the edge of a display.
