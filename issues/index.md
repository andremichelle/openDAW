# openDAW issues

All 422 GitHub issues (pull requests excluded), fetched 2026-11-09. Open issues have one file each with summary, analysis and a possible solution. Closed issues are listed below only.

## Open (49)

Complexity: small 9, medium 17, large 20, unknown 3

Status: probably-fixed 1, ready 17, partially-done 13, discussion 10, needs-info 5, blocked 3

Sorted by status (probably fixed and ready first), then complexity.

| # | Title | Type | Area | Status | Complexity | Summary |
|---|---|---|---|---|---|---|
| [325](0325.md) | Shared transport / synced listening for Live Rooms | feature | live room | probably-fixed | small | Live room participants want to listen to the project together, roughly in sync, by sharing transport play, stop and position. |
| [84](0084.md) | Store project's editing progress in IndexedDB | feature | project storage | ready | small | Keep a backup of unsaved project edits when the tab is closed anyway, and offer to restore it on the next start. |
| [464](0464.md) | Need support for sf2 files | bug | soundfont | ready | small | Importing some .sf2 files fails with "Missing required 'INAM' sub-chunk" because the file has an empty name chunk. |
| [532](0532.md) | Autotune: choose a custom set of notes | feature | devices | ready | small | Autotune should offer a Custom scale where the user picks exactly which of the 12 notes to correct to, independent of the project key. |
| [38](0038.md) | Automation Region Editor - Specify Automation Region Unit and Resolution | feature | automation | ready | medium | Let automation (especially MIDI Output CC parameters) use a coarser value resolution, an on/off mode, or a native 0 to 127 unit instead of percent. |
| [90](0090.md) | Request - Mid-Side EQ | feature | devices | ready | medium | An EQ that edits the mid and side signals separately, like a switchable Revamp with M and S modes. |
| [201](0201.md) | classic time stretch | feature | audio engine | ready | medium | Add a granular time stretch mode with short grains that advance steadily through the audio, with an adjustable grain rate in sync or Hz. |
| [209](0209.md) | Paulstretch Effect | feature | audio editing | ready | medium | Add Paul Nasca's Paulstretch extreme time stretching as a built-in processing option. |
| [241](0241.md) | Envelope on soundfont player | feature | devices | ready | medium | Short notes on the Soundfont player ring on for too long, the reporter wants an envelope to control it. |
| [249](0249.md) | File evaluation and choosing | feature | cloud | ready | medium | Cloud backup should let the user choose between the cloud copy, a renamed copy or the local copy when a project exists in both, after comparing them. |
| [388](0388.md) | Shared source files you can link to in the scripting editors | feature | scripting | ready | medium | A library of shared source files that scripts can include, with types read by the editor for auto completion. |
| [460](0460.md) | Ripple Cut | feature | timeline | ready | medium | Deleting a region should optionally close the gap by moving later regions left (ripple delete). |
| [513](0513.md) | Keep frozen state of an audio-unit | feature | audio engine | ready | medium | A frozen audio unit is unfrozen after the project is reloaded, the frozen state should be saved and restored on load. |
| [270](0270.md) | automating enable/disable of effects is not possible | feature | devices | ready | large | Allow automating the enabled (bypass) state of audio effects, with a click free fade and a cleared effect state when turned on. |
| [277](0277.md) | werkstatt midi input | feature | scripting | ready | large | Let Werkstatt audio effect scripts receive notes from a MIDI track, for example to trigger an envelope that modulates a ring modulator. |
| [487](0487.md) | Scriptable devices: local storage API to save and load data such as patterns and waveforms | feature | scripting | ready | large | Scriptable devices get a private per script library in OPFS, reachable from script views, to save and reload data such as patterns and waveforms across projects. |
| [489](0489.md) | Scriptable modulator: a script-driven modulation source in the modulation tab, with its own custom views | feature | modulation | ready | large | A Script modulator type in the modulation tab whose value per update tick comes from a user script, with custom views like the script devices. |
| [512](0512.md) | midi output should be able to record audio from hardware | feature | MIDI | ready | large | Let a MIDI Output unit also record and monitor the hardware synth's audio return into an audio track of the same unit. |
| [57](0057.md) | Drag existing effects between tracks | feature | devices | partially-done | small | Drag an existing effect from one track onto another track (move, Alt to copy) instead of cut and paste. |
| [185](0185.md) | Clip view issues | bug | timeline | partially-done | medium | Clips can be moved into hidden clip columns, and the clip view can be widened until the arrangement is pushed off screen. |
| [188](0188.md) | Request - Real time Audio Pitch shifter | feature | devices | partially-done | medium | A real time audio pitch shifter effect with semitones, cents, mix, output and a low latency and a quality mode. |
| [352](0352.md) | CUBED / general improvements | feature | devices | partially-done | medium | Collection of pattern editing ideas for the CUBED 303 device: MIDI export and import, octave shift, double, reverse and invert. |
| [408](0408.md) | Composite Drag UX | feature | UI | partially-done | medium | Drag effects between a composite layer and the parent chain, and enter or leave layers by holding a drag over them, so effects can be dropped mid chain. |
| [413](0413.md) | Audio clip utilities | feature | audio editing | partially-done | medium | Request for audio region tools: cut and close gaps, reverse, normalize, mono, phase invert, clip gain envelope, warp marker guide lines. |
| [92](0092.md) | light contrast theme support | feature | UI | partially-done | large | Add a light theme (near white panels, near black text) with a switch, browser default and persistence. |
| [139](0139.md) | Request - Parameter Modulation Controllers | feature | modulation | partially-done | large | Request for parameter modulators: envelope follower, LFO, MSEG, step, XY, key tracking and velocity. |
| [170](0170.md) | Dynamically load devices into the studio | feature | devices | partially-done | large | Load devices (stock and external) on demand at runtime instead of bundling them all, with sandboxing so a broken device cannot crash the studio. |
| [203](0203.md) | Analyser Device | feature | devices | partially-done | large | An analyser with oscilloscope, spectrum, spectrogram, phase scope, pitch detector and loudness, ideally able to compare several tracks. |
| [288](0288.md) | convert playfield into a generic one-shot grid | feature | devices | partially-done | large | Let the Playfield host any instrument per pad, so a drum kit can mix synths and samples, plus a named drum key layout in the note editor. |
| [300](0300.md) | Grouped tracks | feature | timeline | partially-done | large | Folder style group tracks in the timeline that collapse their children and route them through a shared bus. |
| [411](0411.md) | Make Nano V2 including all feature of a Playfield slot | feature | devices | partially-done | large | Nano must cover every feature of a Playfield slot so that Playfield pads can be replaced by Nano instances. |
| [255](0255.md) | Implement dough-samples to default openDAW samples | feature | cloud | discussion | small | Add Strudel's dough-samples collection to the default openDAW sample library. |
| [149](0149.md) | Separate envelopes for volume and filter in Vaporisatur | feature | devices | discussion | medium | Vaporisateur uses one ADSR for both amplitude and filter cutoff, users ask for a separate filter envelope. |
| [327](0327.md) | Add a "deleted tracks" pan | feature | timeline | discussion | medium | Tracks disappear unnoticed, the reporter asks for a recycle bin panel to listen to and restore deleted tracks. |
| [245](0245.md) | Podcast Recording | feature | recording | discussion | large | Collection of podcast production ideas (track roles, chapter markers, soundboard, voice effects, chapter export) plus questions on multi hour recordings and a native capture backend. |
| [322](0322.md) | Support for Ambisonic | feature | audio engine | discussion | large | Request for Ambisonics and multichannel immersive audio with 64 to 128 output channels and multichannel tracks. |
| [354](0354.md) | Multiple projects | feature | project | discussion | large | Copy synths and clips between projects and merge a whole project into another, ideally with several projects open at once. |
| [355](0355.md) | hardware latency compensation | feature | audio engine | discussion | large | External hardware played through MIDI Output and monitored back through an audio input is heard about twice the audio latency late, and the reporter wants the rest of the mix delayed to match. |
| [452](0452.md) | Client-Side Audio-to-MIDI Transcription via MuScriptor ONNX / WebGPU | feature | AI tools | discussion | large | Client side audio to MIDI transcription with the MuScriptor model via ONNX Runtime Web and WebGPU. |
| [498](0498.md) | Add MIDI sustain support | feature | MIDI | discussion | large | A sustain pedal on a MIDI keyboard (CC64) should hold notes in openDAW, live, while recording and on playback. |
| [485](0485.md) | Adding Vibe Plugin support for opendaw | question | plugins | discussion | unknown | Kilian asks whether openDAW could load his VibePlugin format (.vstai, WASM plus HTML UI) or offer a plugin browser. |
| [493](0493.md) | A MIDI note played during the count-in is dropped, or snapped to the downbeat; the audio recorder keeps the same pickup | question | recording | needs-info | small | MIDI recording drops notes played during the count-in and writes held notes at the downbeat, while the audio recorder keeps the count-in head behind the waveform offset. |
| [535](0535.md) | Compressor live stream: add the input and output peak since the last frame | feature | devices | needs-info | small | Riffle wants faster input and output levels from the compressor live stream so ghost notes and gaps between hits show in its compressor display. |
| [102](0102.md) | Request - Volume Envelope Device | feature | devices | needs-info | medium | An audio effect that shapes the volume with a drawn one shot envelope, like a single cycle of Tidal. |
| [404](0404.md) | OpenDAW sometimes hangs while loading a project | bug | project loading | needs-info | unknown | Opening a project sometimes stays on the Loading dialog forever, a page reload fixes it. |
| [516](0516.md) | Safari: input peak meter reacts about 500 ms late | bug | recording | needs-info | unknown | In Safari the input peak meter of an armed audio track lags about 500 ms behind the sound, recording itself is aligned. |
| [518](0518.md) | latency issues on linux | bug | audio output | blocked | small | 40 to 50 ms output latency and a 115 ms round trip on Linux (Fedora, PipeWire, Chromium based Helium, Scarlett Solo). |
| [23](0023.md) | Native Version | feature | desktop | blocked | large | Request for a locally installable openDAW for Linux, for offline use and better audio performance. |
| [409](0409.md) | Dragging playfield instruments into seperate tracks | feature | devices | blocked | large | Drag a Playfield pad to the timeline to split it into its own track with its notes and its own effects. |

