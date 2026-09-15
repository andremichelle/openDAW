# Capture MIDI

Capture MIDI lets you keep a performance you didn't plan to record. While an instrument is armed, openDAW silently
buffers every note that arrives from your controller. When you decide the take is worth keeping, the
{icon:Capture} **Capture MIDI** button in the header turns the buffered notes into a region on the timeline. No record
arming, no transport state, no count-in.

This is useful when you want to noodle on an idea before committing to a take, or when you played something good and
realised after the fact that you should have been recording.

## The button

The Capture MIDI button sits in the header next to the Manuals icon. It has two states:

- **Dim** — there is nothing in the buffer. The button is inert; hovering still shows its tooltip but clicks do nothing.
- **Bright** — at least one note has been captured on an armed MIDI track. Clicking commits the buffer into a new region
  and clears it.

The keyboard shortcut for committing is {key:Ctrl+Shift+M}.

## How buffering works

For each armed MIDI track, openDAW collects note-on and note-off events from your controller into a buffer that lives
alongside the track. The buffer is independent of the transport.

### Transport stopped

When the timeline is idle and you play, captured notes are timed against wall-clock arrival.

When you commit, the resulting region is placed at the current playhead, sized to the span from the first note to the
end of the last note. Note positions inside the region preserve the timing offsets you played.

### Transport playing

When the timeline is rolling, captured notes are time-stamped against the engine position in PPQN as they arrive. If
the loop wraps while you're playing, the buffer's internal offsets continue monotonically, so a phrase that spans the
loop boundary still commits as one continuous region.

When you commit, the region lands exactly where the notes were played on the timeline, as if you had been recording the
whole time.

## Buffer lifecycle

- **Playback starts** — the buffer clears. A new capture session begins in *playing* mode.
- **Playback stops** — the buffer is preserved. You can still commit notes captured during playback even after pressing
  stop.
- **First note-on after stop** — the previous session's buffer is discarded and a fresh *stopped* session begins.
- **Commit** — the buffer clears.
- **Track disarmed** — the buffer clears.
- **Recording active** — buffering is disabled. The button is dim and the commit shortcut is a no-op until recording
  ends.

## Which track gets the region?

When multiple MIDI tracks are armed, openDAW picks the target this way:

1. If the currently focused track belongs to an armed MIDI capture, the region is created there.
2. Otherwise the first armed MIDI capture is used.

This means you can keep several tracks armed for monitoring and steer where captured material lands by clicking the
track you want before pressing the button.

## Behaviour with existing material

If the captured region overlaps regions already on the chosen track, openDAW applies your current overlap-resolution
preference (clip, push, or keep). The newly committed region is selected after creation so you can move, quantise or
delete it immediately.

## Tips

- Arm your MIDI track at the start of a session and forget about it. The buffer is silent and does nothing until you
  decide to commit.
- For ideas that came together during playback, hit {key:Space} to stop, then {key:Ctrl+Shift+M} to commit. The region
  lands where you played it.
- For ideas you noodled without playback running, position the playhead where you want the region to start, then
  commit.
- Raw capture only; quantise after the fact from the note editor if you want a grid-locked version.
