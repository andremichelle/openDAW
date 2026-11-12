# Sampler

A multi-sample instrument. Many samples are mapped across the keyboard by key and velocity, with round robins,
groups and per-voice modulation.

---

## 0. Overview

_Sampler_ plays sample libraries that were recorded note by note and at several dynamics. Each sample sits in a
**sample zone** that says which keys and velocities it answers. A note plays every zone that answers it.

Example uses:

- Pianos, organs and mallets recorded every few semitones at several dynamics
- Drum kits with velocity layers, round robins and a hi-hat that chokes itself
- Sustained instruments with loops
- Release samples that play when a key is let go

The device panel holds the parameters of the voices. **Edit Sample Zones** in the device header opens the window
that maps the samples.

---

## 1. Device panel

### 1.1 Play

- **Voices**: How many voices may sound at once, notes that are ringing out included. When a new one needs room,
  the quietest note that is ringing out falls away with all its layers, and without one the oldest held note.
  Release samples are counted on their own, up to the same number. One voice makes the instrument monophonic.
- **Glide**: The time a note takes to slide from the pitch of the note before.
- **Legato**: With one voice, a note played while another is held carries the sounding sample to the new key
  instead of starting it again.
- **Octave**, **Transp**, **Tune**: Shift the whole instrument by octaves, semitones and cents.

### 1.2 Filter

- **Type**: Off, low-pass with 12 or 24 dB per octave, high-pass with 12 dB per octave.
- **Cutoff** and **Reso**: Corner frequency and resonance.

### 1.3 Mix

- **Volume** and **Pan**: Output level and position.
- **Mono**: Folds the two channels of each voice together. 100% is mono.

### 1.4 Envelope

Two envelopes share one group, switched by the tabs in its header. Both have **Delay**, **Attack**, **Hold**,
**Decay**, **Sustain** and **Release**.

- **Amp Envelope** shapes the level of every voice.
- **Mod Envelope** does nothing on its own. Give it a target in the modulation list.

### 1.5 LFO

Two LFOs share one group, switched by the tabs in its header. Each voice has its own.

- **Shape**: Sine, triangle, saw or square.
- **Rate**: Speed in Hz. With **Sync** on, the rate snaps to a note length of the project tempo.
- **Delay**: The time before the LFO starts after a note begins.
- **Fade**: The time it takes to reach its full depth after the delay.
- **Restart**: On, each note starts the LFO from the beginning. Off, all notes follow one free-running cycle.

### 1.6 Modulation

A list of connections. Each one sends a **Source** to a **Target** by an **Amount**. **Add** creates one, the
icon at the end of a row removes it. Hovering a row lights up what it connects.

Sources:

- **Amp Env**, **Mod Env**: The two envelopes
- **LFO 1**, **LFO 2**
- **Velocity**: How hard the note was played
- **Key**: How far the note is from the middle of the keyboard
- **Random**: A new value for every note

Targets:

- **Pitch**: A full amount reaches 48 semitones
- **Cutoff**, **Reso**
- **Gain**: A source at its top leaves the level alone, below that the level falls. A negative amount turns the
  source around.
- **Pan**
- **Start**: Moves where the sample starts, read once when the note begins
- **Loop**: Moves the loop start, read once when the note begins
- **LFO 1 Rate**, **LFO 2 Rate**: A full amount reaches four octaves
- **Env Depth**: Scales everything the Mod Envelope does

A new Sampler starts with one connection: Velocity to Gain at 100%. Remove it to play every note at full level.

---

## 2. Sample zone window

### 2.1 Adding samples

Samples come from the sample browser, from audio files dropped from the desktop, or from **Add Samples**. Where
you drop them decides what happens:

- **On an empty place of the map**: The sample gets the key under the pointer. Several samples take the keys
  above it, one each. Above or below a zone on that key it takes the velocities that are still free.
- **On a zone of the map**: The sample joins that zone's keys and velocities, as a further layer or round robin.
  A single sample that covers the whole keyboard is the exception: the drop takes the key under the pointer and
  the first sample moves to C1.
- **On the list "Zones on This Range"**: The same, for the zone that is selected.
- **On the waveform**: The selected zone plays the new sample instead. Its start, end and loop go back to the
  whole sample.
- **Anywhere else on the window, on the device panel, or with Add Samples**: A single sample in an empty Sampler
  gets the whole keyboard. Several samples line up from C1, one key each, like a drum kit. A second sample added
  to that single one turns both into a kit: the first moves to C1.

Where a sample gets keys of its own, its file name is read first: a note (`C4`, `c#3`, `Bb2`) becomes the root
key and wins over the place of the drop. A dynamic (`pp` to `fff`, or `v1`, `v2`) becomes a velocity layer and
`rr1`, `rr2` number the round robins, so `Snare v1 rr1` and `Snare v2 rr1` share one key, also when they are
added one after the other. Notes are read in
scientific pitch, where `C4` is the middle C. A sample dropped on a zone or on the list takes that range whatever
its name says. Round robins numbered in the file names take turns at once when their group was empty.

