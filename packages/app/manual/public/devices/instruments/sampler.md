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

- **Voices**: How many voices may sound at once. The oldest one falls away when a new one needs room. One voice
  makes the instrument monophonic.
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

- **Add Samples** opens a file dialog. Several files can be chosen at once.
- Samples and audio files can also be dropped onto the map.

New samples are mapped from their file names: a note name (`C4`, `c#3`, `Bb2`) becomes the root key, a dynamic
(`pp` to `fff`, or `v1`, `v2`) becomes a velocity layer and `rr1`, `rr2` number the round robins. Notes are read
in scientific pitch, where `C4` is the middle C.

### 2.2 The map

The map shows keys from left to right and velocity from bottom to top, with a piano below it. Every sample zone
is a rectangle.

- **Click** a zone to select it. **Shift**, **Cmd** or **Ctrl** click adds a zone or takes it out again.
- **Click** empty space to deselect.
- **Drag** on empty space to draw a selection rectangle.
- **Drag** a zone to move it. Drag an edge to change its range. All selected zones follow.
- Play the piano to hear the instrument. The zones that answer the key are selected.

Zones on the same keys and velocities in one group are round robins. They show as one rectangle with their
number.

### 2.3 Tools

The tools act on the selected zones.

- **Select All**: Every zone of the shown group
- **Map by Name**: Maps the zones from their file names again
- **Spread Keys**: Extends each zone halfway to the neighbouring roots, so no key is left empty
- **Spread Velocity**: Splits the velocity range evenly between the layers on the same keys
- **Crossfade**: Lets neighbours overlap and fade into each other
- **Root to Low**: Sets the root key to the lowest key of the zone
- **Duplicate**: Copies the zones as further round robins
- **Move to Group**
- **Delete**: Takes the zones off the map. They stay in the list, dimmed.
- **Restore**: Puts them back
- **Clean Up** (top right): Removes the zones that were taken off the map

### 2.4 Groups

A group collects zones that behave the same way. Click a group to show only its zones.

- **Robin**: Off plays every zone that answers. Cycle plays the round robins in turn, Random picks one and never
  the same twice in a row.
- **Choke**: Zones with the same choke number cut each other. A closed hi-hat stops the open one.
- **Trigger**: Attack plays when a key is pressed, Release when it is let go.

### 2.5 Zone fields

- **Key**: Lowest and highest key, and the **Fade** in semitones
- **Velocity**: Lowest and highest velocity, and the **Fade**
- **Pitch**: The **Root** key that plays the sample at its own pitch, **Transp** and **Tune**
- **Play**: **Gain**, **Pan**, **Track** (how far the keys move the pitch, 0% plays every key alike), **Seq** (the
  place among the round robins), **Reverse** and **One Shot** (plays to the end and ignores the note off)
- **Sample**: **Start** and **End**, the **Loop** mode, its **Fade** and its points **From** and **To**

A fade only works at an edge where another zone of the same group overlaps. The outer edges of an instrument
never fade.

Loop modes:

- **Off**: The sample plays once.
- **On**: The loop repeats while the key is held. On release the sample plays on to its end.
- **Always**: The loop keeps repeating through the release.

A value changes all selected zones at once.
