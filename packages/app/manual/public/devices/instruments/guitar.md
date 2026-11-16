# Guitar

A six string guitar that strums the chords of the chord track with a rhythm pattern, or plays the notes you
play on its strings. Every string is a physical model, so no two strokes sound exactly the same.

---

## 0. Overview

_Guitar_ reads left to right: the **fret display** shows the chord shape, the **pattern** decides when and how
the strings are struck, the two columns on the right shape the **strum**, the **neck**, the **pick** and the **strings**.

Example uses:

- Rhythm guitar under a chord progression: write the chords once on the chord track, pick a pattern
- Fingerpicking accompaniment with Travis or arpeggio patterns
- Funk chops, reggae skanks, palm muted rock eighths
- Playing single notes and chords from a keyboard, strummed like a guitarist would

---

## 1. Modes

### Chords

While the transport runs, the pattern strums the chord at the playhead. A string the chord does not use falls
silent when the chord arrives, and stopping the transport silences the strings. Without a chord on the chord track
the guitar stays silent. Notes you play still sound on the strings.

### Keys

The pattern is off. Every note you play lands on a string near the Position, notes played together are
strummed from the low string up with the strum Speed.

---

## 2. Fret Display

Shows the chord name and the shape the guitar plays: a dot per fretted string, a circle for an open string, a
cross for a muted one, and the first fret when the shape sits higher up the neck. Strings light up as they are
struck. Below it are the tuning and the position.

### Custom Shapes

Below the chord name is the chord source. Chord Track strums the chords of the chord track. Shape 1 to 16 strum a
shape of your own instead, the chord track is ignored and no other device hears it. The name turns orange while a
custom shape plays, choosing Chord Track again returns to the chord track.

Click the neck to build a shape: a click on a string sets that fret, a second click on the same fret makes the
string open, a click above the nut switches the string between open and muted. The arrows below the neck, or the
mouse wheel, move the five frets shown up to fret 24. The menu copies the chord track's current voicing into the
shape or clears it. An empty shape strums the chord track.

Automate the chord source on the Guitar's track to play your own progression: Shape 1 for two bars, Shape 2 for
one, back to the chord track after that. Every change takes over at once.

---

## 3. Pattern

### Slots

The Guitar holds 16 patterns. The Slot number picks the one that plays and that the editor shows, a change takes
over at once. Slots never move, so automating the slot always reaches the same pattern. A new Guitar fills the
slots with sixteen built in patterns.

### Patterns

The menu next to the Slot number shows the slot's pattern and holds the built in patterns, grouped by style:
Strumming, Rock, Funk and Soul, Reggae and Ska, Latin, Country, Fingerstyle, Metal, Afro and Caribbean, Ambient and
Cinematic, Modern Pop and Blues. Choosing one, or walking with the arrows next to the menu, loads it into the current
slot. The menu also copies, pastes and clears the slot's pattern. Editing any step turns the slot into Custom, your
edits stay.

### Length

The number of steps, up to 64 on four pages. A pattern as long as a bar or two restarts with every bar of the
signature track.

### Shift

The arrows next to the strokes move all steps one to the left or right.

### Strokes

Pick a stroke in the palette, then click steps to paint it. Clicking a step that already has the stroke clears
it.

- **Down**: strums the step's strings from the low E up
- **Up**: strums them from the high e down, a little softer
- **Palm mute**: a short, muted down strum
- **Chuck**: a percussive hit with the strings muted
- **Bass**: plucks the lowest string of the chord
- **Alternate bass**: plucks the second lowest string
- **Pick**: plucks the step's strings together, a single string shows its number
- **Stop**: silences the ringing strings
- **Rest**: plays nothing, the strings keep ringing

### Lanes

Below the strokes, one lane at a time:

- **Velocity**: how hard the step is played
- **Strings**: which strings a strum crosses or a pick plucks, the top row is the high e
- **Speed**: how fast this stroke crosses the strings, the middle plays at the strum Speed

---

## 4. Strum

### Speed

How long a strum takes to cross the strings. Its variation changes the timing of every stroke slightly.

### Velocity

The overall loudness of the pattern. Its variation changes the loudness of every pluck slightly.

### Groove

The groove the pattern plays through, chosen from the grooves of the project or made new from the menu. None
plays the steps straight.

### Tilt

Which strings of a strum sound loudest. Turned right the treble strings are louder, turned left the bass strings,
centered every string plays at the same level. Single picked notes and bass notes are not affected.

---

## 5. Play

### Mode

Chords or Keys, see above.

### Rate

Plays the pattern at half, normal or double speed: eighths, sixteenths or thirty-seconds.

---

## 6. Neck

### Position

Where on the neck the chords are played: Open, or a barre shape around the 3rd, 5th, 7th, 9th or 12th fret.
A chord that has no shape there moves to the nearest position that has one.

### Tuning

Standard, Drop D, Open G or DADGAD. The chord shapes follow the tuning.

---

## 7. Pick

### Pick

What plucks the strings:

- **Finger**: the soft, round flesh of a finger
- **Thumb**: wider and softer still, warm and deep
- **Nail**: a fingernail, brighter and more defined
- **Plectrum**: the sharpest attack. Upstrokes sound a little brighter

A pick that hits a ringing string stops it for a moment before it plucks it.

### Spot

Where the pick hits the string, from right at the bridge (thin and bright) towards the middle of the string
(round and soft).

### Pluck

The brightness of the pick. Its variation gives every pick its own color.

---

## 8. String

### Damping

How long the strings ring and how dark they get while they decay. Its variation lets some picks ring a little
longer and brighter. The overtones fade like those of a steel string acoustic, faster on the wound low strings,
and the strings are stiff: their overtones run a little sharp, like real strings. High notes lose their first
ring into the body quickly and then sustain softly. A hard pick starts a little sharp and settles on its pitch.

### Tension

Shortens the ringing strings, up to two octaves higher, while every pick still sounds like the full string.

### Body

The guitar itself: its body and the strings that go with it.

- **Off**: the bare strings
- **Dreadnought**: a big steel string acoustic with a full low end
- **Classical**: nylon strings, warm and round
- **Parlor**: small and focused, less bass, a bright top
- **Jumbo**: the largest body, deep lows
- **Archtop**: a jazz box with flatwound strings and a strong midrange
- **Electric Neck**: a solid body with the pickup at the neck, round and warm, made for an amp simulation
- **Electric Bridge**: the pickup at the bridge, bright and cutting, made for an amp simulation

---

## 9. Out

### Spread

Spreads the strings across the stereo field, from the low E on the left to the high e on the right.

### Volume

The output level.
