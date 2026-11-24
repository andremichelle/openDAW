# MIDI Clip File examples

- **c-major-scale.midi2** is a generated test phrase with eight MIDI 2.0 notes, one per quarter note, in UMP Group 0 and Channel 0.
- **petzold-minuet-in-g.midi2** is Christian Petzold’s Minuet in G, BWV Anh. 114, converted with the fork’s [Python translator](../../tools/midi-ump-translator/). The original MIDI 1.0 file is alongside it. The [Mutopia Project edition](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=75) was typeset by Allen Garvin and released into the public domain.

In openDAW Studio, create an instrument track, open its track menu, and choose **Import MIDI File…**. Select either .midi2 file, then press Play. The scale spans two bars at 4/4. Set the project to 140 BPM and 3/4 to match the minuet’s source tempo and meter. The current importer uses the project tempo and meter.
