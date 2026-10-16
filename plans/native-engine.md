# Native Audio Engine (desktop)

The desktop shell runs the audio engine in its own scope, outside the webview, and talks to the sound card directly. The browser keeps its AudioWorklet engine unchanged. The native engine is one more platform strategy.

## Why now (2026-10-16)

- WKWebView adds output latency that grows with every project open. It does not happen in the browser.
  - Probe result: each bundle open stalls the audio clock for 150 to 400 ms (the new engine is instantiated on the audio thread). The clock falls further behind wall time with each open (154, 266, ~450, 541 ms) and the latency is audible.
  - Restarting the context (suspend and resume) after the load did not stop the growth. WKWebView exposes no real output latency (`getOutputTimestamp` returns the current time, `outputLatency` is a fixed 15.6 ms).
  - The cause inside WebKit stays unexplained. A native engine removes WebKit's audio path entirely.
- It also brings output device selection (no `setSinkId` in WebKit), MIDI on macOS and Linux (no Web MIDI), low latency, and native plugins later (CLAP, then VST3).

## Architecture

- **Engine host:** embedded V8 runs the existing engine host JS unchanged: the engine wasm, the device side-modules and the script, NeuralAmp and WCLAP bridges. V8 runs WebAssembly itself, nothing is ported to Rust. See the "Engine hosting" section in `plans/tauri.md` for why not `wasmtime`.
- **Driver:** `cpal` (CoreAudio, WASAPI, ASIO, ALSA, JACK). MIDI through `midir`.
- **Threads:** a V8 isolate is bound to one thread. The engine thread owns the isolate and renders 128-frame quanta into a lock-free ring. The `cpal` callback only copies from the ring and wakes the engine thread. The ring depth (a few quanta) is the only added latency, measured in the spike.
- **Process:** the engine is its own process (`opendaw-engine`), started by the shell. A crash or a plugin crash does not take the UI down, and later plugin sandboxes attach to it.
- **UI link:** shared memory cannot cross from the webview to the engine process. Box graph sync, transport and commands use the existing serialized formats over a local binary channel (loopback WebSocket). Meters, FFT, scope and `LiveStream` data are streamed the same way at frame rate.
- **Samples:** unchanged at first. The engine asks the UI with the existing `engineToClient.fetchAudio` request, now over the channel. The decoded audio is copied once between the processes, at load time only.

## Order

1. **Spike (go/no-go):** `packages/app/desktop/engine-spike/`, a separate crate, so the shell is untouched until it passes.
   - Plain `v8` crate (no `deno_core`, minimal dependencies): an isolate, a tiny `fetch` shim that reads files from `dist-desktop`, microtask pumping, no event loop.
   - A bundled host script built from `core-wasm` (`loadEngineModules`, `instantiateWasmEngine`) instantiates the real engine with an empty project (`ProjectSkeleton`), metronome on, transport playing.
   - The engine thread renders into a ring, `cpal` plays it.
   - Measure: render time per quantum, ring depth needed for no dropouts at a small device buffer, V8 garbage collection pauses, and CoreAudio's reported output latency.
   - Go when the metronome plays clean at a small buffer for minutes, including while the host allocates.
2. **Engine process and channel:** the shell starts `opendaw-engine`. The UI side gets a native `Engine` strategy that speaks the existing engine protocols over the channel instead of a `MessagePort`.
3. **Full project:** box graph sync, transport, samples over `fetchAudio`, live data, scriptable devices (the user code string goes over the channel and is evaluated in the isolate), NeuralAmp, WCLAP.
4. **Device and MIDI:** output device selection, sample rate and buffer size changes, `midir` input and output.
5. **Recording, mixdown and stems** run natively with exact latency.
6. **File storage replaces OPFS on desktop** (`plans/tauri.md` Phase 3). Then the engine reads samples straight from those files, without the copy between the processes, and samples referenced by OS file path become possible.
7. **Plugins:** CLAP via the `clack` host crates, then VST3 (check the SDK licence first), each in a sandbox process with native editor windows.

## Spike results (2026-10-16, macOS, MacBook Pro speakers, 48 kHz, device buffer 128)

- Works: `v8` 152 + `cpal` 0.18 + `rtrb`. The real engine wasm with all device modules loads from `dist-desktop` through the `fetch` shim, takes an empty project, and the metronome plays through CoreAudio.
- V8 needs `Platform::pump_message_loop` for `WebAssembly.compile` to finish. There is no other event loop.
- Engine init 15 ms. Render per 128-frame quantum: about 13 µs on average, worst 0.6 ms, against a 2.67 ms budget.
- CoreAudio reports 4.9 ms output latency (callback to playback). The ring adds its fill on top: 512 frames = 10.7 ms, 256 = 5.3 ms, 128 = 2.7 ms.
- Underruns after startup: none with a 512-frame ring, a few with 256, more with 128 (one quantum took 3 ms). The engine thread runs at normal priority and wakes through `park_timeout`/`unpark`, so scheduling jitter decides. Next: real-time priority for the engine thread, then retest 256 and 128, and a longer run that forces V8 garbage collection.
- Alternative to measure: render directly on the audio callback thread (V8 `Locker`), which removes the ring.
- Real-time priority (`audio_thread_priority` 0.38, time-constraint policy on macOS, MMCSS on Windows, rtkit on Linux): 20 s runs with a 256 and a 128 frame ring had zero underruns after startup, worst quantum about 90 µs. The same 128 frame run at normal priority dropped out repeatedly.
- Garbage collection stress (`STRESS=2000`: 2000 objects with a `Float64Array` each per quantum, roughly 1 GB/s of garbage): 30 s with a 128 frame ring, zero underruns, average 1 ms and worst 2.1 ms per quantum against the 2.67 ms budget. V8's collector keeps up even under absurd allocation.
- **Go.** Total output latency with a 128 frame ring: 2.7 ms ring + 4.9 ms CoreAudio = about 7.6 ms on the built-in speakers.

## Desktop audio duties

- Disable App Nap while the engine runs (macOS).
- Real-time thread priority for the engine thread (`audio_thread_priority`).
- Report device sample rate and buffer changes to the UI.

## Cost

About 30 MB of binary for V8 and a V8 build or prebuilt in CI. macOS needs the `allow-jit` entitlement once the app is signed.
