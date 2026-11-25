# Note Editor

Double-click a note region to open it in the note editor. The panel left of the piano roll shows the selected notes
in four tabs: **Basic**, **Random**, **Scale** and **Split**. With several notes selected, a value they do not share
shows a dash, and a new value goes to all of them.

---

## 1. Basic

Position, duration, pitch, velocity and fine tune (cents) of the selected notes.

---

## 2. Random

**Chance** is the probability that a note plays, from 1 to 100 percent.

The decision is fixed, not rolled anew on every playback. It follows from the project **seed**, the note and its
position, so the same project always plays the same notes, also after a reload, in an export and on another
computer. A note in a looping region decides once per loop pass, so the passes can differ. Change the seed (0 to
999999) to hear another variation of the whole project.

The line above the chance shows the group status of the selection.

---

## 3. Chance Groups

A group decides its chance together, which keeps a chord whole. Select the notes, then right-click one of them and
open **Chance Group**, or use the **Edit** menu of the editor.

1. **Group (Play All)** (Cmd+G): all notes of the group play, or none of them
2. **Group (Play One)**: one note of the group plays, picked anew for every pass, the others stay silent
3. **Ungroup** (Cmd+Shift+G): dissolves the groups of the selected notes
4. **Leave Group**: takes the selected notes out of their group

Cmd+G uses the mode you picked last. A group has one chance, the chance of its earliest note. Grouped notes lose their
own chance, and a note leaving its group plays at 100 percent again. Selecting notes of one group and choosing the
other mode switches the group to it.

A grouped note shows a small triangle in its corner. Hovering a note outlines all notes of its group. The chance lane
below the piano roll shows one marker per group: a diamond for Play All, a triangle for Play One.

Copies of a grouped chord form a new group of their own.

---

## 4. Scale

The root key and the scale highlighted in the piano roll. The list button offers the stock scales, **No Scale** and
**From Selection** (the keys of the selected notes). The magnet makes the highlight follow the key at the play position,
see [Key & Chords](/manuals/key-and-chords).

---

## 5. Split

Splits a note into repeated parts.

1. **Count**: the number of parts, 1 plays the note once
2. **Curve**: bends the spacing of the parts, 0 is even
3. **Length**: how long each part sounds, as a share of its slot, 100 percent leaves no gap
4. **Velocity Fade**: a negative value fades the parts out, a positive value fades them in

The piano roll draws the parts with their length and fade. **Consolidate** in the note menu turns the parts into
separate notes. They stay in the chance group of the original note.

Every change is one undo step.