### 2.2 The map

The map shows keys from left to right and velocity from bottom to top, with a piano below it. Every sample zone
is a rectangle.

- **Click** a zone to select it. **Shift**, **Cmd** or **Ctrl** click adds a zone or takes it out again.
- **Click** empty space to deselect.
- **Drag** on empty space to draw a selection rectangle.
- **Drag** a zone to move it. Drag an edge to change its range. All selected zones follow.
- Play the piano to hear the instrument. The zones that answer the key are selected.

Several zones can lie on exactly the same keys and velocities. The map draws them as one rectangle and a click
selects all of them. The list "Zones on This Range" shows them one by one.

Where zones with different ranges, or of different groups, cover the same spot, click the spot again to reach
the next one.

### 2.3 Samples

The **Samples** list has one row per sample with the number of zones that play it. Click a sample to select all
its zones. Zones that were taken off the map show as a dimmed row of their own.

### 2.4 Zones on one range

Right of the waveform, **Zones on This Range** lists the zones that share the keys and velocities of the selected
zone, with their pan and gain.

- **Click** a row to work on that zone alone.
- The menu in its head decides how they play: **Together** (layers, for example a left and a right sample),
  **In Turn** (round robins, one per note in the order of the list) or **Random** (one per note, never the same
  twice in a row). This is a setting of the group, so it holds for every range in it.
- With In Turn, **drag** a row up or down to change the order.
- The **×** takes a zone off the map.
- **Drop** samples on the list to add zones to the range. To give a zone another sample, drop it on the waveform.

### 2.5 Tools

The tools act on the selected zones.

- **Select All**: Every zone of the shown group
- **Map by Name**: Maps the zones from their file names again
- **Spread Keys**: Extends each zone halfway to the neighbouring roots, so no key is left empty
- **Spread Velocity**: Splits the velocity range evenly between the layers on the same keys
- **Crossfade**: Lets neighbours overlap and fade into each other
- **Root to Low**: Sets the root key to the lowest key of the zone
- **Duplicate**: Copies the zones onto the same range
- **Move to Group**
- **Delete**: Takes the zones off the map. Their samples stay in the Samples list, dimmed.
- **Restore**: Puts them back. Click the dimmed sample first.
- **Clean Up** (top right): Removes the zones that were taken off the map, and samples nothing plays any more

### 2.6 Groups

A group collects zones that behave the same way. Click a group to show only its zones, double-click to rename it.
The **×** deletes a group with its zones. The last group stays.

- **Stacks**: How zones on the same range play: Together, In Turn or Random (see 2.4)
- **Choke**: Zones with the same choke number cut each other. A closed hi-hat stops the open one.
- **Trigger**: Attack plays when a key is pressed, Release when it is let go.

### 2.7 Zone fields

- **Key**: Lowest and highest key, and the **Fade** in semitones
- **Velocity**: Lowest and highest velocity, and the **Fade**
- **Pitch**: The **Root** key that plays the sample at its own pitch, **Transp** and **Tune**
- **Play**: **Gain**, **Pan**, **Track** (how far the keys move the pitch, 0% plays every key alike), **Turn** (the
  place in the order, with In Turn), **Reverse** and **One Shot** (plays to the end and ignores the note off)
- **Sample**: **Start** and **End**, the **Loop** mode, its **Fade** and its points **From** and **To**

Drag a value to change it, double-click to type it. A value changes all selected zones at once. It turns cream
when the selected zones disagree, hover it to see the lowest and the highest.

The start, the end and the loop points can also be dragged in the waveform. Where a loop point sits on the start
or the end, the upper half of the waveform grabs the loop point and the lower half the start or the end.

A fade only works at an edge where another zone of the same group overlaps. The outer edges of an instrument
never fade.

Loop modes:

- **Off**: The sample plays once.
- **On**: The loop repeats while the key is held. On release the sample plays on to its end.
- **Always**: The loop keeps repeating through the release.

### 2.8 Import and export

- **Import SFZ / SF2** reads one preset of a soundfont, or an SFZ file chosen together with the samples it names.
  It replaces the sample zones of the Sampler. The samples are stored as local samples under
  `Multi Samples/<file name>` in the sample browser.
- **Export SF2** saves the Sampler as a soundfont with one preset. Samples are written as 16 bit, a stereo sample
  as a left and right pair, a reversed zone with a reversed copy of its sample.

A soundfont cannot hold everything a Sampler does. Left out on export: further round robins (the first of each is
kept), zones of groups triggered on release, key and velocity fades, One Shot, the second envelope, the
LFOs and the modulation list.
