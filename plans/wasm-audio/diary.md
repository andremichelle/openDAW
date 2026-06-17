# Diary

## Day 1: foundations

- Sine: Rust DSP to wasm, played in an AudioWorklet, with a test app and a live deploy. Done.
- Composition spike: independent wasm modules share memory and call each other; plugin and memory model validated. Done.
- Parity harness: native unit tests plus offline wasm-vs-TS null tests in CI. Done.

## Day 2: data layer, live sync, and the metronome

- BoxGraph in Rust: ported and proven by loading a real project byte-for-byte. Done.
- Schema registry: the TS box-forge now also generates the Rust registry from the same schema. Done.
- Updates and sync-log replay: apply and undo the update stream; a recorded session replays end to end. Done.
- Checksum: a Rust graph checksum that matches the TS one exactly. Done.
- Live sync: the unchanged SyncSource streams every transaction into the wasm engine, checksum-validated. Done.
- Subscriptions: the Rust graph notifies listeners on changes, with clean removal. Done.
- Transport: PPQN time conversions and a block-by-block transport clock. Done.
- Metronome: a live page where the engine renders the click and reacts to bpm and signature edits in real time. Done.
- Allocator: a test-grade bump allocator is in place; a real reclaiming allocator is the prerequisite for samples. Pending.
