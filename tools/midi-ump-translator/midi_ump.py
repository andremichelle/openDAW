"""Translate Standard MIDI Files into editable MIDI 2.0 Clip Files."""

import argparse
from collections import Counter
from dataclasses import dataclass, replace
from pathlib import Path
import struct
import sys
from typing import Callable, Iterable, Optional, Tuple, Union

MAGIC = b"SMF2CLIP"
UMP_WORDS = (1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4)
MAX_DELTA = 0xFFFFF
START = (0xF0200000, 0, 0, 0)
END = (0xF0210000, 0, 0, 0)


@dataclass(frozen=True)
class Packet:
    """A UMP and its absolute tick within the clip (or within its setup)."""

    tick: int
    words: Tuple[int, ...]

    def __post_init__(self):
        if not isinstance(self.tick, int) or self.tick < 0:
            raise ValueError("packet tick must be a nonnegative integer")
        if not self.words or any(not isinstance(w, int) or not 0 <= w <= 0xFFFFFFFF for w in self.words):
            raise ValueError("UMP words must be unsigned 32-bit integers")
        if len(self.words) != UMP_WORDS[self.message_type]:
            raise ValueError("wrong number of words for this UMP message type")

    @property
    def message_type(self):
        return self.words[0] >> 28

    @property
    def group(self):
        if self.message_type in (1, 2, 3, 4, 5, 13):
            return (self.words[0] >> 24) & 15
        return None

    @property
    def status(self):
        """Channel Voice status nibble, or None for another message type."""
        if self.message_type in (2, 4):
            return (self.words[0] >> 20) & 15
        return None


Transform = Callable[[Packet], Optional[Union[Packet, Iterable[Packet]]]]


@dataclass(frozen=True)
class Clip:
    setup: Tuple[Packet, ...]
    events: Tuple[Packet, ...]
    end_tick: int
    lead_in_ticks: int = 0

    @property
    def ticks_per_quarter(self):
        resolutions = [p.words[0] & 0xFFFF for p in self.setup if utility_status(p.words[0]) == 3]
        if len(resolutions) != 1 or resolutions[0] == 0:
            raise ValueError("clip needs exactly one positive ticks-per-quarter packet")
        return resolutions[0]

    def transform(self, edit: Transform) -> "Clip":
        """Edit each sequence packet. Return None, one Packet, or an iterable of packets."""
        events = []
        for packet in self.events:
            result = edit(packet)
            if result is None:
                continue
            if isinstance(result, Packet):
                events.append(result)
            else:
                events.extend(result)
        end_tick = max(self.end_tick, max((p.tick for p in events), default=0))
        return replace(self, events=tuple(sorted(events, key=lambda p: p.tick)), end_tick=end_tick)


def utility_status(word):
    return (word >> 20) & 15 if word >> 28 == 0 else None


def stream_status(word):
    return (word >> 16) & 0x3FF if word >> 28 == 15 else None


def read_clip(path: Union[str, Path]) -> Clip:
    data = Path(path).read_bytes()
    if not data.startswith(MAGIC):
        raise ValueError("expected an SMF2CLIP header")
    offset = len(MAGIC)
    setup, events = [], []
    tick = 0
    lead_in = None
    while offset < len(data):
        if len(data) - offset < 4:
            raise ValueError("truncated UMP word")
        first, = struct.unpack_from(">I", data, offset)
        count = UMP_WORDS[first >> 28]
        if len(data) - offset < 4 * count:
            raise ValueError("truncated UMP packet")
        words = struct.unpack_from(f">{count}I", data, offset)
        offset += 4 * count
        status = stream_status(first)
        if utility_status(first) == 4:
            tick += first & MAX_DELTA
        elif status == 0x20:
            if lead_in is not None:
                raise ValueError("duplicate Start of Clip")
            lead_in, tick = tick, 0
        elif status == 0x21:
            if lead_in is None or offset != len(data):
                raise ValueError("unexpected End of Clip")
            clip = Clip(tuple(setup), tuple(events), tick, lead_in)
            clip.ticks_per_quarter
            return clip
        else:
            if lead_in is not None and utility_status(first) == 3:
                raise ValueError("unexpected ticks-per-quarter packet in clip sequence")
            (setup if lead_in is None else events).append(Packet(tick, words))
    raise ValueError("missing End of Clip")


def write_clip(clip: Clip, path: Union[str, Path]):
    clip.ticks_per_quarter
    data = bytearray(MAGIC)

    def write(words):
        data.extend(struct.pack(f">{len(words)}I", *words))

    def section(packets, end_tick, marker):
        previous = 0
        for packet in (*packets, Packet(end_tick, marker)):
            delta = packet.tick - previous
            if delta < 0:
                raise ValueError("packets must be in tick order and within their section")
            while delta > MAX_DELTA:
                write((0x00400000 | MAX_DELTA, 0))
                delta -= MAX_DELTA
            write((0x00400000 | delta,))
            write(packet.words)
            previous = packet.tick

    if any(utility_status(p.words[0]) == 4 or stream_status(p.words[0]) in (0x20, 0x21)
           for p in (*clip.setup, *clip.events)):
        raise ValueError("clip markers and delta clockstamps are managed by write_clip")
    if any(utility_status(p.words[0]) == 3 for p in clip.events):
        raise ValueError("ticks-per-quarter belongs in clip setup")
    section(clip.setup, clip.lead_in_ticks, START)
    section(clip.events, clip.end_tick, END)
    Path(path).write_bytes(data)


