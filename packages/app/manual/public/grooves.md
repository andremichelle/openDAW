# Grooves

A groove moves notes in time. It can swing offbeats, speed a phrase up, wobble at random or push everything
a little late. Grooves are shared project resources like modulators: one groove can drive the
[Zeitgeist](/manuals/devices/midi/zeitgeist) MIDI effect on several instruments, the pattern of
[Cubed](/manuals/devices/instruments/cubed) and [Surgeon](/manuals/devices/instruments/surgeon), and note and
automation regions and clips at the same time.

---

## 0. Overview

Every project keeps a list of grooves. It always starts with the **Global Shuffle**, the groove a new Zeitgeist
uses. You find the list on the **Modulation** screen (⇧3) in the **Grooves** tab next to the modulators.

A groove is used in three places:

- by a **Zeitgeist** on an instrument, which grooves every note that reaches it
- by **Cubed** and **Surgeon**, which groove the steps of their own patterns
- by a **note or automation region or clip**, which grooves its own notes or curve

Change a groove once and everything that uses it follows.

---

## 1. Types

**Shuffle**

The classic swing. Every second step of the duration grid moves, the downbeats stay where they are.

**Power**

A curve that bends time inside each cell of the duration. Notes speed up or slow down across the cell.

**S-Curve**

Like Power, but the curve eases in and out, so the change is strongest in the middle of the cell.

**Random**

A curve that wanders. **Seed** picks a different pattern, **Roughness** sets how jagged it is and **Steps**
how many points it has per cell.

**Offset**

Moves every note by a fixed number of ticks, up to an eighth note earlier or later (±480 ticks). A dimmed
hint shows what a sixteenth is in ticks.

**Stack**

Chains other grooves. Each member works on the result of the one before it, so the order matters. Drag the
members to reorder them, add new or existing grooves with the **+** button, and double-click a member to
jump to it in the list.

---

## 2. Amount and Duration

Every type but Offset and Stack has an **Amount** and a **Duration**.

**Amount**

Blends the curve. At **50%** time runs straight. Above 50% the curve takes over, reaching it fully at
**100%**. Below 50% the curve turns the other way, reaching its inverse at **0%**.

**Duration**

The length of one cell, the stretch the curve repeats over. It runs from **1/24** to **16 bars** and
includes dotted and triplet lengths like 3/16, 1/12 and 3 bars.

---

## 3. The Grooves List

Each groove has a row with its editor and, on the right, the list of everything that uses it.

- **Double-click** the name to rename it
- the **menu** offers **Duplicate** and **Delete**
- the **+** in the header creates a new groove of any type
- click an instrument in the **Used by** list to open it, the bin icon removes the groove from that user

Deleting a groove that is in use asks what its users should do: **Remove from targets** leaves them without a
groove, **Use Global Shuffle** moves a Zeitgeist onto the Global Shuffle. Cubed, Surgeon, regions and clips always lose their
groove.

The Global Shuffle is never deleted, but you can change its type. Its amount is also shown next to the tempo
in the header.

---

## 4. Zeitgeist

The **Groove** menu of a Zeitgeist picks the groove it plays through.

- **Go to** opens the Grooves list and highlights the current groove
- **None** turns it off, notes pass through unchanged
- **New** creates a groove of any type and uses it
- **Make Unique** gives this Zeitgeist its own copy when the groove is shared

A groove used more than once shows **shared ×** and the number of users. The rest of the editor is the same
as in the Grooves list. See [Zeitgeist](/manuals/devices/midi/zeitgeist).

---

## 5. Regions and Clips

Note and automation regions and clips can play through a groove of their own, without a Zeitgeist.

1. **Right-click** a region or clip
2. Open **Groove**
3. Pick a groove, **None**, or **New** to create one

**Go to** at the top of the menu opens the Grooves list at the region's groove. A groove created here opens
the list and is highlighted.

The groove starts where the region's loop starts and runs on across its loop cycles. Clips run it on the
timeline grid they repeat on. A note region moves its notes, an automation region reads its curve through the
groove. Only notes that lie inside the region are played. A note the groove pushes well past the region end
is not played.

Audio regions do not take a groove yet.

---

## 6. Cubed and Surgeon

The **Groove** button next to the dice button of [Cubed](/manuals/devices/instruments/cubed) picks the groove its
pattern plays through, with **Go to**, **None** and **New** like the region menu. A new Cubed plays straight. In a
loop, Cubed plays every pass like a Zeitgeist.

[Surgeon](/manuals/devices/instruments/surgeon) has the same menu on the **Groove** dropdown above its display.
Each of the eight patterns has its own groove, the dropdown sets the one of the selected pattern. A pattern takes
over where the groove of the pattern before puts the bar line, then its own groove moves its steps. In a loop,
Surgeon plays every pass like a Zeitgeist.

---

## 7. Loops

When the transport loops, a Zeitgeist plays every pass as if it started at the loop start. A note the groove
would move across the loop end, or before the loop start, is not played in that pass. A groove whose cells fit
the loop, like a 1 or 2 bar groove in a 4 bar loop, loses no note.

---

## 8. Copy, Paste and Presets

Copies keep their groove. Duplicating, copying and pasting a region, clip, Zeitgeist, Cubed, Surgeon or instrument within a
project points at the same groove. Pasted into another project, the groove comes along and joins that
project's list. The Global Shuffle maps onto the other project's Global Shuffle.

---

## 9. Scripting

Scripts see every groove with its type and parameters:

- `project.groove` is the Global Shuffle
- `project.grooves` lists every groove in order
- `groove` on a Zeitgeist reads its groove, `null` for none
- `groove` on a note or value region and a note or value clip reads and sets its groove, `null` for none
- `groove` on a Cubed reads and sets the groove of its patterns, `null` for none
- `grooveOf(pattern)` and `setGroove(pattern, groove)` on a Surgeon read and set the groove of one pattern
