# Strum Group

## Goal

The notes of a group that start together (a chord) are spread in time like a strummed guitar. Strum is a feature of the existing `NoteEventGroupBox`, next to chance and the Play All / Play One mode, so a chord is one group for everything it does together.

## How a strum plays

1. Only members that start at the same position are strummed together. A group whose members start at different positions strums each start position on its own.
2. The members at one start position are ordered by pitch. Each one is delayed by `rank × amount`, rank 0 plays on time. A strum never moves a note earlier, so nothing slides in front of the region start.
3. `curve` (bipolar) bends the spacing: 0 is even, negative starts tight and opens up, positive the other way (the same curve function as the repeat curve).
4. Length (like FL Studio's Strum tool):
   1. Default: a delayed note keeps its length, its end moves later by its delay. A note never vanishes.
   2. Keep end (switch on the group): a delayed note keeps its end, so the chord releases together. It never gets shorter than 1/128 note (30 pulses), then its end moves later.
5. Direction:
   1. Up: lowest pitch first.
   2. Down: highest pitch first.
   3. Alternate: the strummed chords of the group take turns, up, down, up, ... counted by their start positions in the region content, the first one up. Every pass starts again with up.
   4. Random: the order is a hash of the seed, the group and the pass (`HostRandom`), so it is the same every time the same pass plays.
6. Play One plays a single note, so strum has no effect there.

## Box structure

`NoteEventGroupBox` gains (new keys, defaults keep today's sound):

1. `3 strum`: the spread between two neighbours, 0 = off.
2. `4 strum-direction`: int32, 0 = up, 1 = down, 2 = alternate, 3 = random.
3. `5 strum-curve`: float32, bipolar, 0 = even.
4. `6 strum-keep-end`: boolean, false = keep the length.

## Engine

1. The sequencer computes a member's delay at play time: it finds the members of the same group at the same position in the collection (like the Play One winner, once per group, position and block, reusing one buffer).
2. `process_collection` and `play_grooved` test the delayed start against the block window. The note lookup already reaches back by the longest note duration, it also reaches back by the longest strum delay.
3. Grooved regions delay after the groove warp, so a strum stays the same width at any groove amount.
4. Tests: up, down, alternate and random order, the curve, length kept, end kept with the 1/128 minimum, a strum across a block border, a strum at the region start, Play One unaffected, grooved regions.

## Adapters and UI

1. `NoteEventFeatures`: read and write strum, direction, curve and Keep end on the group of a note.
2. Group tab: the group status, Play All / Play One, strum amount, direction, curve and Keep end. The Random tab keeps the note's own chance and the seed. Grouping stays in the menus and shortcuts.
3. Piano roll: a strummed note shows a thin tick where it really starts.
4. Consolidate Strum (Edit menu and note context menu): moves the notes to their strummed starts and sets the group's strum to 0, one undo step.
5. Scripting: `NoteGroup.strum`, `strumDirection` ("up", "down", "alternate", "random"), `strumCurve`, `strumKeepEnd`.

## Phases

1. Schema, adapters, engine with tests.
2. Group tab and piano roll tick.
3. Consolidate Strum, scripting.

## Open questions

1. Unit of the strum amount: musical (pulses, follows the tempo, for example 1/64 note) or time (milliseconds, a real hand gesture, 0 to 100 ms)?
2. A Group tab next to Random, or the strum controls inside the Random tab?
