# Latency

What the latency number in the footer means, why it matters, and how to bring it down.

---

## What is latency?

Latency is the time between the audio engine producing a sound and that sound actually reaching your ears. When you play a note on the on-screen piano, a MIDI keyboard, or record through a microphone with effects monitoring, everything you hear is delayed by this amount.

The footer shows the **output latency** reported by your browser: the time it takes a rendered audio buffer to travel through the browser, the operating system's audio mixer, the driver, and your output device. It does not include the small, fixed render buffer of the engine itself.

As a rule of thumb:

- **Below 10 ms** — excellent, feels instant
- **10–25 ms** — fine for most playing and recording
- **Above 25 ms** — noticeably delayed; playing live instruments feels "rubbery", and openDAW shows a warning
- **Above 100 ms** — almost always a wireless output device

Latency does **not** affect the quality of your mixdown or export. It only affects how immediate live playing and monitoring feel: an export renders faster than real time and is sample-accurate regardless of this number.

## The single biggest cause: Bluetooth

Bluetooth headphones and speakers are by far the most common reason for high latency. Bluetooth audio is compressed and buffered by the codec, adding roughly **150–300 ms** depending on device and codec (SBC and AAC are the usual ones; even "low latency" codecs remain far above wired). No setting in openDAW, the browser, or the operating system can remove this. AirPods and similar earbuds are wonderful for listening, and unusable for playing live.

**Use a wired connection for playing and recording.** Any of these brings you into the green range immediately:

- Wired headphones on the built-in jack, or on a simple USB-C/Lightning adapter
- A USB audio interface (see below) with wired headphones or monitors
- Built-in laptop speakers, if nothing else is at hand — wired beats wireless

## Recommended hardware

You do not need expensive gear. In order of budget:

- **Any wired headphone** on the built-in output: already good, typically 5–20 ms
- **Class-compliant USB audio interfaces** (work without driver installation on macOS, Windows, ChromeOS, Linux, and even iPad/Android): Focusrite Scarlett series, Audient EVO 4/8, MOTU M2/M4, Universal Audio Volt, PreSonus Studio series, Behringer UMC series on a budget. All of these give clean inputs for recording plus low, stable output latency
- **Interfaces with direct monitoring**: almost all of the above have a knob or switch that routes the microphone/instrument input straight to your headphones inside the hardware, with **zero** latency. For recording vocals, use direct monitoring for your own voice and let openDAW play the backing — the round-trip latency stops mattering entirely

Avoid as monitoring outputs: Bluetooth anything, TVs and AV receivers over HDMI (they buffer for video sync, often 100 ms and more), and virtual audio devices installed by conferencing or streaming tools.

## Operating system tips

- **macOS** — CoreAudio is consistently low latency out of the box. Prefer the built-in jack or a USB interface. If an aggregate device is configured in Audio MIDI Setup, prefer the plain device
- **Windows** — the browser uses the shared system mixer (WASAPI). Keep the system sample rate of your output device at **48 kHz** (Sound settings → device properties → Advanced), matching the sample rate in openDAW's footer, so no resampling is inserted. Disable "audio enhancements" on the device, and set the power plan to Balanced/High performance on laptops
- **ChromeOS / Linux** — recent systems (PipeWire) behave well with class-compliant interfaces; older PulseAudio setups benefit from a USB interface

## Browser tips

- Chrome and Chromium-based browsers currently report and achieve the lowest, most stable output latency and are the recommended way to run openDAW
- Close tabs that also play or capture audio (calls, videos): they can hold the audio device at a higher buffering mode
- Plug in your output device **before** loading openDAW; switching devices mid-session can leave the browser on a conservative buffer until reload

## Why not zero?

Browsers do not offer the exclusive, driver-level device access that native DAWs use (ASIO, CoreAudio exclusive mode). Audio always passes through the system mixer, which costs a few milliseconds. That floor, typically 5–15 ms wired, is normal, feels immediate, and is nothing to optimise further. Everything above it is device and setup, and the sections above remove it.
