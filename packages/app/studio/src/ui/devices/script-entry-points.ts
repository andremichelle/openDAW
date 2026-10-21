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
    {
        name: "reset",
        generator: false,
        signature: "reset()",
        parameters: [],
        documentation: "Called when the transport jumps or stops. Clear held notes and counters."
    }
]

export namespace ScriptEntryPointDocs {
    export const werkstatt: ScriptEntryPoints.Api =
        {className: "Processor", methods: werkstattMethods, properties: [samples, sidechains, latency], globals: GLOBALS}
    export const apparat: ScriptEntryPoints.Api =
        {className: "Processor", methods: apparatMethods, properties: [samples, sidechains], globals: GLOBALS}
    export const spielwerk: ScriptEntryPoints.Api =
        {className: "Processor", methods: spielwerkMethods, properties: [], globals: GLOBALS}
}
