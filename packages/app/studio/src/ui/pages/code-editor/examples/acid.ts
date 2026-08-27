import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api, CubedStep, NoteEventProps, Sample} from "@opendaw/studio-scripting"
import {Interpolation, PPQN} from "@opendaw/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Acid: a seeded 303 line with Euclidean 808/909 drums (the scripted twin of andre.michelle/acid)
// Change the seed for a new track. The clips are laid out as a 64-cycle arrangement on the timeline.

const SEED = 3030808

// ---------- helpers ----------

class Rng {
    #state: number

    constructor(seed: number) {this.#state = (seed | 0) + 0x6D2B79F5}

    next(): number {
        this.#state = (this.#state + 0x6D2B79F5) | 0
        let value = Math.imul(this.#state ^ (this.#state >>> 15), 1 | this.#state)
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }

    nextInt(min: number, max: number): number {return min + Math.floor(this.next() * (max - min + 1))}

    bipolar(): number {return this.next() * 2.0 - 1.0}
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))

// Bresenham distribution, the same necklaces as Bjorklund, rotated so the first pulse lands on step 0
const euclid = (steps: number, pulses: number, rotation: number = 0): boolean[] => {
    const result: boolean[] = new Array<boolean>(Math.max(1, steps)).fill(false)
    if (pulses <= 0) {return result}
    if (pulses >= result.length) {return result.fill(true)}
    let bucket = result.length - pulses
    for (let index = 0; index < result.length; index++) {
        bucket += pulses
        if (bucket >= result.length) {
            bucket -= result.length
            result[index] = true
        }
    }
    const length = result.length
    const offset = ((rotation % length) + length) % length
    return result.map((_, index) => result[(index + offset) % length])
}

// ---------- samples (openDAW stock one shots) ----------

const stock = (name: string, uuid: string, duration: number): Sample => ({uuid, name, duration, bpm: 0, sample_rate: 44100})

type Pad = { note: number, sample: Sample, exclude: boolean }

const Pads: Pad[] = [
    {note: 36, sample: stock("TR-808 Bass Drum", "b50f6f4f-d933-400c-a63a-83b3c2f6c8b2", 3.0), exclude: false},
    {note: 37, sample: stock("909 Bassdrum", "8bb2c6e8-9a6d-4d32-b7ec-1263594ef367", 0.509), exclude: false},
    {note: 38, sample: stock("TR-808 Snare Drum", "0378e25e-6d3f-4db3-a54f-4ae795ca0ff7", 0.5), exclude: false},
    {note: 39, sample: stock("909 Clap", "32a6f36f-06eb-4b84-bb57-5f51103eb9e6", 0.507), exclude: false},
    {note: 40, sample: stock("TR-808 Rim Shot", "5dd8103f-d6a2-4604-8464-320f9e1c2f1e", 0.25), exclude: false},
    {note: 41, sample: stock("TR-808 Low Tom", "e82935b9-c17f-4348-9e8f-5b18c25da355", 1.0), exclude: false},
    {note: 42, sample: stock("909 Closed Hat", "e0ac4b39-23fb-4a56-841d-c9e0ff440cab", 0.154), exclude: true},
    {note: 43, sample: stock("TR-808 Mid Tom", "3026d15b-2b29-4c14-b1f1-bdd1521fb982", 1.0), exclude: false},
    {note: 44, sample: stock("TR-808 Maracas", "ac1bb797-a90a-4782-8a08-7b249ef18b42", 0.25), exclude: false},
    {note: 45, sample: stock("TR-808 Hi Tom", "74426997-2554-4511-8030-92fd4b3e02bb", 1.0), exclude: false},
    {note: 46, sample: stock("909 Open Hat", "51c5eea4-391c-4743-896a-859692ec1105", 0.502), exclude: true},
    {note: 47, sample: stock("TR-808 Low Conga", "5170fed0-42dd-4e27-ad8e-c6f28f7a385f", 0.5), exclude: false},
    {note: 48, sample: stock("TR-808 Mid Conga", "50da4fe7-f2e5-4173-930a-6c3bd18ebe03", 0.5), exclude: false},
    {note: 49, sample: stock("909 Crash", "42a56ff6-89b6-4f2e-8a66-5a41d316f4cb", 1.055), exclude: false},
    {note: 50, sample: stock("TR-808 Cowbell", "bc034fa6-0ac5-40d2-96a4-e04165922294", 1.5), exclude: false},
    {note: 51, sample: stock("909 Ride", "87cde966-b799-4efc-a994-069e703478d3", 1.72), exclude: false}
]

// ---------- drums ----------

type DrumLane = {
    name: string
    note: number
    steps: number
    pulses: number
    rotation: number
    resolution: number
    accents: number
    probability: number
    velocity: number
    accentVelocity: number
    humanize: number
    mute: boolean
    locked: boolean
}

const CycleBars = 4
const CycleDuration = PPQN.Bar * CycleBars

const lane = (name: string, note: number, steps: number, pulses: number, rotation: number, options: Partial<DrumLane> = {}): DrumLane => ({
    name, note, steps, pulses, rotation,
    resolution: PPQN.SemiQuaver, accents: 1, probability: 1.0, velocity: 0.8, accentVelocity: 1.0,
    humanize: 0, mute: false, locked: false, ...options
})

// The kick is locked, which keeps it four to the floor
const defaultLanes = (): DrumLane[] => [
    lane("Kick", 36, 16, 4, 0, {accents: 1, velocity: 1.0, locked: true}),
    lane("Clap", 39, 16, 2, 4, {accents: 1}),
    lane("Snare", 38, 16, 3, 12, {accents: 1, probability: 0.6, velocity: 0.6}),
    lane("Closed Hat", 42, 16, 11, 0, {accents: 4, velocity: 0.55, humanize: 6}),
    lane("Open Hat", 46, 16, 2, 2, {accents: 0, velocity: 0.7}),
    lane("Rim", 40, 12, 5, 3, {accents: 2, probability: 0.7, velocity: 0.5}),
    lane("Cowbell", 50, 10, 3, 1, {accents: 1, probability: 0.4, velocity: 0.45}),
    lane("Maracas", 44, 24, 7, 5, {accents: 3, probability: 0.8, velocity: 0.4, humanize: 8})
]

type DrumOptions = { seed: number, density: number }
type DrumVariant = "pattern" | "fill" | "drop" | "build"

const generateDrums = (lanes: DrumLane[], {seed, density}: DrumOptions): NoteEventProps[] => {
    const events: NoteEventProps[] = []
    lanes.forEach((lane, laneIndex) => {
        if (lane.mute) {return}
        const rng = new Rng(seed + laneIndex * 977)
        const pulses = lane.locked ? lane.pulses : clamp(Math.round(lane.pulses * density), 0, lane.steps)
        const pattern = euclid(lane.steps, pulses, lane.rotation)
        const accents = euclid(lane.steps, clamp(lane.accents, 0, lane.steps), lane.rotation)
        const duration = Math.max(1, lane.resolution >> 1)
        const count = Math.ceil(CycleDuration / lane.resolution)
        for (let index = 0; index < count; index++) {
            const step = index % lane.steps
            if (!pattern[step]) {continue}
            if (rng.next() >= lane.probability) {continue}
            const jitter = lane.humanize === 0 ? 0 : Math.round(rng.bipolar() * lane.humanize)
            const position = clamp(index * lane.resolution + jitter, 0, CycleDuration - 1)
            events.push({position, duration, pitch: lane.note, velocity: accents[step] ? lane.accentVelocity : lane.velocity})
        }
    })
    return events.sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
}

// One bar that closes a phrase: kick holds the first half, a snare or clap rolls in and rises, toms may walk down, an open hat ends it
const generateFill = (lanes: DrumLane[], {seed}: DrumOptions): NoteEventProps[] => {
    const rng = new Rng(seed + 31337)
    const step = PPQN.SemiQuaver
    const duration = step >> 1
    const noteOf = (name: string): number => lanes.find(lane => lane.name === name)?.note ?? 36
    const events: NoteEventProps[] = []
    const hit = (index: number, pitch: number, velocity: number) => events.push({position: index * step, duration, pitch, velocity})
    hit(0, noteOf("Kick"), 1.0)
    hit(4, noteOf("Kick"), 1.0)
    const roll = noteOf(rng.next() < 0.5 ? "Snare" : "Clap")
    for (let index = 0; index < 16; index++) {
        if (index < 8 && index % 2 !== 0) {continue}
        hit(index, roll, 0.4 + 0.6 * index / 15)
    }
    if (rng.next() < 0.6) {
        [45, 43, 41, 41].forEach((pitch, offset) => hit(12 + offset, pitch, 0.8))
    }
    hit(14, noteOf("Open Hat"), 0.8)
    return events
}

// Every variant is the full four-bar cycle. A break lives in the last bar: fill rolls, drop pulls the heavy drums, build pulls them a bar early and rolls
const drumVariant = (kind: DrumVariant, lanes: DrumLane[], options: DrumOptions): NoteEventProps[] => {
    const pattern = generateDrums(lanes, options)
    const heavy = lanes.filter(lane => ["Kick", "Snare", "Clap"].includes(lane.name)).map(lane => lane.note)
    const bar = PPQN.Bar
    const before = (bars: number) => pattern.filter(event => (event.position ?? 0) < bars * bar)
    const thin = (events: NoteEventProps[], from: number, to: number) => events.filter(event =>
        (event.position ?? 0) < from * bar || (event.position ?? 0) >= to * bar || !heavy.includes(event.pitch ?? 0))
    const shifted = (bars: number): NoteEventProps[] => generateFill(lanes, options).map(event => ({...event, position: (event.position ?? 0) + bars * bar}))
    switch (kind) {
        case "pattern": return pattern
        case "fill": return before(3).concat(shifted(3))
        case "drop": return thin(pattern, 3, 4)
        case "build": return thin(before(3), 2, 3).concat(shifted(3))
    }
}

// ---------- bass ----------

type BassOptions = {
    seed: number
    root: number
    scale: number[]
    patterns: number
    density: number
    slides: number
    accents: number
    octaveJumps: number
    mutation: number
}

const Scales: number[][] = [
    [0, 3, 5, 7, 10],           // Pentatonic Minor
    [0, 2, 3, 5, 7, 8, 10],     // Natural Minor
    [0, 1, 3, 5, 7, 8, 10]      // Phrygian
]

const Roots = [33, 35, 36, 38, 40]

// One line, one key: the bank holds variations of the same motif, the movement comes from the filter, accents and slides
const generateBass = (options: BassOptions): CubedStep[][] => {
    const base = motif(options, new Rng(options.seed))
    const bank: CubedStep[][] = [base]
    for (let index = 1; index < Math.max(1, options.patterns); index++) {
        const rng = new Rng(options.seed + index * 7919)
        bank.push(base.map(step => rng.next() < options.mutation
            ? {...step, active: rng.next() < options.density, accent: rng.next() < options.accents, slide: step.slide && rng.next() < 0.5}
            : step))
    }
    return bank
}

const motif = (options: BassOptions, rng: Rng): CubedStep[] => {
    const degrees = options.scale
    const steps: CubedStep[] = []
    let degree = 0
    for (let index = 0; index < 16; index++) {
        const onBeat = index % 4 === 0
        const active = index === 0 || rng.next() < options.density
        const accent = index === 0 ? true : rng.next() < (onBeat ? options.accents * 2.0 : options.accents)
        degree = index === 0 ? 0 : clamp(degree + rng.nextInt(-2, 2), 0, degrees.length - 1)
        const octave = accent && rng.next() < options.octaveJumps ? 12 : 0
        steps.push({note: clamp(options.root + degrees[degree] + octave, 0, 127), active, accent, slide: false})
    }
    for (let index = 0; index < steps.length; index++) {
        const next = steps[(index + 1) % steps.length]
        if (steps[index].active && next.active && rng.next() < options.slides) {
            steps[index] = {...steps[index], slide: true}
        }
    }
    return steps
}

// ---------- compose ----------

const rng = new Rng(SEED)
const range = (min: number, max: number): number => min + rng.next() * (max - min)
const lanes = defaultLanes()
lanes.forEach(lane => {
    if (lane.locked) {return}
    lane.pulses = rng.nextInt(1, Math.max(1, Math.round(lane.steps * 0.6)))
    lane.rotation = rng.nextInt(0, lane.steps - 1)
    lane.accents = rng.nextInt(0, Math.max(1, lane.pulses >> 1))
    lane.mute = rng.next() < 0.25
})
const drumOptions: DrumOptions = {seed: SEED, density: range(0.85, 1.25)}
const bassOptions: BassOptions = {
    seed: SEED,
    patterns: 4,
    root: Roots[rng.nextInt(0, Roots.length - 1)],
    scale: Scales[rng.nextInt(0, Scales.length - 1)],
    density: range(0.6, 0.85),
    slides: range(0.15, 0.45),
    accents: range(0.2, 0.45),
    octaveJumps: range(0.05, 0.25),
    mutation: range(0.15, 0.4)
}

const project = openDAW.newProject(`Acid ${SEED}`)
project.bpm = rng.nextInt(120, 125)
project.loop.enabled = false

// ---------- drum machine ----------

const drums = project.addInstrumentUnit("Playfield", {label: "Drums", volume: -12.0})
Pads.forEach(({note, sample, exclude}) => drums.instrument.addSample(sample, {note, exclude}))
const drumTrack = drums.noteTracks[0]

// The plain pattern exists twice, the arrangement below alternates them
const clipSpecs: { kind: DrumVariant, name: string }[] = [
    {kind: "pattern", name: "Pattern A"},
    {kind: "pattern", name: "Pattern B"},
    {kind: "fill", name: "Fill"},
    {kind: "drop", name: "Drop"},
    {kind: "build", name: "Build"}
]
const clips = clipSpecs.map(({kind, name}, index) => {
    const clip = drumTrack.addClip({index, label: name, duration: CycleDuration, launch: {loop: true}})
    clip.addEvents(drumVariant(kind, lanes, drumOptions))
    return {kind, clip}
})

// ---------- bass line ----------

const line = project.addInstrumentUnit("Cubed", {label: "Line", volume: -6.0}, {
    cutoff: 0.0, resonance: 0.75, envMod: 0.0, decay: 0.0, accent: 0.0, volume: -12.0
})
const bank = generateBass(bassOptions)
bank.forEach((steps, index) => line.instrument.patterns[index].setSteps(steps))

// Every knob is owned by a free-running random modulator: the device stores 0 and a unipolar random walk at
// full depth is the whole dial. Resonance rests high and its bipolar modulator swings around that.
const motionSpecs: { name: "cutoff" | "resonance" | "envMod" | "decay" | "accent", bipolar: boolean, depth: number }[] = [
    {name: "cutoff", bipolar: false, depth: 1.0},
    {name: "resonance", bipolar: true, depth: 0.75},
    {name: "envMod", bipolar: false, depth: 1.0},
    {name: "decay", bipolar: false, depth: 1.0},
    {name: "accent", bipolar: false, depth: 1.0}
]
motionSpecs.forEach(({name, bipolar, depth}, index) => {
    const motion = new Rng(SEED + index * 5171)
    const modulator = project.addModulator("Random", {
        label: name,
        rateSync: 0,
        rateAbsolute: 0.2 + motion.next() * 0.3,
        phase: 0.0,
        bipolar,
        amount: 1.0,
        smooth: 1.0,
        loop: 0,
        levels: 5,
        seed: motion.nextInt(0, 999999)
    })
    modulator.assign(line.instrument, name, depth)
})

// ---------- arrangement ----------

// One variant per four-bar cycle: cycle 1 brings the first fill, a break is rare and never follows another,
// the last cycle of every eight is the build. The 303 moves to its next variation when the pattern returns.
const Cycles = 64
const planRng = new Rng(SEED + 4711)
const plan: DrumVariant[] = []
for (let cycle = 0; cycle < Cycles; cycle++) {
    const previous = plan[cycle - 1]
    const kind: DrumVariant = cycle === 0 ? "pattern"
        : cycle === 1 ? "fill"
            : previous !== "pattern" ? "pattern"
                : cycle % 8 === 7 ? "build"
                    : (() => {
                        const roll = planRng.next()
                        return roll < 0.2 ? "fill" : roll < 0.3 ? "drop" : "pattern"
                    })()
    plan.push(kind)
}

const patternTrack = line.addValueTrack(line.instrument, "patternIndex")
const patternLane = patternTrack.addRegion({duration: CycleDuration * Cycles, label: "Variation"})
let patternIndex = 0
let alternate = 0
plan.forEach((kind, cycle) => {
    const candidates = clips.filter(entry => entry.kind === kind)
    const {clip} = candidates[alternate++ % candidates.length]
    drumTrack.addRegion({position: cycle * CycleDuration, duration: CycleDuration, label: clip.label, mirror: clip})
    if (cycle > 0 && kind === "pattern" && plan[cycle - 1] !== "pattern") {
        patternIndex = (patternIndex + 1) % bank.length
    }
    patternLane.addEvent({position: cycle * CycleDuration, value: patternIndex / 15, interpolation: Interpolation.None})
})
project.duration = CycleDuration * Cycles

project.openInStudio()
