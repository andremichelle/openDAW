import {ScriptEntryPoints} from "@opendaw/studio-adapters"

type Method = ScriptEntryPoints.Method
type Property = ScriptEntryPoints.Property
type Entry = ScriptEntryPoints.Entry
type Parameter = ScriptEntryPoints.Parameter

const entry = (name: string, signature: string, documentation: string): Entry => ({name, signature, documentation})

const parameter = (name: string, signature: string, documentation: string,
                   fields: ReadonlyArray<Entry> = [], elements: ReadonlyArray<Entry> = []): Parameter =>
    ({name, signature, documentation, fields, elements})

const AUDIO_BLOCK = parameter("block", "block", "Timing and transport of this block.", [
    entry("s0", "block.s0: int", "First sample index to process (inclusive)."),
    entry("s1", "block.s1: int", "Last sample index (exclusive). Only read and write between `s0` and `s1`."),
    entry("index", "block.index: int", "Block counter, increments each audio callback."),
    entry("bpm", "block.bpm: number", "Current project tempo in BPM."),
    entry("p0", "block.p0: ppqn", "Start position in ppqn (480 per quarter note)."),
    entry("p1", "block.p1: ppqn", "End position in ppqn."),
    entry("flags", "block.flags: int", "Bitmask: 1 transporting, 2 discontinuous (seek or loop restart), 4 playing, 8 bpmChanged.")
])

const NOTE_BLOCK = parameter("block", "block", "Position range and transport of this block.", [
    entry("from", "block.from: ppqn", "Start position in ppqn, inclusive (480 per quarter note)."),
    entry("to", "block.to: ppqn", "End position in ppqn, exclusive. Yield positions from `block.from` on."),
    entry("bpm", "block.bpm: number", "Current project tempo in BPM."),
    entry("flags", "block.flags: int", "Bitmask: 1 transporting, 2 discontinuous (seek or loop restart).")
])

const NOTE_EVENTS = parameter("events", "events: Iterable<NoteEvent>", [
    "The note-ons and note-offs within `[block.from, block.to)` in chronological order.",
    "",
    "- note-on: `{gate: true, id, position, duration, pitch, velocity, cent}`",
    "- note-off: `{gate: false, id, position, pitch}`",
    "",
    "Identify held notes by `id`, never by `pitch`."
].join("\n"))

const NOTE_ID = parameter("id", "id: int", "Unique note id. Identify voices by `id`, never by `pitch`.")

const BLOCK_TIMING = [
    "- `block.s0`, `block.s1`: sample range to process (s1 exclusive)",
    "- `block.index`: block counter",
    "- `block.bpm`: project tempo",
    "- `block.p0`, `block.p1`: position range in ppqn (480 per quarter note)",
    "- `block.flags`: 1 transporting, 2 discontinuous, 4 playing, 8 bpmChanged"
].join("\n")

const paramChanged: Method = {
    name: "paramChanged",
    generator: false,
    signature: "paramChanged(label, value)",
    parameters: [
        parameter("label", "label: string", "The name from the `@param` line."),
        parameter("value", "value: number", "The mapped value. unipolar 0..1, linear/exp min..max, int an integer, bool 0 or 1.")
    ],
    documentation: [
        "Called when a `@param` changes (knob, automation, modulation).",
        "",
        "- `label`: the name from the `@param` line",
        "- `value`: the mapped value. unipolar 0..1, linear/exp min..max, int an integer, bool 0 or 1"
    ].join("\n")
}

const samples: Property = {
    name: "samples",
    keys: "sample",
    signature: "this.samples.<name>",
    documentation: [
        "The audio of each `// @sample <name>`, `null` until loaded. When loaded an AudioData:",
        "",
        "- `sampleRate`: the sample's own rate, may differ from the project `sampleRate`",
        "- `numberOfFrames`, `numberOfChannels`",
        "- `frames`: one Float32Array per channel"
    ].join("\n")
}

const sidechains: Property = {
    name: "sidechains",
    keys: "sidechain",
    signature: "this.sidechains.<name>",
    documentation: [
        "The input of each `// @sidechain <name>` as `[left, right]` Float32Arrays, indexed like the output",
        "(`block.s0..block.s1`). An unconnected sidechain reads silence.",
        "",
        "Set before every `process()` call, not available in the constructor. Reading an undeclared name",
        "stops the device with an error."
    ].join("\n")
}

const latency: Property = {
    name: "latency",
    keys: null,
    signature: "this.latency = frames",
    documentation: "The delay this processor adds, in frames. Overrides `// @latency <ms>`, the engine "
        + "delays every parallel path to match."
}

const data: Property = {
    name: "data",
    keys: "collection",
    signature: "this.data.<collection>",
    documentation: [
        "The records of each `// @collection <name>`: a frozen array of frozen `{field: value}` objects, every",
        "`@field` present. Each `// @buffer <name> <length>`: a Float32Array copy.",
        "Replaced (never mutated) on every change, read it in `process` instead of keeping it.",
        "Read only: the view edits the data, the processor never writes it."
    ].join("\n")
}

