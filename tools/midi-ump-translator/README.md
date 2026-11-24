# MIDI 1.0 to MIDI 2.0 Clip Files

`midi_ump.py` converts Standard MIDI Files into `.midi2` clips and exposes each UMP as an absolute tick and a tuple of 32-bit words.

## Command line

From this folder, install Mido into a virtual environment for `.mid` import.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python midi_ump.py convert song.mid song.midi2
python midi_ump.py dump song.midi2
python midi_ump.py transpose song.midi2 song-up.midi2 12
```

Use `convert --transpose 12` to transpose while converting, or `convert --group 2` to put the file in UMP Group 2 (numbered 0–15). Reading, transforming, and writing existing `.midi2` files uses the Python standard library.

## Edit UMP packets in Python

This example sets MIDI 2.0 Note On velocity to `0xA000` while preserving each note's attribute and timestamp.

```python
from dataclasses import replace
from midi_ump import read_clip, write_clip

def set_velocity(packet):
    if packet.message_type == 4 and packet.status == 9:
        first, second = packet.words
        return replace(packet, words=(first, (0xA000 << 16) | (second & 0xFFFF)))
    return packet

clip = read_clip('song.midi2')
write_clip(clip.transform(set_velocity), 'song-edited.midi2')
```

A transform can return one packet, multiple packets, or `None` to remove a packet. Change `tick` to move it. The writer validates packet lengths and recalculates Delta Clockstamps, preserving equal-tick order. `clip.setup` is also available for edits via `dataclasses.replace`. Keep message fields valid and related note starts and stops consistent.

## Translation scope

- Supports SMF types 0 and 1 with ticks-per-quarter time division. Merges type 1 tracks into one clip in chronological order and retains channel numbers.
- Promotes notes, poly and channel pressure, and pitch bend to MIDI 2.0 Channel Voice UMP using MIDI Min-Center-Max bit scaling.
- Preserves Control Change and Program Change in MIDI 1.0 UMP so bank select and RPN/NRPN sequences stay in order. A channel with high-resolution velocity prefix (CC 88) keeps its original channel messages.
- Writes tempo and time signature as Flex Data UMP. Reports omitted events, including SysEx and unsupported metadata. SMF type 2 and SMPTE time division are outside this converter’s scope.
- The standalone CLAP Timeline Player currently plays note events at a fixed tempo. It accepts the translated files even when they contain tempo and controller packets.

Format references are the [MIDI Clip File specification](https://midi.org/midi-clip-file-specification-smf-midi-2-0), [UMP protocol specification](https://amei-music.github.io/midi2.0-docs/amei-pdf/M2-104-UM_v1-1-2_UMP_and_MIDI_2-0_Protocol_Specification.pdf), and [MIDI bit scaling specification](https://amei-music.github.io/midi2.0-docs/amei-pdf/M2-115-U_v1-0-2_MIDI%202.0%20Bit%20Scaling%20and%20Resolution.pdf).
