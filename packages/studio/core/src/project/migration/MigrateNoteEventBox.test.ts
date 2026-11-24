import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {NoteEventFeatures} from "@opendaw/studio-adapters"
import {NoteEventBox} from "@opendaw/studio-boxes"
import {readFileSync} from "fs"
import {resolve} from "path"
import type {ProjectEnv} from "../ProjectEnv"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get soundfont() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

// A silent AudioContext: every node method returns another node.
const createAudioNode = (): object => new Proxy({
    gain: {value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}}, pan: {value: 0, setValueAtTime() {}}
}, {get: (target, prop) => Reflect.has(target, prop) ? Reflect.get(target, prop) : (() => createAudioNode())})
const createAudioContext = (): object => new Proxy({
    sampleRate: 48000, currentState: "running", destination: createAudioNode()
}, {get: (target, prop) => Reflect.has(target, prop) ? Reflect.get(target, prop) : (() => createAudioNode())})

const createEnv = (): ProjectEnv => ({
    audioContext: createAudioContext(), audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: createSampleManager(), sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

// openup-chance-fields.od is openup.od as saved before the feature boxes: its vocal notes hold chance 60 in the old field.
const loadOpenUp = async () => {
    const {Project} = await import("../Project")
    const buffer = readFileSync(resolve(__dirname, "../../../../../../test-files/openup-chance-fields.od"))
    return Project.loadAnyVersion(createEnv(), buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
}

type Snapshot = { uuid: string, chance: number, playCount: number, playCurve: number }

const snapshot = (notes: ReadonlyArray<NoteEventBox>): ReadonlyArray<Snapshot> => notes
    .map(note => ({
        uuid: UUID.toString(note.address.uuid),
        chance: NoteEventFeatures.readChance(note),
        playCount: NoteEventFeatures.readPlayCount(note),
        playCurve: NoteEventFeatures.readPlayCurve(note)
    }))
    .sort((a, b) => a.uuid.localeCompare(b.uuid))

describe("migrateNoteEventBox", () => {
    it("moves every old chance and repeat value into aux boxes", async () => {
        const project = await loadOpenUp()
        const notes = project.boxGraph.boxes().filter((box): box is NoteEventBox => box instanceof NoteEventBox)
        expect(notes.length).toBeGreaterThan(0)
        const migrated = notes.filter(note => note.chance.getValue() !== 100)
        expect(migrated.length, "openup.od holds notes with chance").toBeGreaterThan(0)
        notes.forEach(note => {
            expect(NoteEventFeatures.readChance(note)).toBe(note.chance.getValue())
            expect(NoteEventFeatures.readPlayCount(note)).toBe(note.playCount.getValue())
            expect(NoteEventFeatures.readPlayCurve(note)).toBe(note.playCurve.getValue())
            expect(NoteEventFeatures.chanceBox(note).nonEmpty()).toBe(note.chance.getValue() !== 100)
            expect(NoteEventFeatures.repeatBox(note).nonEmpty())
                .toBe(note.playCount.getValue() !== 1 || note.playCurve.getValue() !== 0.0)
        })
    })
    it("keeps the migrated values through save and load without migrating twice", async () => {
        const {Project} = await import("../Project")
        const project = await loadOpenUp()
        const isNote = (box: unknown): box is NoteEventBox => box instanceof NoteEventBox
        const before = snapshot(project.boxGraph.boxes().filter(isNote))
        const reloaded = await Project.loadAnyVersion(createEnv(), project.toArrayBuffer() as ArrayBuffer)
        const notes = reloaded.boxGraph.boxes().filter(isNote)
        expect(snapshot(notes)).toEqual(before)
        notes.forEach(note => {
            expect(note.chance.getValue(), "the old field is not saved").toBe(100)
            expect(note.playCount.getValue()).toBe(1)
            expect(note.playCurve.getValue()).toBe(0.0)
        })
    })
})