## Closed (373)

| # | Title | Type | Area | Resolution | Summary |
|---|---|---|---|---|---|
| 534 | An entire-song render stops at 10 s of silence even when regions still follow | bug | export | fixed | Entire song renders stop after 10 s of silence even when regions follow. |
| 533 | A looped pass runs one frame short at some combinations of rate, length and bpm | bug | audio engine | fixed | A looped pass runs one frame short at some combinations of sample rate, length and bpm. |
| 530 | renderSection drops frames at frame 48000 when delay compensation is not a whole number of quanta | bug | export | fixed | Rendering a section with a latent device loses frames at frame 48000. |
| 529 | Past the 100 ms cap, compensationLatency and the PDC footer report more delay than the audio gets | bug | audio engine | fixed | Above the 100 ms cap the latency report exceeds the delay actually applied. |
| 528 | "With Effects" monitoring reaches the output twice: is the main-mix route intended? | bug | audio engine | fixed | A track monitored With Effects reaches the output twice, through the monitor return and the main mix. |
| 527 | OPFS: deleting a file written through a sync access handle drives Chrome's saved per-origin usage negative | bug | storage | fixed | Deleting OPFS files makes Chrome report about 4 GB used after a restart. |
| 526 | Arpeggio: is a held note's cent meant to be dropped? Every arpeggiated note-on is emitted with cent 0 | bug | MIDI | fixed | The Arpeggio emitted every note with cent 0, dropping detune of held notes. |
| 525 | Zeitgeist moves note-offs as well as note-ons, so note durations change with the groove; the manual says they stay | bug | MIDI | answered | Zeitgeist also shifts note-offs, which contradicts the manual saying durations stay unchanged. |
| 524 | Arpeggio: the Velocity control does not do what its manual says | bug | devices | fixed | The Arpeggio Velocity control behaves differently from its manual in the lower half of its range. |
| 523 | ScriptCompiler.compile resolves for a script that throws at module load; the device keeps the previous script with the new script's parameters | bug | SDK | fixed | A script that throws at module load compiles without error and the old script keeps running with the new parameters. |
| 521 | Missing search feature within Manuals | feature | docs | fixed | Add a text search to the manuals page. |
| 520 | canceling soundfont import still imports it anyways | bug | import | fixed | Cancelling the large soundfont prompt still imports the soundfont. |
| 519 | allow stereo input on audio tracks | feature | recording | fixed | Requests stereo input selection on audio tracks, like Bitwig, to record both mic and line input of an interface. |
| 517 | delete project dialog should include the name of the project | feature | UI | fixed | The delete project dialog should include the project name to avoid deleting the wrong one. |
| 515 | Let the user increase the spectrum precision in the low end | feature | devices | fixed | Requests higher spectrum precision in the low end below about 100 Hz in Revamp and Analysis. |
| 514 | Second Ctrl+Shift copy of a mirrored region is not a mirror | bug | timeline | fixed | A second Ctrl+Shift copy of a mirrored region is not a mirror, the same inversion affects clips. |
| 511 | pressing escape in the preferences window should exit it | feature | UI | fixed | Escape should leave the preferences page like Go back to Studio. |
| 510 | community script view UI / UX | feature | scripting | fixed | Improve the community scripts dialog layout and selection. |
| 509 | Play / Resume / does the opposite | bug | transport | fixed | The play button menu option about resuming behaves opposite to what its label suggests. |
| 508 | Multi-SOLO using SHIFT+SOLO doesnt work in Firefox | bug | mixer | fixed | Multi-solo with Shift plus Solo does not work in Firefox. |
| 507 | empty werkstatt device is too narrow to access the editor | bug | devices | fixed | A new empty Werkstatt device is too narrow to reach the code editor button. |
| 506 | compiling a device with a custom view that exceeds horizontal space does not recompute the device view width correctly | bug | devices | fixed | The device panel does not grow its scroll range after a custom view gets wider on recompile. |
| 505 | horizontal scrolling in the device view is prevented when the cursor is on a custom view iframe | bug | scripting | fixed | The device panel does not scroll horizontally while the cursor is over a custom view iframe. |
| 504 | "Omitting @label keeps the current name." - better reset to a default name? | bug | scripting | fixed | A script compiled without @label kept the previous script's device name. |
| 497 | storage: add button to delete unused samples/instruments/etc | feature | storage | fixed | Requests a button in storage to delete unused samples, instruments and similar files. |
| 494 | A sample of 1200 frames or fewer never loads: the peaks stage fit returns no stage and the peak worker throws | bug | audio | fixed | Samples of 1200 frames or fewer fail to load or import. |
| 492 | A key released during, or just after, a main-thread block is recorded far too short | bug | recording | fixed | MIDI notes released during a main-thread block are recorded far too short. |
| 491 | Recorded MIDI notes land about 33 ms after the beat the player heard; a sound recorded at the same instant lands on it once the audio input latency is calibrated | bug | recording | fixed | Recorded MIDI notes land about 33 ms after the beat the player heard. |
| 488 | Script views: params without a default control, with the parameter context menu inside the view | feature | scripting | fixed | Let script params omit the default knob and open the parameter menu inside a view. |
| 484 | DAWproject export/import scales tempo automation as if events were 0–1 fractions (120 BPM exports as 32430) | bug | export | fixed | DAWproject export and import scale tempo automation as 0 to 1 fractions, so 120 BPM exports as 32430. |
| 483 | Audio recording deleted from timeline on Windows | bug | recording | fixed | On Windows a finished audio recording is removed from the timeline. |
| 482 | No plug-in delay compensation: a look-ahead device shifts its track 5 ms against the rest | feature | audio engine | fixed | No plug-in delay compensation, so a look-ahead device such as Compressor or Maximizer shifts its track about 5 ms against the rest. |
| 481 | add search bar to "Add new device" context menu | feature | UI | fixed | Add a search bar for adding devices. |
| 480 | A pointer write through a box instance that undo replaced reaches the live graph | bug | SDK | fixed | A pointer write through a stale box instance after undo creates a ghost edge and diverges the engine mirror. |
| 479 | Stopping a recording drops the input still in flight: the take ends at the frames the main thread had received when it observed the stop | bug | recording | fixed | A stopped recording loses input captured before the stop but not yet delivered to the main thread. |
| 478 | Desktop sincro Version | feature | desktop | not-planned | Requests a desktop version with latency under 7 ms. |
| 467 | nano: mono/poly setting | feature | devices | fixed | Add a mono and poly switch with voice count to Nano. |
| 463 | Exclude Metronome from master analysis | feature | audio engine | fixed | The metronome should not appear in master meters and analysis. |
| 461 | Audio Track monitoring with effects doesn't work while in forced mono. | bug | recording | fixed | Monitoring an audio track With Effects is silent when forced mono is enabled. |
| 459 | Parameter write in the same transaction as an effect's enabled toggle never reaches the engine | bug | SDK | fixed | A parameter write in the same transaction as an effect enabled toggle is not sent to the engine. |
| 458 | Addition of the opus audio codec as an export option. | feature | export | fixed | Add Opus as an audio export format. |
| 456 | Could you make requestFullscreen optional, please? | feature | web platform | fixed | The studio fails to start in a browser without fullscreen API support. |
| 453 | see size of stored samples in samples tab | feature | UI | fixed | Requests showing the size of stored samples in the samples tab to find out what uses the storage. |
| 449 | Instant CPU Overload using a special project | bug | audio engine | unknown | A specific project overloads the CPU almost instantly in Chrome. |
| 448 | Webclap / RipplerX / Snappy knobs accelerate to max after 50% turn | bug | devices | fixed | RipplerX WebCLAP knobs jump to maximum after turning about 30 percent. |
| 447 | Webclap / Popout in new Window doesnt show UI content | bug | devices | fixed | Pop out in new window shows no UI for some WebCLAP devices (OBX, SixSines, Odin2, RipplerX) in Firefox. |
| 446 | Webclap / 6 Sines / Creates 100% CPU spikes if parameters are change | bug | WebCLAP | fixed | Changing parameters of 6 Sines causes CPU spikes and interrupted sound. |
| 445 | Webclap / PRO54 / Program Name list names hidden | bug | WebCLAP | not-planned | The PRO54 program list shows white entries on white in Chrome. |
| 444 | Webclap / PRO54 / Knobs get "stuck" while mouse moves outside the window while dragging | bug | WebCLAP | fixed | Knobs in the WebCLAP PRO54 stay attached to the mouse after it leaves the window while dragging. |
| 443 | Webclap / Pro 54 / Recording of program changes creates interpolated automation | bug | WebCLAP | fixed | Recording program changes of the Pro54 WebCLAP device creates interpolated automation. |
| 442 | Device (Konsole) | feature | devices | invalid | Request for a complex modulation device. |
| 441 | Macro settings | feature | devices | invalid | Vague request for a max to min range on macro settings. |
| 440 | Tab Macro | feature | devices | invalid | Unclear request about macro tabs. |
| 439 | Syncron vst | feature | devices | invalid | Request for a detune and unison effect with many listed parameters. |
| 438 | Tab Rack | feature | UI | invalid | Request titled Tab Rack with no concrete description. |
| 437 | Rack tab | feature | UI | invalid | Vague request for a rack tab, with only a screenshot as description. |
| 436 | Midi option | feature | MIDI | invalid | Vague request to choose any MIDI option for a trigger. |
| 435 | Granulizer synthesis | feature | devices | invalid | Request for a granular synthesizer with many parameters. |
| 434 | Allow defining mixdown region | feature | export | fixed | Requests defining which region of the project is rendered, via markers, a dialog or the loop region. |
| 433 | online werkstatt market | feature | scripting | unknown | Request for an online marketplace tab to share Werkstatt scripts. |
| 432 | Size-ing the tracks | feature | UI | invalid | Vague request to size the tracks for viewing comfort on the timeline. |
| 429 | The first packet a new subscriber gets from a float broadcast can be the array as it stood before anyone subscribed: all zeros from the loudness meter on a new worklet | bug | audio engine | fixed | The first loudness packet to a new subscriber can be all zeros. |
| 428 | The loudness meter has no reset | bug | audio engine | fixed | Integrated loudness and range accumulate for the whole life of the engine worklet. |
| 427 | The loudness stream's "true peak" is the highest sample: EBU Tech 3341 cases 16–18 read −9.03, −7.27 and −6.71 dBTP for a −6.0 dBTP tone | bug | audio engine | fixed | The loudness stream's true peak value is the highest sample, so EBU Tech 3341 true peak cases read far below the expected -6 dBTP. |
| 426 | The loudness meter's K-weighting reads 0.25 LU low at 1 kHz and up to 0.5 LU low between 1 and 3 kHz: EBU Tech 3341 loudness cases 1-5 fail | bug | audio engine | fixed | The loudness meter K-weighting deviates from ITU-R BS.1770 around 1 to 3 kHz and fails EBU Tech 3341 cases. |
| 424 | A take's start-of-take time stamps can be a render quantum early in Chrome | bug | recording | fixed | On rare recordings a take lands one render quantum (128 frames) away from other takes. |
| 423 | Tubular creates clipped sounds when switching Engine | bug | devices | fixed | Switching the Tubular engine between Mark I and Modern while playing clicks. |
| 421 | regions start/ends are hard to see | bug | timeline | fixed | Adjacent regions blend together so region boundaries are hard to see. |
| 420 | ProjectApi.createNoteRegion never writes its loopOffset parameter | bug | SDK | fixed | createNoteRegion ignores loopOffset because the value is written into loopDuration and then overwritten. |
| 419 | A metronome click in flight when the transport stops resumes at the next play | bug | audio engine | fixed | A metronome click still sounding when the transport stops resumes at the next play, causing a doubled or stray click. |
| 417 | time sig automation viewer bug | bug | timeline | fixed | With only the time signature automation track visible, the timeline becomes blank. |
| 416 | loop region shortcut | feature | timeline | fixed | Shortcut to enable looping and loop the current selection. |
| 415 | audio dropouts while interacting with UI | bug | audio engine | fixed | Playback has small dropouts while selecting or editing in large projects. |
| 414 | return playhead to initial position when stopping | feature | transport | fixed | Playhead should return to its start position on stop instead of on next play. |
| 412 | Visibility toggles | feature | UI | fixed | Clip menu and tempo and signature automation visibility should persist. |
| 410 | Project closes if ALT+Mousewheel is used outside timeline | bug | UI | fixed | Using Alt plus mouse wheel outside the timeline closes the project in Firefox. |
| 407 | Total UX freedom | feature | UX | answered | Megathread for the reporter's UX ideas linking #403, #405, #408 and #409. |
| 405 | Make curve envelope selectable | feature | automation | fixed | Curve slope values of envelopes should be selectable and editable by typing. |
| 403 | New device drag UX | feature | UI | fixed | Dragging new devices needs auto scroll and an easier drop target. |
| 402 | FX Bus Send in Mixer: Routing stuck to Pre Send, doesn't allow to choose Post Fader or Post Pan | feature | mixer | fixed | FX bus sends in the mixer are stuck on Pre Send and cannot be set to Post Fader or Post Pan. |
| 400 | bitcrush plugin mix knob working nonlinearly | bug | devices | fixed | The Crusher mix knob uses most of its range at the far right. |
| 398 | Clips UX | feature | timeline | fixed | Resizing clips is confusing because the top half sets loop length and the bottom half sets clip length. |
| 396 | DEV / instrument composite Drag n Drop on existing Instrument device creates empty composite | bug | devices | invalid | Dropping a composite on an existing instrument created an empty composite on DEV. |
| 395 | DEV / Instrument Composite / Split (using Spielwerk Filter) / doesntWork with Spielwerk Sequencer (e.g. 303 preset) | bug | MIDI | fixed | An instrument composite split using Spielwerk filters does not work when the input comes from another Spielwerk, such as the 303 sequencer. |
| 394 | werkstatt effects do not clear their audio buffer on Stop function | bug | Werkstatt | fixed | Werkstatt devices keep sounding after Stop. |
| 393 | device parameters do not update when playback is paused | bug | automation | fixed | Automation does not update parameters when the playhead moves while paused. |
| 392 | clicking on "loop selection" should enable looping if disabled | feature | timeline | fixed | Loop selection should also turn looping on. |
| 391 | changing time sig automation does not update the timeline grid properly | bug | timeline | fixed | Time signature automation does not refresh the timeline grid. |
| 390 | DEV / copying device between composite layers removes existing note clip | bug | devices | fixed | Copying an instrument between composite layers deletes the existing note clip. |
| 389 | DEV / instrument compose / Deleting layer causes exception | bug | devices | fixed | Deleting a layer of an Instrument Composite throws an exception. |
| 385 | Copying Track from one Project to another creates an Exception | bug | timeline | fixed | Pasting a track copied from another project throws an exception. |
| 384 | Engine emits full-scale noise after ~30–60 min in a long-lived tab (studio-core-wasm 0.0.13 / SDK 0.0.168) | bug | audio engine | not-planned | After 30 to 60 minutes in a long lived tab the engine outputs full scale noise until the page is reloaded. |
| 382 | License inconsistency: LGPL vs. AGPL; missing LICENSE file in repo | bug | docs | fixed | package.json, README and the repo disagree on the license and there is no LICENSE file. |
| 379 | MIDI note placement reads outputLatency once at record start and falls back to 10 seconds when it is absent | bug | recording | fixed | MIDI recording reads outputLatency once and falls back to 10 seconds. |
| 377 | DAW Mutes Itself | other | audio engine | invalid | Reporter says the DAW mutes itself when playback is stopped, with no reproduction steps. |
| 375 | Recording two armed captures at once panics BoxGraph.stageBox when both takes encode byte-identical audio | bug | recording | fixed | Two simultaneous captures can collide on the same AudioFileBox UUID, so one take never finalizes. |
| 374 | Recorded audio takes are placed 35-53 ms early on the timeline | bug | recording | fixed | Recorded takes land 35 to 53 ms ahead of the played position, measured at both sample rates and tempi. |
| 369 | Multi-select Notes Editing Bugs | bug | MIDI editor | fixed | Editing several selected notes jumps back to previous values. |
| 367 | Count-in leaks the punch-in downbeat click when the metronome is disabled (WASM engine regression vs TS) | bug | audio engine | fixed | An extra click plays at the punch-in downbeat during count-in with the metronome disabled. |
| 366 | VB virtual cable does not work with opendaw | bug | audio output | invalid | Audio drops after a few seconds when routed to VB virtual cable. |
| 363 | RecordAutomation's finalize-time simplifier flattens smooth gestures far beyond its ε (measured 19.8× ε) | bug | automation | fixed | The recorded automation simplifier removes far more detail than its tolerance implies. |
| 361 | sample browser enhancements | feature | sample browser | fixed | Sample browser needs drag and drop import and a way to add folders from empty space. |
| 359 | Eliminate last privacy concerns | question | privacy | unknown | The studio tracks users with a localStorage UUID, latency and error reports, which conflicts with a no tracking claim. |
| 357 | latency compensation for werkstatt effects | feature | Werkstatt | fixed | Werkstatt devices need a way to declare latency, for FFT effects. |
| 356 | hardware midioutput gets desynced all the time | bug | MIDI | fixed | Hardware MIDI output notes are delayed erratically, so fast patterns feel like they have a random groove. |
| 353 | allow werkstatt to have @sample inputs | feature | devices | fixed | Requests @sample inputs in Werkstatt, for example to build a convolution reverb. |
| 350 | Custom output route for Playfield's samples | feature | devices | fixed | Playfield samples need a selectable output bus. |
| 349 | Automation values not recorded if midi controller is used | bug | automation | fixed | Automation is not recorded when a parameter is moved by a MIDI controller. |
| 348 | Modulate Rate in Tidal with LFO Mod -> | bug | devices | fixed | Modulating the Tidal Rate with an LFO throws an error. |
| 347 | Automation should be temporary disabled when manually changing the value by pointer or MIDI-CC | feature | automation | fixed | Manually changing an automated control by pointer or MIDI CC should temporarily disable its automation while the transport runs. |
| 346 | Duplicating Effect (Crusher) causes exception | bug | devices | fixed | Duplicating a Crusher device in a given project throws an exception. |
| 343 | Cubed Enhanced Pattern Actions | feature | devices | fixed | Copy and duplicate patterns and steps in Cubed. |
| 342 | Midioutput / added channels have no label in the timeline view | bug | MIDI | fixed | Channels added to a MIDI Output have no label in the timeline. |
| 341 | Broken submenu access on iPad | bug | UI | fixed | Submenus cannot be selected by touch on iPad. |
| 340 | Canceling "Save" shows "Filepicker"-Error | bug | files | fixed | Cancelling a save dialog shows a file picker error. |
| 339 | Playfield - Edit Sample view - the waveform does not reload, if a new sample is dropped into the the view | bug | devices | fixed | The Playfield sample editor waveform stays empty after dropping a new sample. |
| 337 | Copied Clip from clip launcher changes to copy are not accepted sounds the same | bug | timeline | fixed | Edits to the notes of a copied clip launcher clip are ignored and the copy plays the original notes. |
| 336 | Project hangs when importing DawProjectFile and resizing Timeline | bug | DAWproject | fixed | Zooming out after a DAWproject import hangs the project. |
| 334 | Glide knob on Vapourisateur doesn't persist on all notes | bug | devices | fixed | Glide in Vaporisateur restarts from the wrong note. |
| 332 | AudioContentModifier: not-stretched to stretched conversion doesn't warp to the sample's own bpm | feature | audio regions | fixed | Converting a region to a stretched play mode should use the sample's own bpm. |
| 331 | Tree for instruments | feature | timeline | fixed | Allow collapsing the tracks of an instrument. |
| 330 | History panel | feature | UI | answered | Request for a history panel to go back in history. |
| 329 | Count measures from 0 | feature | timeline | fixed | Add an option to count bars from zero. |
| 328 | Add event.preventDefault when scrolling horizontally | bug | timeline | fixed | Horizontal scrolling over the timeline triggers browser history navigation in Edge. |
| 324 | Can't export, recover files or access to the project when there's an error | feature | engine | answered | After an error the reporter could not reach the project or export. |
| 323 | Playfield Slot should have a gain parameter | feature | devices | fixed | Playfield slots should have a gain parameter. |
| 320 | MIDI controller support | question | MIDI | answered | User asked how to use a MIDI keyboard. |
| 319 | hotkeys to change snapping | feature | UI | fixed | Hotkeys to change the snapping size for notes and clips. |
| 318 | Projects it can not be save | question | presets | answered | User wants audio effects kept for each new mix. |
| 317 | DEV / FX Composite / Exception if Chain element is deleted | bug | devices | fixed | Deleting an entry of an FX Composite chain throws an exception. |
| 316 | Feature request: expose engine preferences (metronome) on OfflineEngineRenderer | feature | SDK | fixed | Allow enabling the metronome in offline renders. |
| 315 | WasmEngine.ensureReady(context) registers the processor module only on the first context | bug | SDK | not-planned | ensureReady registers the worklet only for the first context, so a second context throws on engine construction. |
| 312 | PitchVoice multiplies its 20 ms voice fade-in by the region clip-fade gain, linear crossfades dip -1.2 dB on entry | bug | audio engine | fixed | Linear crossfades dip about 1.2 dB at the start because two fades multiply. |
| 311 | Sample-level discontinuity at touching region seams (off-boundary seams collapse to -9.7 dB) | bug | audio engine | fixed | Adjacent audio regions touching at an exact boundary do not play seamlessly. |
| 310 | README installation prerequisites missing Rust/wasm32 toolchain | docs | documentation | fixed | The README does not list the Rust wasm32 toolchain needed to build the WASM engine. |
| 309 | automation node creation + drag behaviour | bug | automation | fixed | Dragging a freshly created automation node snaps wrongly. |
| 306 | automation node undo bug | bug | automation | fixed | Placing multiple automation nodes at once and pressing Ctrl+Z undoes all of them together. |
| 305 | automating mute does not do anything | bug | automation | fixed | Automating a track's mute parameter has no effect. |
| 304 | Vocoder `band-count` valid values {8, 12, 16} are not introspectable — box schema advertises a plain 8..16 range | bug | SDK | fixed | The Vocoder band-count accepts only 8, 12 or 16 but the box schema advertises a plain 8 to 16 range, so SDK users cannot discover the rule. |
| 303 | Box schema constraints and adapter ValueMappings disagree (Maximizer threshold, Gate threshold/attack) | bug | devices | fixed | Box schema ranges differ from adapter value mappings for Maximizer threshold and Gate threshold and attack. |
| 302 | `VocoderTransform` draws the band-Q gradient inverted relative to `VocoderDsp` | bug | devices | fixed | The Vocoder editor draws the band Q gradient mirrored compared to the DSP. |
| 301 | bounce clips feature | feature | timeline | fixed | Bounce a clip to audio from its context menu. |
| 299 | draggable timeline tracks | feature | timeline | fixed | Move timeline tracks up and down by dragging. |
| 298 | midi editor improvements | feature | MIDI editor | fixed | Edit loop start, region bounds and note offset inside the MIDI editor. |
| 297 | automated parameters do not properly display their value | bug | UI | fixed | Automated Vaporisateur filter frequency showed 20 Hz and did not change during playback. |
| 296 | selecting anything and ctrl+z for dials causes audio dropouts | bug | audio engine | fixed | Adding to the selection or undoing dial changes causes audio dropouts. |
| 295 | audio clip utilities | feature | audio regions | duplicate | Request for audio clip utilities such as reverse, normalize, phase inversion, mono and trim. |
| 293 | audio input monitoring does not work | question | recording | answered | Audio input was not audible while monitored. |
| 292 | automation clip deletion bug | bug | automation | fixed | Deleting an automation region needs two clicks to get the right context. |
| 291 | visual bug with automation node curves | bug | automation | fixed | Automation curves render incorrectly at -100%. |
| 290 | Recording silently drops audio in hidden tabs: RingBuffer main-thread reader is timer-throttled while the ring holds only ~0.37s | bug | recording | fixed | Recording in a hidden tab silently drops audio because the ring buffer reader is timer throttled while the ring holds only about 0.37 seconds. |
| 289 | selecting a midi clip | other | UI | fixed | Selecting a MIDI clip should also select its track and switch the device panel to it. |
| 287 | dragging multiple clips over a single clip causes opendaw to crash | bug | timeline | fixed | Dragging several clips over one clip crashes the studio. |
| 286 | mixdown is not the correct length | bug | export | not-planned | Mixdown ignores the end marker. |
| 285 | more buttons to create audio busses | feature | mixer | not-planned | Request for easier add bus buttons in the timeline and mixer. |
| 276 | opendaw full data export | feature | project data | answered | Request to export and re-import all local projects and presets. |
| 275 | automation node placement behaviour | bug | automation | fixed | Follow up to #197: double clicking should place a new automation node on the grid, with cursor aware placement when nodes share the same time. |
| 274 | automation node placement bug | bug | automation | fixed | Automation nodes sometimes fail to snap to the grid. |
| 273 | Ctrl+D for audio effects | feature | devices | fixed | Requests Ctrl+D to duplicate effects in an effect chain. |
| 272 | up the contrast for the loop button | bug | UI | fixed | The loop button on and off states are hard to tell apart. |
| 271 | new automation clip default node | feature | automation | fixed | A new automation clip should start with a node inheriting the previous value. |
| 269 | playfield automating mute does not work | bug | devices | fixed | Automating the mute of a Playfield slot has no effect. |
| 268 | Audio hangs with this werkstatt script | bug | audio engine | not-planned | An FFT gate script in Werkstatt makes the engine hang and trip the circuit breaker. |
| 267 | not sure how to import presets | question | presets | answered | Imported preset bundle appeared to be missing. |
| 266 | Project cannot be loaded | bug | project loading | fixed | A project with digits as variable names could not be loaded. |
| 265 | Presets / Playfield / Save Playfield as Preset / Effect in Sample Slot not saved | bug | presets | fixed | Playfield presets lose the effects assigned to sample slots. |
| 264 | naming values in scriptable devices | bug | scripting | fixed | Numbers at the start of a parameter name break script devices. |
| 263 | Provide windows building instructions | docs | docs | answered | Build instructions assume Linux bash. |
| 262 | Audio (Video) Chat Extension | feature | live room | fixed | Add audio and video chat for faster collaboration. |
| 261 | WASM Audio Engine | feature | audio engine | fixed | Add a WebAssembly audio engine. |
| 260 | Implement custom scrollbars | feature | UI | fixed | Custom scrollbars to equalize the look across browsers. |
| 258 | Implement AudioPlaybackStats | feature | audio engine | fixed | Use the AudioPlaybackStats web API for underrun detection. |
| 257 | Could not load project | bug | projects | fixed | One project fails to open with "Cannot read properties of undefined (reading 'subscribeFloat')" and the user has no backup. |
| 256 | Update Neural Amp Modeler (NAM) to Architecture 2 (A2) | feature | devices | fixed | Update the Neural Amp Modeler device to NAM Architecture 2 (A2). |
| 254 | request for extension of olderTakeScope in loop recordings | feature | recording | fixed | Add a none option to olderTakeScope so loop recording does not mute earlier takes. |
| 253 | Project Metadata should be shared across live-rooms | feature | live room | fixed | Share project metadata with all users in a live room. |
| 252 | Loop Recording broken when starting to record from anywhere in the middle of the Loop Area | bug | recording | fixed | Loop recording breaks when starting from the middle of the loop area. |
| 251 | bug: Waveform Offset values are incorrect for subsequent Takes created in Loop recording | bug | recording | fixed | Waveform offsets of later takes are wrong when loop recording. |
| 250 | Lane normalization | feature | timeline | fixed | Requests a lane normalization that moves regions of an audio unit to higher free tracks and removes empty tracks (proposed compactTracks method). |
| 247 | Export API | feature | SDK | not-planned | Request for an SDK API to export mixdown, stems and DAWproject. |
| 246 | Incorrect script editing visuals in studio | bug | scripting | fixed | The script code editor did not show the full script. |
| 244 | Quantize Notes API request | feature | SDK | fixed | Quantize API that accepts selected notes and a global grid offset. |
| 243 | Make the manual accessible outside desktop computers | feature | docs | fixed | Provide the manuals in the same style without booting the whole studio. |
| 238 | ts | other | other | invalid | Empty issue with no content. |
| 237 | FWWM | other | other | invalid | Issue with title FWWM and an empty body. |
| 236 | Load only the first model when selecting a pack from TONE3000 | other | devices | fixed | Selecting a TONE3000 pack loads up to 80MB, so only the selected model should be loaded dynamically. |
| 235 | Enable History in Live-Room | feature | live room | fixed | Enable undo history in the live room. |
| 234 | Evaluate WebClap | feature | devices | fixed | Evaluate WebCLAP support. |
| 232 | Random bug in the middle of multiplayer mode | bug | live room | fixed | An error dialog appeared during a multiplayer session. |
| 231 | Can't delete device during playback | bug | devices | fixed | Deleting a device while the track plays throws an error. |
| 230 | Independent Input Monitoring Controls | feature | audio engine | fixed | Requests independent input monitoring for armed tracks, with own volume, pan, mute and optional output device routing, separate from the recorded signal. |
| 229 | Create random room names | feature | live room | fixed | Generate random room names to quickly set up a private space. |
| 228 | Software MIDI Keyboard bugs | bug | MIDI | fixed | Software keyboard inputs turn into NaN on empty input and reject numpad values. |
| 227 | "Reset Value" on Apparat/Werkstatt parameter always sets the value to minimum. | bug | scripting | fixed | Reset Value on Apparat or Werkstatt parameters sets the minimum instead of the default. |
| 226 | Lightweight Presets | feature | devices | not-planned | Proposal for a simple JSON format to share device parameters. |
| 225 | Cut and Paste of Clipboard data in Werkstatt doesnt work in Chrome / DEV | bug | devices | fixed | Pasting a script into Werkstatt and Run clipboard do not work in Chrome on the DEV channel. |
| 224 | Automation recording doesnt work for Apparat and Werkstatt Device | bug | automation | fixed | Automation is not recorded for parameters of scripted devices. |
| 220 | MIDI keyboard window: more immediate access to octave setting | feature | MIDI | fixed | Octave setting in the MIDI keyboard window is tedious to change and the number input keeps keyboard focus. |
| 219 | undo redo buttons | feature | UI | answered | Request for undo and redo buttons. |
| 216 | Limit Apparat/Werkstatt/Spielwerk parameter namelength | bug | devices | fixed | Long parameter names break the layout of scripted devices. |
| 215 | Capture MIDI at play phase | feature | MIDI | fixed | Silently record incoming notes on armed tracks and turn them into a region on demand. |
| 214 | The note-editor softwarekeyboard keeps the initial instrument targeted when the selected clip is moved | bug | MIDI editor | fixed | The software keyboard plays the instrument of the clip's original row after the clip is moved. |
| 213 | Minor Note Editor improvements | feature | note editor | fixed | Small View menu improvements in the note editor. |
| 212 | Automationtrack automatic naming | feature | automation | fixed | Name automation tracks after the automated parameter. |
| 211 | request - sidechain input for Werkstatt | feature | devices | fixed | Request for a sidechain input on Werkstatt, for example for vocoders. |
| 210 | DEV / Deleting moved second instance of Werkstatt causes Exception | bug | devices | fixed | Deleting a second Werkstatt moved in front of the first throws an exception. |
| 208 | automation node undo bug | bug | editing | fixed | Creating an automation node needed Ctrl+Z twice to undo, with similar double undo for notes and clips. |
| 207 | Scriptable devices: custom inputs | feature | devices | fixed | Request for more input types in scriptable devices such as XY graph, pulse button and subdivision dial. |
| 206 | One to many note generation in Spielwerk leads to not all midi notes being released | bug | MIDI | fixed | Notes generated one to many in the MIDI Effect Builder do not all release when the source note ends. |
| 205 | Werkstatt and Spielwerk - Quick access to code snippets from context menu | feature | devices | fixed | Offer built-in example snippets in the context menu of code devices. |
| 204 | Spielwerk does not seem to release midi notes correctly | bug | devices | fixed | A note triggered from the on-screen keyboard through a Spielwerk script never releases until Stop is pressed. |
| 198 | How to create multiple signature events in a single modification? or there is a bug | question | SDK | answered | Creating several signature events in one modification shows a stale adapter size. |
| 197 | automation node placement bug | bug | automation | fixed | Double clicking to create a new automation node places it at an unexpected position in some cases. |
| 196 | vaporisatuer redesign | feature | devices | fixed | Vaporisateur UI needs visual grouping of values. |
| 195 | chorus effect | feature | devices | answered | Request for a chorus effect with 2 to 8 voices. |
| 194 | flanger | feature | devices | answered | Request for a flanger device. |
| 193 | frozen audio is not time-stretched when changing project tempo | bug | audio engine | fixed | Frozen audio units go out of sync after a project tempo change. |
| 192 | waveshaper | feature | devices | fixed | Request for a waveshaper device with selectable shapes and pre gain, post gain and mix. |
| 191 | Moving any region causes "queueMicrotask is not defined" | bug | timeline | fixed | Moving a note region throws queueMicrotask is not defined when the code runs in a worker. |
| 190 | MusicalUnitDisplay still shows the position in 4/4 after changing the signature to 6/8 | bug | UI | fixed | The musical position display ignored time signature changes. |
| 189 | When starting (or ending) recording, remove all other clips from selection. | feature | recording | fixed | Starting a recording should deselect all other clips. |
| 187 | delay feedback | bug | devices | fixed | Delay with feedback at 0 produces no wet signal. |
| 184 | RegionDurationModifier taken from wrong clip | bug | timeline | fixed | Region duration modifier uses the wrong clip. |
| 183 | CTRL+R should restart recording from where play head was positioned on start of initial recording | feature | recording | fixed | Restart recording should return to the original start position, not bar 1. |
| 180 | timeline: inserting notes while snap is off soft-crashes | bug | timeline | fixed | Inserting very small notes with snap off crashes the app. |
| 179 | DEV / Neural Amp / mutes audio if mono is deselected | bug | devices | not-planned | Neural Amp mutes audio when mono is switched off. |
| 178 | DEV / Neural Amp audio processing deactivated if project is loaded | bug | devices | fixed | Neural Amp stops processing after a saved project is reloaded. |
| 177 | Add Inverse and Reverse for automation | feature | automation | fixed | Add Inverse (value domain) and Reverse (time domain) operations for automation. |
| 176 | Allow capture audio monitoring to pass the audio-effect chain | feature | audio engine | fixed | Allow capture audio monitoring to run through the audio unit's effect chain instead of going straight to the AudioContext destination. |
| 175 | Overlapping Clip Regions | bug | timeline | fixed | Dragging a region edge over a neighbor creates overlapping regions. |
| 174 | Can we get Playfield like controls over the sample for the Tape Device? | feature | devices | not-planned | Requests Playfield style Start and End controls and mono/poly voice cutting for the Tape device to slice and reverse samples. |
| 173 | Tape Device - Waveform Offset cannot be set with Numbers from Numpad | bug | devices | fixed | Numpad numbers do not work in the Tape waveform offset field. |
| 172 | Automation of Zeitgeist parameters doesnt work | bug | devices | not-planned | Automation curves on Zeitgeist parameters are ignored. |
| 171 | Cutting any imported mp3 sample results in an empty right side | bug | sample editor | fixed | Cutting an imported mp3 leaves the right side empty and double clicking it crashes. |
| 169 | Add VaryingTempoMap Cache | other | audio engine | fixed | Cache absolute times at tempo automation events to speed up time conversion. |
| 168 | personal template | feature | UI | fixed | Requests a personal default template to load for new projects. |
| 167 | transient editor cursor rendering erratically | bug | audio editor | fixed | The playback cursor in the transient editor looked jumpy when the mouse moved over the warp markers bar while paused. |
| 166 | default presets | feature | devices | fixed | Let users set their own default preset per device. |
| 165 | opendaw sometimes gets hung trying to load a project | bug | project loading | answered | The studio sometimes hangs while loading a project and works after waiting. |
| 164 | shortcut to horizontally scroll in timeline/note views | feature | timeline | fixed | Add Alt plus mouse wheel to scroll horizontally. |
| 163 | selecting a track scrolls for me | bug | timeline | fixed | Selecting a track scrolls the timeline so the track sits at the top. |
| 162 | consolidate audio clips | feature | timeline | fixed | Requests consolidating audio clips into a single clip. |
| 161 | gate audio effect | feature | devices | fixed | Request for a gate effect with attack, hold and release. |
| 160 | enabling triplets in notegrid still shows normal grid | bug | piano roll | fixed | Enabling triplet snapping such as 1/8T does not change the displayed note grid, although drawing snaps correctly. |
| 159 | context menu for adding audio effects should have icons included | feature | UI | fixed | Show icons in the context menu for adding audio effects. |
| 158 | sample searchbar does not have proper focus | bug | UI | fixed | Clearing the sample search bar prompts to delete a sample. |
| 157 | holding arrow keys should continue moving notes | other | piano roll | fixed | Holding an arrow key should keep moving selected notes. |
| 156 | Automation region editor / copying automation curve nodes throws exception | bug | automation | fixed | Copying automation nodes past the loop range throws an exception. |
| 155 | .dawproject missing info about multi TimeSignature and temp | bug | DAWproject | fixed | Signature and tempo tracks were empty after a DAWproject export and import round trip. |
| 154 | automation generation | feature | automation | answered | Request for generated automation such as LFO shapes with min, max, shape and quantization. |
| 153 | delay time is not saved correctly | bug | devices | fixed | Delay times changed after reloading a project. |
| 152 | playfield automation tracks should include the sample name | feature | UI | fixed | Playfield automation tracks need the sample name in their label. |
| 151 | deleting an instrument track does not delete its child tracks | bug | timeline | fixed | Deleting a note track leaves the device and its automation tracks in place. |
| 150 | compressor visual display bug | bug | devices | fixed | The compressor's visual compression indicators do not react to changes of the release time while the DSP does. |
| 148 | Video export of shaders with fast moving shapes produce loss in quality if export length is about 6s | bug | video export | fixed | Shader video export loses quality for fast moving shapes. |
| 147 | AudioData is not exposed to scripting engine | bug | scripting | fixed | AudioData was missing from the scripting engine. |
| 146 | Replace FFMpeg with mediabunny | other | audio import and export | not-planned | Proposal to use mediabunny instead of FFMpeg for decoding and encoding. |
| 145 | Scrollbar in Projectbrowser hides trash icons | bug | UI | fixed | On Firefox for Windows the scrollbar covers the delete icons in the project list. |
| 144 | DEV / Selecting "stretch" after recording an audio track throws exception | bug | recording | fixed | Choosing Timestretch on a freshly recorded region throws an exception. |
| 141 | Request - Instrument/FX Layer device | feature | devices | fixed | Request for a layering device like Ableton racks or Bitwig layers. |
| 140 | Shortcuts must be layout aware (QWERTY vs. QWERTZ) | bug | UI | fixed | Z and Y shortcuts are wrong on QWERTZ keyboards. |
| 138 | Request - FM (PM) Style Synthesizer | feature | devices | fixed | Requests an FM or PM style synthesizer with Operator style UI and Sytrus style routing. |
| 137 | Preference: Pause On Loop Disabled | other | preferences | fixed | Move the pause on loop disabled feature to engine preferences. |
| 136 | Preference: Truncate note playback for notes that outlive their region. | feature | preferences | fixed | Add a preference to stop notes that extend past their region or clip. |
| 135 | Clipboard: Copy and paste | feature | editing | fixed | Add a clipboard to copy selected content and paste it to a valid target. |
| 134 | Asset storages need to be attachable | other | SDK | fixed | Asset storage management must be replaceable for the SDK. |
| 133 | allpass filter | feature | devices | answered | Request for an allpass filter effect with frequency, amount and intensity. |
| 129 | Ctrl-Z not working | bug | editing | fixed | Undo after pasting notes shows an error. |
| 127 | Jump to cursor when turning on follow mode | bug | timeline | fixed | Turning on follow mode should scroll the view to the playhead. |
| 126 | Playfield Device Sample View: label breaks on minimise | bug | devices | fixed | The sample label in the Playfield sample view breaks when minimised. |
| 125 | Offline audio-engine renderer in worker | other | audio engine | fixed | Replace OfflineAudioContext with an audio engine rendering in a worker. |
| 124 | Implement audio-engine preferences | other | audio engine | fixed | Add synchronized audio-engine preferences to replace many separate engine protocol calls. |
| 123 | Shortcut-Links / Kerning too wide in Firefox | bug | UI | fixed | The greyed shortcut text in dropdown menus has too wide kerning in Firefox compared with Chrome. |
| 122 | Implement Mid-Point handler for value automation | feature | automation | fixed | Add a mid-point handle to automation segments for precise curve adjustment. |
| 121 | Follow Playback Cursor should not trigger when resizing regions | bug | timeline | fixed | Follow playback cursor interferes while regions are being resized. |
| 120 | Add a quick switch to en-/disable effects | feature | devices | fixed | Request for a bypass switch in each effect title bar. |
| 119 | Adding busses as tracks results in UX inconvenience with the track-solo-function | bug | mixer | fixed | Soloing a track that sends to a bus track results in no output. |
| 118 | Drag & Drop BPM may result in fractional values | bug | transport | fixed | Dragging the BPM produces fractional values like 85.83 while showing 86. |
| 117 | recording pre-capture | feature | recording | fixed | Record audio during the count-in so the start of a take is not clipped. |
| 116 | Stereotool should have an option to choose different panning behaviours | feature | devices | invalid | Stereo Tool panning mode choice between power mixing and linear. |
| 115 | [SDK] Expose audio stream while recording to a custom acceptor | feature | SDK | not-planned | Expose the audio stream during recording to a custom acceptor. |
| 114 | Allow transients to be moved, added, deleted | feature | audio regions | fixed | Make detected transient markers editable. |
| 113 | Signature Track | feature | timeline | fixed | Add a signature track to change the time signature at points in the timeline. |
| 112 | Enhance Metronome | feature | audio engine | fixed | Enhance the metronome with sub-divisions, custom click sounds and volume. |
| 111 | Tempo Automation | feature | timeline | fixed | Add tempo automation on the tempo track using parameter automation editing. |
| 110 | Volume automation on regions (fade-in/fade-out) | feature | timeline | fixed | Audio regions get editable fade-in and fade-out. |
| 109 | Waveform is not rendering while recording audio | bug | recording | fixed | Waveform did not render during audio recording. |
| 108 | make "Devices" panel collapse-able | feature | UI | answered | Request to collapse the Devices panel to enlarge the editor. |
| 107 | Add a vertical line previewing the insert position of the to be created warp-marker | feature | timeline | fixed | Requests a 1 pixel vertical line at the cursor that previews where a warp marker will be inserted, respecting snapping. |
| 106 | Warp-markers are still snapping to transients in Pitch Stretch mode | bug | audio regions | fixed | Warp markers snap to transients in Pitch Stretch mode where they should not. |
| 105 | Introduce modifier key to temporarily disable snapping when moving warp-markers | feature | timeline | fixed | Add a modifier key that disables snapping while moving warp markers. |
| 104 | Transient Detection is inaccurate for recorded samples | bug | audio | fixed | Transient detection gives inaccurate results for recorded samples. |
| 101 | Add audio input monitoring | feature | recording | fixed | Add monitoring of audio input. |
| 100 | Record Automation | feature | automation | fixed | Record Automation is missing. |
| 99 | Audition notes while drawing. | feature | piano roll | fixed | Requests auditioning notes while drawing them, not only when dragging existing notes (related to #61). |
| 98 | Assigning MIDI controllers must be persistent | bug | MIDI | fixed | Learned MIDI controller assignments must be stored in the project. |
| 97 | Shadertoy runner needs to share a single control state | bug | devices | fixed | The Shadertoy runner loses MIDI control values when switched, returning zeros, because state is not shared between runners. |
| 96 | Request / Sample browser / using "create audio tracks" uses the sample name as label | feature | sample browser | fixed | Tracks created from samples should be labelled with the sample name. |
| 95 | Tape / Sample Editor / Adjusting the sample loop length handle causes glitches | bug | sample editor | fixed | Dragging the loop end handle in the sample editor causes audio glitches. |
| 93 | DEV / Shader toy / ResizeObserver loop completed - Exception is thrown if shader editor popup window is moved, scaled and closed | bug | shader | not-planned | Popping out the Shadertoy editor and moving, maximizing and closing the window throws a ResizeObserver error. |
| 91 | Request - Stereo Tool / DC remove button | feature | devices | answered | Requests a DC remove button on the Stereo Tool to clean up mixes with DC offset. |
| 89 | Idea: Multitarget midi/automation | feature | automation | answered | Idea to let one clip play several instruments or automate several values. |
| 88 | shift + click should only deselect on mouseup and if the mouse wasn't moved | feature | note editor | fixed | Shift click should deselect a note only on release and only if the mouse did not move. |
| 87 | allow "," (comma) for decimal values | feature | UI | fixed | Requests allowing a comma as decimal separator in numeric inputs for non-English numpads. |
| 86 | enable modifying values per mousewheel | feature | UI | fixed | Allow value fields to be changed with the mouse wheel. |
| 85 | Enhance Nano sampler with Playfield feature | feature | devices | fixed | Nano sampler gets Playfield style features, shown in a mockup. |
| 83 | Drop "Leave site" warning, if the project is actually saved | bug | project | fixed | The browser still asks to confirm leaving the site after the project was saved. |
| 82 | Selection should be local | bug | UI | fixed | Selections were global per type instead of local to their region. |
| 81 | Pointer exception when soloing a track | bug | audio engine | fixed | Soloing a specific track throws a pointer exception. |
| 80 | MIDI recording does not incorporate output latency correctly | bug | MIDI | unknown | MIDI recording timing seems off with respect to output latency. |
| 79 | Clipping sound when lookahead of compressor are switched on/off | bug | devices | fixed | Toggling compressor lookahead or AutoMakeUp causes a clipping sound. |
| 78 | Compressor causes clipping | bug | devices | fixed | The Compressor clips when a loop restarts, with Lookahead enabled. |
| 77 | Dragging a Sample from the Browser across the timeline to the clip launcher causes an exception | bug | UI | fixed | Dragging a sample from the browser over the timeline and back to the clip launcher throws an exception on drop. |
| 76 | Midi Output Error after stop button was pressed | bug | MIDI | fixed | Playing again after pressing Stop throws an error with MIDI output via loopMIDI. |
| 75 | Clipping sounds when playing project | bug | audio engine | fixed | A specific project clips when stepping through scenes in the clip launcher. |
| 74 | Timeline: Snap Off allows clips to resize to unusably small lengths | bug | timeline | fixed | With snap off, clips can be resized to tiny lengths. |
| 73 | Mousewheel zoom-in bug | bug | UI | fixed | Scroll wheel zoom jumps to maximum zoom on Windows with multiple-lines wheel setting. |
| 72 | Crusher: crush parameter at 0% should not crush at all | bug | devices | fixed | The Crusher still downsamples at 0% crush rate. |
| 71 | Add Dattorro Reverb | feature | devices | fixed | Requests adding a Dattorro reverb device based on DattorroReverbNode. |
| 70 | Enhance delay device | feature | devices | fixed | Delay gets independent left and right pre-delays and an absolute delay time. |
| 69 | Add Sidechaining | feature | audio engine | fixed | Introduce sidechaining to the audio graph and the Compressor. |
| 68 | Enhanced automation event handling | feature | automation | fixed | Improve automation editing: click and drag creates and moves an event, and a modifier turns off time snapping. |
| 67 | Select region after recording | feature | recording | fixed | Recorded regions should be selected automatically after recording for quick deletion. |
| 66 | Softclipper audio effect | feature | devices | duplicate | Add a soft clipper effect device based on tanh(x * drive). |
| 65 | Recording Retry | feature | recording | fixed | Add a way and shortcut to restart a running recording. |
| 64 | Allow drop new instruments anywhere on the timeline | feature | timeline | fixed | New instruments should be droppable anywhere on the timeline, not only on lanes. |
| 63 | harmonic scale bug | bug | MIDI editor | fixed | The harmonic scale vision aid resets when a new clip is opened. |
| 62 | Crusher deactivates signal if project is saved or stopped | bug | devices | fixed | After stopping or saving, the signal stops after a Crusher until the crush knob is touched. |
| 61 | Audition notes while dragging | feature | MIDI editor | fixed | Notes in clips should sound when moved up or down with arrow keys or mouse. |
| 60 | crusher bug | bug | devices | fixed | Setting the Crusher to 0% crushing lets DC build up and mutes the audio. |
| 59 | "stop" button bug | bug | transport | duplicate | Pressing stop silences audio tracks until reload. |
| 58 | Note drawing tool upgrade | feature | MIDI editor | fixed | Improve the note drawing tool with remembered velocity and length, a ghost note and sound. |
| 56 | shortcut to duplicate a track | feature | timeline | fixed | Request for a keyboard shortcut to duplicate a track. |
| 55 | cannot move any tracks | bug | timeline | fixed | Tracks cannot be moved by dragging and the right click move menu entries are greyed out, so audio tracks cannot be reordered. |
| 54 | project end marker input field | bug | timeline | fixed | Entering 41 in the project end marker field places the marker at bar 42 instead of 41. |
| 53 | Cancel button for render screen | feature | export | fixed | Request for a way to cancel a running mixdown render. |
| 52 | Saving preset and loading it back using Load deprecated preset throws SyntaxError | bug | presets | answered | Loading a freshly saved Playfield preset via Load deprecated preset throws a SyntaxError. |
| 51 | Instrument browser list cannot be scrolled if list exceeds screen (e.g. if zoomed in) | bug | UI | fixed | The instrument and device browser cannot scroll when the list is taller than the screen. |
| 49 | vaporisateur bug | bug | devices | fixed | Dragging a Vaporisateur value while holding Shift throws an error. |
| 47 | Audio-Engine Error is thrown if project using Tidal is played at a certain position | bug | audio engine | fixed | Starting playback from a certain position in a project with Tidal automation throws an engine error. |
| 46 | Using OpenDAW MIDI-OUT device with Start/Stop signal and clock signal confuses Bitwig | bug | MIDI | invalid | MIDI clock from the MIDI Output device with transport on confuses Bitwig via loopMIDI. |
| 45 | Search bar for projects on startup screen | feature | UI | fixed | Requests a search bar for projects on the startup screen because the project list gets long. |
| 44 | Filter FX/EQ | feature | devices | answered | Request for a filter or EQ effect. |
| 43 | Duplicate tracks | feature | timeline | fixed | Request to duplicate a track with its clips, effects and automation. |
| 42 | Set polyphony limit per instrument | feature | devices | fixed | Request for a per-instrument polyphony limit, mono mode, legato and portamento. |
| 40 | Issue - OpenDAW doesnt send MIDI-Out if track marker is not set on first track | bug | MIDI | fixed | MIDI output to Bitwig is not sent when the track marker is not set on the first track. |
| 39 | MIDI - Send MIDI transport messages (start/stop) | feature | MIDI | fixed | Request to send MIDI Start, Stop and Continue to external devices from the MIDI Output device. |
| 37 | Feature request - MIDI Effect - Velocity | feature | MIDI effects | fixed | Request for a MIDI effect that modifies note velocity globally. |
| 36 | Rename MIDIOutput "CV" to "CC" | other | devices | fixed | Requests renaming the MIDI Output "CV" label to "CC" to mean MIDI Continuous Controller. |
| 35 | Replacing Instrument using Drag and Drop from Instrument menu throws "as defined failed" error | bug | devices | fixed | Dropping Soundfont or MIDI Output onto an existing Vaporisateur throws an error. |
| 34 | Compressor - Compressor Dot visualization does not account for Input Gain (in-device) | bug | devices | fixed | The compressor dot visualization ignores the device's Input Gain value. |
| 33 | Fold device - creates buzzing noise (not distortion) if automation is created for "Drive" or "Volume" | bug | devices | fixed | The Fold device buzzes during playback when Drive or Volume is automated. |
| 31 | Feature Request: MIDI Only track / MIDI Output | feature | MIDI | fixed | Request to send MIDI notes and CC from openDAW to external hardware via a MIDI Output. |
| 30 | Feature Request: Add Direct MP3 Export Option | feature | export | fixed | Request for direct MP3 export instead of WAV only. |
| 29 | Region Resize Tool Behaviour | bug | timeline | fixed | Three small region drag and resize behaviours: copy over a clip, resize over a clip, resizing a looping clip. |
| 28 | Project crashes if Crusher device is used and the crush knob is changed below 51% | bug | devices | fixed | Turning the Crusher crush knob below about 50% causes a noise bleep and an exception. |
| 27 | Dangerous Noise bursts if Vaporisateuer parameters are set to max and then reset via STRG+Z (Undo) | bug | devices | fixed | Changing Vaporisateur release to max and then undoing produces dangerously loud noise bursts. |
| 26 | Target consolidate exception if two clips are marked and consolidate is selected | bug | timeline | fixed | Consolidating two selected clips, the second a copy of the first, throws a target consolidate exception and crashes the project. |
| 25 | Import of DAWProject file causes exception - Undefined cannot be found | bug | DAWproject | fixed | Importing a specific DAWproject file with instruments and effects throws an exception. |
| 24 | OpenDAW crashes when opening a specific project | bug | devices | fixed | A project crashes on load because a Revamp low-pass order is out of bounds. |
| 22 | Importing DAW-Files with too large clips wont be audible in OpenDAW | bug | DAWproject import | fixed | Imported DAWproject files with long regions play visually but make no sound. |
| 21 | Drag and Drop of Samples (cloud) to Timeline can cause empty files with exception after delete | bug | timeline | fixed | Dropping cloud samples repeatedly on the same timeline position creates a No Audio File region that throws when deleted. |
| 18 | [SAFARI] Software MIDI Keyboard fallback not working without Web MIDI API or hardware device | bug | MIDI | fixed | The software MIDI keyboard does not activate as fallback in Safari. |
| 17 | Key still pressed error if window/tab is switched while keys are hold | bug | MIDI | fixed | A key still pressed exception is thrown when the tab is switched while keys of the visual keyboard are held. |
| 16 | Modification only prohibited in transaction mode - appears if audio is recorded and stopped | bug | recording | fixed | Stopping a microphone recording on a tape track throws a transaction mode error. |
| 15 | unwrap failed | bug | automation | fixed | Deleting an automation point with the Del key while dragging crashes with unwrap failed. |
| 12 | Whether Chinese interface support and touchscreen support can be added depends on the specific device. | question | UI | answered | Asks whether Chinese interface and touchscreen support, Docker support and a VST-like web plugin system could be added. |
| 8 | Opening graph and first project in list causes offset is outside the bounds of the DataView error | bug | project loading | fixed | Loading one specific project after opening Graph throws a DataView offset error. |
| 7 | Consider AGPL instead of GPL | other | licensing | fixed | Asks to switch the license from GPL to AGPL so network use also requires source release. |
| 6 | Modular Skins | feature | UI | not-planned | Request for swappable GUI components so users can apply alternative skins. |
| 5 | Menus are hard to click (and hello!) | feature | UI | fixed | A menu button has a click area that feels too small. |
| 2 | Couple of issues with building and running studio | bug | build | fixed | Build scripts used a wrong path and build-info.json was not generated. |
| 1 | Thank you for open sourcing this! | other | community | answered | Thanks message that mentions the roadmap on Trello. |