const streams: Property = {
    name: "streams",
    keys: "stream",
    signature: "this.streams.<name>",
    documentation: [
        "Each `// @stream <name> <length> [value|ring|fft]`, telemetry for the views, never rendered or saved.",
        "",
        "- `value`: a Float32Array of `length`, overwrite it any time, views receive it once per frame",
        "- `ring` / `fft`: `write(channel, s0, s1)` appends samples, views get the latest `length` in order",
        "  (`fft`: `length` magnitudes of the latest `2 × length` samples, `length` a power of two)",
        "- `.active`: true while a view listens, skip the work otherwise"
    ].join("\n")
}

const dataChanged: Method = {
    name: "dataChanged",
    generator: false,
    signature: "dataChanged(name)",
    parameters: [parameter("name", "name: string", "The `@collection` whose records changed.")],
    documentation: [
        "Called once after construction for every `@collection`, then whenever a collection's records change,",
        "always between blocks. Rebuild derived state here (a wavetable from partials), never in `process`."
    ].join("\n")
}

const message: Method = {
    name: "message",
    generator: false,
    signature: "message(data)",
    parameters: [parameter("data", "data: unknown", "What the view passed to `host.send`, structured-cloned.")],
    documentation: [
        "Called with every `host.send(data)` of a view, before the next `process` call, in order.",
        "Transient: never saved, never undone, never part of an offline render. Anything that must affect the",
        "rendered sound belongs in a `@param`, `@collection` or `@buffer`."
    ].join("\n")
}

const GLOBALS: ReadonlyArray<ScriptEntryPoints.Entry> = [{
    name: "sampleRate",
    signature: "sampleRate: number",
    documentation: "The project sample rate in Hz (e.g. 48000). Always use it instead of a hardcoded rate."
}]

const werkstattMethods: ReadonlyArray<Method> = [
    {
        name: "process",
        generator: false,
        signature: "process(io, block)",
        parameters: [
            parameter("io", "io", "The audio buffers of this block.", [
                entry("src", "io.src: [Float32Array, Float32Array]", "Input channels `[left, right]`."),
                entry("out", "io.out: [Float32Array, Float32Array]", "Output channels `[left, right]`, write between `s0` and `s1`.")
            ]),
            AUDIO_BLOCK
        ],
        documentation: [
            "Required. Called for every audio block, fill `io.out` between `block.s0` and `block.s1`.",
            "",
            "- `io.src[0]`, `io.src[1]`: input channels",
            "- `io.out[0]`, `io.out[1]`: output channels",
            BLOCK_TIMING,
            "",
            "Never allocate in here. NaN or amplitudes above 1000 silence the device."
        ].join("\n")
    },
    paramChanged,
    dataChanged,
    message,
    {
        name: "reset",
        generator: false,
        signature: "reset()",
        parameters: [],
        documentation: "Called on transport stop. Clear delay lines and filter state. "
            + "Without `reset()` the Processor is rebuilt on stop."
    }
]

const apparatMethods: ReadonlyArray<Method> = [
    {
        name: "process",
        generator: false,
        signature: "process(output, block)",
        parameters: [
            parameter("output", "output: [Float32Array, Float32Array]", "Output channels `[left, right]`, cleared by the host before each block.", [], [
                entry("0", "output[0]: Float32Array", "Left output channel."),
                entry("1", "output[1]: Float32Array", "Right output channel.")
            ]),
            AUDIO_BLOCK
        ],
        documentation: [
            "Required. Renders audio between note events, may be called several times per block.",
            "The host clears the output before each block.",
            "",
            "- `output[0]`, `output[1]`: output channels",
            BLOCK_TIMING,
            "",
            "Never allocate in here. NaN or amplitudes above 1000 silence the device."
        ].join("\n")
    },
    {
        name: "noteOn",
        generator: false,
        signature: "noteOn(pitch, velocity, cent, id)",
        parameters: [
            parameter("pitch", "pitch: int", "MIDI note number 0..127. Frequency: `440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)`."),
            parameter("velocity", "velocity: number", "Note velocity 0..1."),
            parameter("cent", "cent: number", "Fine pitch offset in cents."),
            NOTE_ID
        ],
        documentation: [
            "Called when a note starts, at its exact sample position.",
            "",
            "- `pitch`: MIDI note 0..127",
            "- `velocity`: 0..1",
            "- `cent`: fine pitch offset",
            "- `id`: unique note id, identify voices by `id`, never by `pitch`"
        ].join("\n")
    },
    {
        name: "noteOff",
        generator: false,
        signature: "noteOff(id)",
        parameters: [NOTE_ID],
        documentation: "Called when a note ends, at its exact sample position. Release the voice with this `id`."
    },
    paramChanged,
    dataChanged,
    message,
    {
        name: "reset",
        generator: false,
        signature: "reset()",
        parameters: [],
        documentation: "Called on transport stop and position jumps. Put all voices into a fast release "
            + "instead of removing them, to avoid clicks."
    }
]

