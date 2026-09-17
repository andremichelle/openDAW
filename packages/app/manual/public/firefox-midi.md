# Request Midi Access On Firefox Does Not Work

This is a known issue with Firefox's MIDI implementation. Unlike Chrome, which allows requesting MIDI access even if no
devices are currently connected, Firefox denies access outright if **no MIDI devices are detected** at the time of the
request.

### Solutions

1. **Restart Firefox**
    - If you connected the MIDI device after starting Firefox, restart the browser and try again.

2. **Check Firefox Permissions**
    - Open `about:config` in a new tab.
    - Search for `dom.webmidi.enabled`.
    - Ensure it is set to `true`. If not, double-click to enable it.
    - Search for `privacy.resistFingerprinting` (if enabled, it can block MIDI access).
    - Set `privacy.resistFingerprinting` to `false`.

3. **Verify Device Detection**
    - Check if your OS detects the MIDI device.
    - On macOS: Open `Audio MIDI Setup` > `MIDI Studio` and ensure your device is listed.
    - On Windows: Check `Device Manager` under "Sound, video and game controllers."

4. **Force Firefox to Recognize the Device**
    - Connect your MIDI device before starting Firefox.
    - Restart the browser with the device already connected.

5. **Use Chrome or Edge**
    - If Firefox's handling of MIDI is problematic, you might consider using a Chromium-based browser for MIDI-related
      tasks.

(ChatGPT Feb. 2025)