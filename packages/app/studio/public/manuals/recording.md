# Recording

Your choice of monitoring device is critical for recording. Latency — the delay between playing a note and hearing it —
varies significantly between output devices. Wired headphones and studio monitors typically offer the lowest latency,
while USB audio interfaces provide professional-grade timing. Check the **Latency** indicator in the footer to see your
current delay in milliseconds. Lower values mean tighter response.

> **Warning:** Bluetooth headphones and speakers introduce substantial latency (often 100ms or more) due to wireless
> encoding. They are not recommended for recording as the delay makes it difficult to play in time.

## Arming Tracks

To record audio or MIDI, you must first arm the target instrument. Each audio-unit shows a tiny {icon:Record} button in
the track header controls. Click it to arm the track for recording. To arm multiple tracks simultaneously, hold
{key:Shift} while clicking additional arm buttons.

The arm button displays a horizontal peak meter showing input levels when an audio source is connected.

## Capture Device Selection

Use the {icon:Menu} icon in the track header and select **Capture Audio** or **Capture MIDI** to configure your input
source.

### Audio Input

Select from available audio input devices. If no devices appear, click **"Click to access external devices..."** to
grant browser permission. When you select a device, the track is automatically armed.

Additional audio options in the track menu:

- **Input monitoring** — Hear the input signal through your speakers before and during recording
- **Force Mono** — Record in mono instead of stereo

### MIDI Input

MIDI capture offers several options:

- **All devices** — Receive MIDI from all connected controllers
- **Specific device** — Select a single MIDI controller
- **Channel filter** — Choose **All channels** or a specific channel (1-16)
- **Software MIDI** — Use the on-screen keyboard when no hardware is available

## Recording

After arming your tracks, press the {icon:Record} button in the transport controls or use the keyboard shortcut.
Recording begins after a count-in (configurable in preferences). To skip the count-in, hold {key:Shift} while clicking
the record button.

To restart recording (delete current recordings and start over), use the restart recording shortcut.

## Recording Takes

When loop mode is enabled and **Allow takes** is active in preferences, each loop iteration creates a new take on a
separate track within the same audio-unit. This allows you to record multiple performances and compare them.

### Take Preferences

Configure take behaviour in **Preferences > Recording**:

- **Allow takes** — Enable or disable take recording during loops
- **Older take action** — What happens to previous takes when a new one starts:
    - **Mute region** — Mutes the recorded region but keeps the track enabled
    - **Disable track** — Disables the entire track
- **Older take scope** — Which takes are affected:
    - **Previous only** — Only the immediately previous take
    - **All takes** — All older takes on the audio-unit

## Step Recording

The note editor offers a step recording mode for entering MIDI notes one at a time without real-time performance. Toggle
step recording from the note editor menu or use the keyboard shortcut. The playhead advances automatically after each
note input.

## Latency Compensation

openDAW automatically compensates for system latency when recording. The recorded audio and MIDI data is aligned to the
correct timeline position regardless of your output device latency. However, lower latency still provides a better
real-time playing experience.
