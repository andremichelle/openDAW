# DAWproject overhaul

Spec: [bitwig/dawproject](https://github.com/bitwig/dawproject), format 1.0 (stable). Last schema change 2024-09-02: `enable` on clips and sends. Project.xsd and MetaData.xsd are the source of truth.

Goals

1. An openDAW export imports into openDAW as the same project.
2. Exports are verified against Bitwig, automated where possible.
3. lib-xml rewritten, correct and consistent.

## Review findings

### lib-xml (packages/lib/xml/src/index.ts)

1. Element order follows the key order of the object literal passed to `Xml.element`, not the schema. xs:sequence violations follow (xmllint: `Pan` not expected inside `Channel`).
2. `collectMeta` walks child to parent and the parent overwrites the child, so subclass field overrides are lost.
3. `@Xml.Attribute` without a validator parses to a raw string (`Point.time` is a string at runtime and only works through implicit coercion).
4. Booleans: `"1"` / `"0"` (valid xs:boolean) parse as false. Numbers: `NumberOptional` turns `""` into 0 and garbage into NaN silently. `Infinity` serializes as `Infinity` (xs:double wants `INF`).
5. ElementRef with a name guesses between "direct list" and "wrapper" by checking whether the first child has children. A `Note` with per-note expression children flips it into the wrapper branch and reads garbage.
6. Polymorphic lists filter by `prototype instanceof`, so `RealParameter` inside `<Parameters>` is dropped (it does not extend `ParameterSchema`).
7. One global tag to class registry. Tag names double as type identity (`TimeSignature` is registered for the parameter class while the spec tag in lists is `TimeSignatureParameter`).
8. `DOMParser` errors are not detected (a `<parsererror>` document parses as an empty project). Parsing and writing need a DOM, so nothing runs in a worker or plain node without jsdom.
9. `pretty` is regex based. No XML declaration is written.
10. Unknown elements are silently skipped (`console.warn` only), so nothing reports what an import lost.

### lib-dawproject (packages/lib/dawproject/src/defaults.ts)

1. Missing types: `BoolParameter` (we register `BooleanParameter`), `IntegerParameter`, `EnumParameter`, `TimeSignatureParameter`, `EnumPoint`, `Vst2Plugin`, `Vst3Plugin`, `AuPlugin`, `Compressor`, `Limiter`, `NoiseGate`, per-note expression timelines inside `Note`.
2. `MarkersSchema` expects a `<Marker>` wrapper, while the spec lists `Marker` directly. `ArrangementSchema.markers` is typed as `MarkerSchema`.
3. `VideoSchema` carries audio attributes. `Nameable` attributes (`name`, `color`, `comment`) are missing on most referenceables. `Track.comment` is missing.
4. `DeviceRole.ANALYZER` and `contentType` values are not modelled as enums.

### Exporter (studio/core/src/dawproject/DawProjectExporter.ts)

1. Duplicate ids: the Channel id and the instrument device id are both made from the input box address (XSD: `id3 is not a valid xs:ID`).
2. `contentType` is only known for Tape, Vaporisateur, Nano and Playfield. The other 12 instruments (Wclap, Soundfont, Surgeon, Sampler, ...) export without it and the importer panics on them.
3. A group bus exports as role `master` (should be `submix`).
4. One `<Clips>` element per region. The importer makes one track per `<Clips>`, so a round trip turns N regions into N tracks.
5. `loopOffset` is lost (`playStart` is always 0). Audio fades, waveform offset, warp markers and time-stretch mode are lost (two fixed warps only).
6. Value regions export as empty clips. Track automation lanes are not exported at all.
7. Note `rel` is written as the velocity.
8. Sends, channel mute, solo, markers, key/chord tracks are not exported.
9. Samples are stored as `samples/{fileName}.wav`, so two samples with the same name collide.
10. WebCLAP exports as `BuiltinDevice` instead of `ClapPlugin` (#563).
11. Colours read CSS variables (needs a DOM). Application version is hardcoded `0.1`.

### Importer (studio/core/src/dawproject/DawProjectImporter.ts)

1. Restoring openDAW devices from `State` is commented out ("invalid host pointer"). Every openDAW instrument becomes Vaporisateur or Tape, every effect becomes an Unknown device. This is the main blocker for goal 1.
2. Roles `submix` and `vca` panic. Nested tracks are only read under `master`.
3. Automation lanes (`Points` with a `Target`) are ignored, both in track lanes and inside clips.
4. Nested clips read only the first inner clip and drop its time offset.
5. Audio reads only the first and last warp, ignores `contentTimeUnit="seconds"`, fades and `loopStart`, and panics on external files.
6. Parameter units are ignored (send and channel volume/pan assume linear/normalized).
7. Markers and scenes are ignored.

### Tests

1. 13 tests, no round trip, no schema validation. Bitwig fixtures in test-files all validate against the XSD, the openDAW export from #563 does not.

## Plan

### ~~Phase 0: Test harness first~~

1. XSD validation helper for tests with the system `xmllint --schema` (ships with macOS and ubuntu-latest, no new dependency), XSDs vendored into lib/dawproject/xsd. A missing `xmllint` fails the test.
2. Round-trip test: load a project, export, import, compare the box graphs structurally (UUID independent canonical form).
3. The test-files projects (migrated as the studio loads them) plus one built project holding every feature: groups, aux, sends, mirrored regions, cents, markers, signature and tempo changes, automation of devices, mixer and WebCLAP parameters, scenes on several tracks, seconds and warped audio, mastering.
4. Bitwig fixtures parse and re-serialize to equivalent XML.

### ~~Phase 1: lib-xml rewrite~~

1. Schema-ordered serialization from declaration order, parent fields first.
2. Typed attribute codecs (string, int, double with xs:double formatting, xs:boolean, enum) with required and optional variants. No untyped attributes.
3. Explicit child declarations: single element, wrapped list, unwrapped list, polymorphic choice with an explicit tag to class table per field. No heuristics, no global registry.
4. Own small parser and writer (no DOM), runs in browser, worker and node. Export and import (zip included) can then run in a worker. Parser errors fail loudly. XML declaration, deterministic indentation, proper escaping.
5. Parse report: unknown elements and attributes collected and returned, so the importer can say what was dropped.

### ~~Phase 2: lib-dawproject schema~~

1. Schema classes generated from Project.xsd and MetaData.xsd by a script, enums for every xs enumeration.
2. A test regenerates and compares, `UPDATE_SCHEMA=1` writes the file (xsd/README.md).

### ~~Phase 3: Exporter~~

1. Unique ids, one `<Clips>` per track lane, `contentType` from the track types of the unit (no instrument list), roles fixed.
2. Clip timing: `playStart`, loop, fades, mute, audio warps from warp markers, `contentTimeUnit` from the time base.
3. Automation lanes and value regions as `Points` targeting exported parameter ids. Sends, mute, solo, markers.
4. WebCLAP as `ClapPlugin` with a Bitwig-compatible `.clap-preset` state (`clap` + length + plugin id + raw state) and automated parameters with CLAP parameter ids (#563).
5. Samples by UUID path. No DOM access: track colours come from the colour constants themselves (hsl), no duplicated table was needed.
6. Key and chord tracks and grooves are dropped (no place in the spec). Proposal filed: [bitwig/dawproject#107](https://github.com/bitwig/dawproject/issues/107).

### ~~Phase 4: Importer~~

1. `DeviceState` replaces `DeviceIO`: device plus dependencies, uuids kept, host and root pointers re-anchored. Old exports (`openDAW:device` v1) restore too.
2. All channel roles, nested tracks at every level.
3. Automation lanes and clip automation, nested clips with offsets, all warps, seconds content, fades, units.
4. `ClapPlugin` with a known plugin id loads the matching WebCLAP with its state (#563).
5. Markers. Scenes and ClipSlots into openDAW clips (NoteClipBox, AudioClipBox, ValueClipBox), exported back as Scenes.
6. Import report dialog listing what could not be mapped.

### Phase 5: Bitwig verification

1. Automated, CI: XSD validation of every export, Bitwig fixtures as golden imports.
2. Local, semi-automated: a script exports the fixture set, opens each file in Bitwig Studio (installed: 6.1.4) and, after a re-export from Bitwig, imports the result and diffs it against the source. Bitwig has no headless or scriptable open/export as far as I know, so the import and re-export steps in Bitwig are driven by hand or by computer use.

### Phase 5 state

1. ~~Automated~~: every export is validated by xmllint, Bitwig fixtures are golden imports, 13 openDAW projects round trip identically.
2. `scripts/dawproject-bitwig.sh export` writes the set and opens it in Bitwig, `verify` compares Bitwig's re-exports. Not run against Bitwig yet.

## Identity

Element ids are box or field addresses (`_<uuid>.<key>`), so an openDAW export imports with its uuids: units, buses, sends, tracks, devices, note and value collections, timeline. Mirrored regions write their content once and refer to it (`reference`).

## Not carried (spec has no place)

1. Grooves, key and chord tracks (dropped by decision, bitwig/dawproject#107).
2. Note chance, play count, play curve. Region gain. Fade and automation curve slopes (written linear). Clip trigger speed, quantise, reverse.
3. Loop area, marker plays, track enabled, capture settings, time stretch details (transient mode, playback rate, Signalsmith transpose, both write `stretch`).
4. The waveform offset of warped audio is folded into the warp markers (sounds the same, differs in the boxes).