const spielwerkMethods: ReadonlyArray<Method> = [
    {
        name: "process",
        generator: true,
        signature: "* process(block, events)",
        parameters: [NOTE_BLOCK, NOTE_EVENTS],
        documentation: [
            "Required, a generator. Receives the note events of the block and yields notes",
            "`{position, duration, pitch, velocity, cent}`.",
            "",
            "- `block.from`, `block.to`: position range in ppqn (to exclusive)",
            "- `block.bpm`: project tempo",
            "- `block.flags`: 1 transporting, 2 discontinuous",
            "- `events`: note-ons `{gate: true, id, position, duration, pitch, velocity, cent}` and note-offs `{gate: false, id, position, pitch}`",
            "",
            "A yielded position before `block.from` silences the device."
        ].join("\n")
    },
    paramChanged,
    dataChanged,
    message,
    {
        name: "reset",
        generator: false,
        signature: "reset()",
        parameters: [],
        documentation: "Called when the transport jumps or stops. Clear held notes and counters."
    }
]

const HOST = parameter("host", "host: ViewHost", "The view's only connection to its device. Everything else the iframe cannot reach.", [
    entry("root", "host.root: HTMLElement", "The iframe body. Build the view inside it, nothing can leave the iframe."),
    entry("mode", "host.mode: \"inline\" | \"window\"", "Whether this instance sits in the device panel or in a window."),
    entry("params", "host.params.<name>", [
        "Every `@param` by name: `label`, `value` (mapped), `set(value)` (like a knob, one undo step outside",
        "`edit`), `subscribe(observer)` (called with the new value)."
    ].join("\n")),
    entry("data", "host.data.<collection>", [
        "Every `@collection` by name: `length`, `get(index)`, `toArray()`, `set(index, {field: value})`,",
        "`insert(index, values?)`, `remove(index)`, `subscribe(observer)` (called with the new records).",
        "Every `@buffer` by name: `length`, `get(index)`, `toArray()` (a copy), `set(values, offset?)`, `subscribe(observer)`.",
        "Writes show immediately in `get`, the studio confirms them and every view and the processor follow."
    ].join("\n")),
    entry("streams", "host.streams.<name>", "Every `@stream` by name: `subscribe(observer)` receives its latest values once per frame (fft: magnitudes)."),
    entry("preview", "host.preview.noteOn(pitch, velocity?) / noteOff(pitch)", "Plays notes into this device's unit, like the keyboard. Held notes are released when the view goes away."),
    entry("send", "host.send(data)", "Hands `data` to the Processor's `message(data)` before its next process call. Transient, never saved."),
    entry("edit", "host.edit(procedure)", "Runs `procedure` and applies every write in it as ONE undo step."),
    entry("gesture", "host.gesture(): {edit(procedure), end()}", "A drag: every `edit` applies live, `end()` closes ONE undo step."),
    entry("openWindow", "host.openWindow(name?)", "Opens the `@window` of the class `name` (default `View`)."),
    entry("closeWindow", "host.closeWindow(name?)", "Closes the `@window` of the class `name` (default `View`)."),
    entry("color", "host.color(name): string", "A studio colour as CSS (`blue`, `orange`, `gray`, `dark`, `shadow`, ...). Also `var(--color-<name>)` in CSS.")
])

const viewMethods: ReadonlyArray<Method> = [
    {
        name: "constructor",
        generator: false,
        signature: "constructor(host)",
        parameters: [HOST],
        documentation: [
            "Builds the view. Runs in a sandboxed iframe, never on the audio thread, and shares no variables",
            "with the Processor: talk to it only through params, collections and streams on `host`.",
            "",
            "The iframe is thrown away on recompile and close, nothing needs cleaning up."
        ].join("\n")
    },
    {
        name: "terminate",
        generator: false,
        signature: "terminate()",
        parameters: [],
        documentation: "Optional. Called before the iframe is thrown away, for flushing transient state. Not a cleanup duty."
    }
]

export namespace ScriptEntryPointDocs {
    export const view = (className: string): ScriptEntryPoints.Api =>
        ({className, methods: viewMethods, properties: [], globals: GLOBALS})

    export const werkstatt: ScriptEntryPoints.Api =
        {className: "Processor", methods: werkstattMethods, properties: [samples, sidechains, latency, data, streams], globals: GLOBALS}
    export const apparat: ScriptEntryPoints.Api =
        {className: "Processor", methods: apparatMethods, properties: [samples, sidechains, data, streams], globals: GLOBALS}
    export const spielwerk: ScriptEntryPoints.Api =
        {className: "Processor", methods: spielwerkMethods, properties: [data, streams], globals: GLOBALS}
}