def scale_up(value: int, source_bits: int, target_bits: int) -> int:
    """Min-Center-Max scaling with bit repetition above the center."""
    if not 2 <= source_bits <= target_bits <= 32 or not 0 <= value < (1 << source_bits):
        raise ValueError("value or bit width is out of range")
    extra = target_bits - source_bits
    result = value << extra
    center = 1 << (source_bits - 1)
    if value > center:
        pattern_width = source_bits - 1
        pattern = value & (center - 1)
        repeated = 0
        for _ in range(0, extra, pattern_width):
            repeated = (repeated << pattern_width) | pattern
        result |= repeated >> ((-extra) % pattern_width)
    return result


def _channel_words(message, group, keep_midi1):
    kind = message.type
    channel = message.channel
    first = 0x40000000 | (group << 24) | (channel << 16)
    if not keep_midi1:
        if kind in ("note_on", "note_off"):
            on = kind == "note_on" and message.velocity != 0
            velocity = message.velocity if kind == "note_off" or on else 64
            return (first | ((9 if on else 8) << 20) | (message.note << 8), scale_up(velocity, 7, 16) << 16)
        if kind == "polytouch":
            return (first | 0x00A00000 | (message.note << 8), scale_up(message.value, 7, 32))
        if kind == "aftertouch":
            return (first | 0x00D00000, scale_up(message.value, 7, 32))
        if kind == "pitchwheel":
            return (first | 0x00E00000, scale_up(message.pitch + 8192, 14, 32))
    # Keep CC and Program Change together as MIDI 1.0 UMP, including Bank Select and RPN/NRPN.
    status, data1, data2 = (*message.bytes(), 0)[:3]
    return (0x20000000 | (group << 24) | (status << 16) | (data1 << 8) | data2,)


def read_smf(path: Union[str, Path], group: int = 0):
    """Return (Clip, Counter of omitted SMF event types) for a type 0 or type 1 file."""
    try:
        from mido import MidiFile
    except ImportError as exc:
        raise RuntimeError("SMF import needs Mido. Install it with python3 -m pip install mido==1.3.3") from exc

    if not 0 <= group <= 15:
        raise ValueError("UMP group must be in the range 0–15")
    midi = MidiFile(path)
    if midi.type not in (0, 1):
        raise ValueError("SMF type 2 contains independent sequences; use a type 0 or 1 file")
    if not 1 <= midi.ticks_per_beat <= 32767:
        raise ValueError("SMPTE time division is unsupported; input must use ticks per quarter note")

    merged = midi.merged_track
    # CC 88 changes the interpretation of following velocities. Preserve that channel's
    # original Channel Voice messages rather than splitting the prefix from its notes.
    prefixed_channels = {
        msg.channel for msg in merged if msg.type == "control_change" and msg.control == 88
    }
    setup = (Packet(0, (0x00300000 | midi.ticks_per_beat,)),)
    flex = 0xD0100000 | (group << 24)
    tick = 0
    events = []
    omitted = Counter()
    for msg in merged:
        tick += msg.time
        if msg.type == "set_tempo":
            if msg.tempo == 0:
                raise ValueError("SMF tempo must be positive")
            words = (flex, msg.tempo * 100, 0, 0)
        elif msg.type == "time_signature":
            words = (flex | 1, (msg.numerator << 24) | ((msg.denominator.bit_length() - 1) << 16)
                     | (msg.notated_32nd_notes_per_beat << 8), 0, 0)
        elif not msg.is_meta and hasattr(msg, "channel"):
            words = _channel_words(msg, group, msg.channel in prefixed_channels)
        else:
            if msg.type != "end_of_track":
                omitted[msg.type] += 1
            continue
        events.append(Packet(tick, words))
    return Clip(setup, tuple(events), tick), omitted


def transpose(semitones: int) -> Transform:
    """Transpose note and poly-pressure keys. Raise if a key would go out of range."""
    def edit(packet):
        if packet.status not in (8, 9, 10):
            return packet
        word, *tail = packet.words
        key = ((word >> 8) & 127) + semitones
        if not 0 <= key <= 127:
            raise ValueError(f"transposed note out of range at tick {packet.tick}")
        return replace(packet, words=((word & ~0x7F00) | (key << 8), *tail))
    return edit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    convert = commands.add_parser("convert", help="translate .mid to .midi2")
    convert.add_argument("input", type=Path)
    convert.add_argument("output", type=Path)
    convert.add_argument("--group", type=int, choices=range(16), default=0)
    convert.add_argument("--transpose", type=int, default=0, metavar="SEMITONES")
    edit = commands.add_parser("transpose", help="transpose an existing .midi2 clip")
    edit.add_argument("input", type=Path)
    edit.add_argument("output", type=Path)
    edit.add_argument("semitones", type=int)
    dump = commands.add_parser("dump", help="print absolute ticks and UMP words")
    dump.add_argument("input", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "dump":
            clip = read_clip(args.input)
            print(f"{clip.ticks_per_quarter} ticks/quarter, end at tick {clip.end_tick}")
            for name, packets in (("setup", clip.setup), ("event", clip.events)):
                for packet in packets:
                    words = " ".join(f"{word:08X}" for word in packet.words)
                    print(f"{name:5} {packet.tick:8}  {words}")
            return
        if args.input.resolve() == args.output.resolve():
            raise ValueError("input and output must be different files")
        if args.command == "convert":
            clip, omitted = read_smf(args.input, args.group)
            if args.transpose:
                clip = clip.transform(transpose(args.transpose))
            if omitted:
                print("Omitted SMF events: " + ", ".join(f"{kind} ({count})" for kind, count in sorted(omitted.items())),
                      file=sys.stderr)
        else:
            clip = read_clip(args.input).transform(transpose(args.semitones))
        write_clip(clip, args.output)
        print(f"Wrote {len(clip.events)} sequence packets to {args.output}")
    except (ValueError, OSError, RuntimeError) as exc:
        parser.exit(1, f"error: {exc}\n")


if __name__ == "__main__":
    main()
