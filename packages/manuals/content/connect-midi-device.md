# Connect MIDI Device

Play and record openDAW's instruments from a hardware MIDI keyboard or controller. Connecting a device is done per
track, from the track header's menu, so each instrument can listen to its own controller and channel.

## 1. Grant MIDI access

Click the {icon:Midi} **Midi Access** button in the app header and accept the browser's prompt. It lights up once
access is granted.

![screenshot](header-midi.webp)

_Web MIDI is not available in Safari. Firefox supports it but needs a few extra steps — see [Firefox MIDI](/manuals/firefox-midi)._

## 2. Create the instrument

A MIDI device drives an **instrument** (a synth, sampler, Playfield, etc.), so you need an instrument track to play.

- Use **Add instrument** in the timeline header, or drag an instrument from the Device Browser onto the track area, or
  drop an instrument preset.

An instrument track is a MIDI track: its input captures MIDI rather than audio, which is what lets it listen to a
controller.

## 3. Choose the device on the track header

Open the track header's menu with the {icon:Menu} button, then open the **Capture MIDI** submenu. Under **Devices**
you'll find:

- **All devices** — listen to every connected controller at once.
- **One entry per connected controller** — listen to just that device.
- **The on-screen keyboard** — a software input for when you have no hardware (see section 5).

Pick a device and openDAW **arms** the track for you. While a MIDI track is armed it monitors its input live, so
pressing keys on your controller now sounds the instrument — no transport or recording needed.

The currently selected device (and channel) is shown with a check mark, so you can see at a glance what a track is
listening to.

## 4. Channels

Each device entry opens a channel submenu:

- **All channels** — respond to MIDI on any channel (the usual choice).
- **Channel 1–16** — respond only to that one channel.

Use a specific channel when one controller sends several parts (for example a keyboard split, or a sequencer driving
different synths per channel): give each instrument track the same device but a different channel, and each plays only
its own part.

## 5. No hardware? Use the on-screen keyboard

If you have no controller, pick the **on-screen keyboard** entry in the device list. openDAW opens a software keyboard
you can play with the mouse or your computer keys, routed to the armed track exactly like a hardware device. This is
handy for sketching an idea or trying a sound before reaching for a controller.

## 6. Play, capture and record

Once a track is armed and listening:

- **Just play** — the instrument sounds live; nothing is written.
- **Capture what you played** — commit buffered notes to a region without arming a take; see the
  **Capture MIDI** page.
- **Record a take** — arm, roll the transport, and play; see the **Recording** page.

You can keep several MIDI tracks armed at once for monitoring; the header menu on each track decides which device and
channel that track listens to.

## Troubleshooting

- **No devices in the list** — grant access (section 1), and make sure the controller is connected and recognised by
  your operating system. Reopen the menu after plugging in.
- **Nothing sounds** — check the track is armed (selecting a device arms it) and that it holds an instrument, and that
  your controller is sending on the channel the track listens to.