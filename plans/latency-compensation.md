# Latency compensation

## Intention

Devices that delay their output (lookahead limiters and compressors, linear-phase EQs, VST3 and WebCLAP plugins that
report latency) play late against the rest of the mix today. The engine should compensate: every path to the master
stays aligned, whatever latency its devices add, in the browser and in the desktop app alike.

- Each device reports its latency in samples (stock devices with lookahead, VST3 `getLatencySamples`, CLAP latency),
  and reports changes.
- The engine delays the shorter paths so every unit, bus and send arrives at the master at the same time.
- Playback, recording alignment, automation and offline renders stay sample exact.
- The device shows its latency.

Not elaborated yet.
