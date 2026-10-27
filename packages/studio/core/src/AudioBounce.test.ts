import {describe, expect, it} from "vitest"
import {asInstanceOf, int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, PPQN, ppqn} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    AudioUnitBoxAdapter,
    InstrumentFactories,
    ProjectSkeleton,
    Sample,
    TrackType,
    UnionAdapterTypes
} from "@opendaw/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    DelayDeviceBox,
    NoteRegionBox,
    TapeDeviceBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {EffectFactories} from "./EffectFactories"
import type {AudioBounce as Bounce} from "./AudioBounce"
import {ResourceStructure} from "./StructureFile"
import type {ProjectEnv} from "./project/ProjectEnv"
import type {Project} from "./project/Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {AudioBounce} = await import("./AudioBounce")
const {AudioContentFactory} = await import("./project/audio/AudioContentFactory")

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./project/Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const Bar = PPQN.Bar

type Unit = { audioUnitBox: AudioUnitBox, trackBox: TrackBox, label: string }

const createSynth = (project: Project, name: string): Unit => project.editing.modify(() => {
    const {audioUnitBox, trackBox} = project.api.createInstrument(InstrumentFactories.Vaporisateur, {name})
    return {audioUnitBox, trackBox, label: name}
}).unwrap("createSynth")

const createNoteRegion = (project: Project, trackBox: TrackBox, position: ppqn, duration: ppqn,
                          name: string = "", mute: boolean = false): NoteRegionBox =>
    project.editing.modify(() => project.api.createNoteRegion({trackBox, position, duration, name, mute}))
        .unwrap("createNoteRegion")

const createAutomationRegion = (project: Project, audioUnitBox: AudioUnitBox) => project.editing.modify(() => {
    const delay = asInstanceOf(project.api.insertEffect(audioUnitBox.audioEffects, EffectFactories.AudioNamed.Delay),
        DelayDeviceBox)
    const track = TrackBox.create(project.boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.index.setValue(1)
        box.tracks.refer(audioUnitBox.tracks)
        box.target.refer(delay.feedback)
    })
    return project.api.createTrackRegion(track, 0, Bar).unwrap("value region")
}).unwrap("createAutomationRegion")

const adapterOf = (project: Project, box: NoteRegionBox | AudioRegionBox): AnyRegionBoxAdapter =>
    project.boxAdapters.adapterFor(box, UnionAdapterTypes.isRegion)

const unitAdapter = (project: Project, box: AudioUnitBox): AudioUnitBoxAdapter =>
    project.boxAdapters.adapterFor(box, AudioUnitBoxAdapter)

const unitsInOrder = (project: Project): ReadonlyArray<AudioUnitBoxAdapter> =>
    project.rootBoxAdapter.audioUnits.adapters()

const createSample = (seconds: number, name: string = "bounce"): Sample => ({
    uuid: UUID.toString(UUID.generate()), name, bpm: 120, duration: seconds, sample_rate: 48000, origin: "import"
})

const renderedFor = (project: Project, job: Bounce.Job, seconds: number): Bounce.Rendered => {
    const sample = createSample(seconds)
    const audioData = AudioData.create(48000, Math.round(seconds * 48000), 2)
    const modifier = () => project.boxGraph.findBox<AudioFileBox>(UUID.parse(sample.uuid))
        .unwrapOrElse(() => AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid), box => {
            box.fileName.setValue(sample.name)
            box.endInSeconds.setValue(seconds)
        }))
    return {job, audioData, sample, modifier}
}

const tapeUnits = (project: Project): ReadonlyArray<AudioUnitBoxAdapter> =>
    unitsInOrder(project).filter(unit => unit.input.adapter()
        .mapOr(input => input.box instanceof TapeDeviceBox, false))

const regionsOf = (unit: AudioUnitBoxAdapter): ReadonlyArray<AnyRegionBoxAdapter> =>
    unit.tracks.values().flatMap(track => track.regions.collection.asArray())

const structure = (folders: ResourceStructure["folders"], trash: ResourceStructure["trash"] = []): ResourceStructure =>
    ({version: 1, folders, trash})

const uuidString = (index: int): UUID.String =>
    UUID.toString(UUID.parse(`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`))

describe("AudioBounce.collectJobs", () => {
    it("returns no job for an empty selection", async () => {
        expect(AudioBounce.collectJobs([], false, false)).toHaveLength(0)
        expect(AudioBounce.collectJobs([], true, false)).toHaveLength(0)
    })

    it("creates one job for one note region with its exact span and label", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createNoteRegion(project, synth.trackBox, Bar, Bar * 2, "Hook")
        const jobs = AudioBounce.collectJobs([adapterOf(project, region)], false, false)
        expect(jobs).toHaveLength(1)
        expect(jobs[0].start).toBe(Bar)
        expect(jobs[0].end).toBe(Bar * 3)
        expect(jobs[0].label).toBe("Hook")
        expect(jobs[0].regions).toHaveLength(1)
        expect(UUID.equals(jobs[0].audioUnitBox.address.uuid, synth.audioUnitBox.address.uuid)).toBe(true)
    })

    it("bounces each region on its own when merge is off, sorted by position", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const late = createNoteRegion(project, synth.trackBox, Bar * 4, Bar, "B")
        const early = createNoteRegion(project, synth.trackBox, 0, Bar, "A")
        const jobs = AudioBounce.collectJobs([adapterOf(project, late), adapterOf(project, early)], false, false)
        expect(jobs.map(job => job.label)).toEqual(["A", "B"])
        expect(jobs.map(job => [job.start, job.end])).toEqual([[0, Bar], [Bar * 4, Bar * 5]])
    })

    it("merges all regions of one unit into one span from the first start to the last end", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const first = createNoteRegion(project, synth.trackBox, Bar, Bar, "First")
        const second = createNoteRegion(project, synth.trackBox, Bar * 6, Bar * 2, "Second")
        const jobs = AudioBounce.collectJobs([adapterOf(project, second), adapterOf(project, first)], true, false)
        expect(jobs).toHaveLength(1)
        expect(jobs[0].start).toBe(Bar)
        expect(jobs[0].end).toBe(Bar * 8)
        expect(jobs[0].label).toBe("First")
        expect(jobs[0].regions).toHaveLength(2)
    })

    it("takes the furthest end when a later starting region ends earlier (second track)", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const secondTrack = project.editing.modify(() => project.api.createNoteTrack(synth.audioUnitBox))
            .unwrap("track")
        const long = createNoteRegion(project, synth.trackBox, 0, Bar * 8)
        const inner = createNoteRegion(project, secondTrack, Bar * 2, Bar)
        const jobs = AudioBounce.collectJobs([adapterOf(project, long), adapterOf(project, inner)], true, false)
        expect(jobs).toHaveLength(1)
        expect([jobs[0].start, jobs[0].end]).toEqual([0, Bar * 8])
    })

    it("never merges regions of different units", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const regions = [
            createNoteRegion(project, lead.trackBox, 0, Bar),
            createNoteRegion(project, bass.trackBox, Bar, Bar),
            createNoteRegion(project, lead.trackBox, Bar * 2, Bar)
        ].map(box => adapterOf(project, box))
        const jobs = AudioBounce.collectJobs(regions, true, false)
        expect(jobs).toHaveLength(2)
        const leadJob = jobs.find(job => job.audioUnitBox === lead.audioUnitBox)
        const bassJob = jobs.find(job => job.audioUnitBox === bass.audioUnitBox)
        expect(leadJob?.regions).toHaveLength(2)
        expect(bassJob?.regions).toHaveLength(1)
        expect([leadJob?.start, leadJob?.end]).toEqual([0, Bar * 3])
    })

    it("ignores automation regions", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const valueRegion = createAutomationRegion(project, synth.audioUnitBox)
        const valueAdapter = project.boxAdapters.adapterFor(valueRegion, UnionAdapterTypes.isRegion)
        expect(valueAdapter.type).toBe("value-region")
        expect(AudioBounce.collectJobs([valueAdapter], false, false)).toHaveLength(0)
        expect(AudioBounce.canBounce([valueAdapter])).toBe(false)
        const noteAdapter = adapterOf(project, createNoteRegion(project, synth.trackBox, 0, Bar))
        expect(AudioBounce.canBounce([valueAdapter, noteAdapter])).toBe(true)
        expect(AudioBounce.collectJobs([valueAdapter, noteAdapter], false, false)).toHaveLength(1)
    })

    it("accepts audio regions", async () => {
        const project = await createProject()
        const audioRegion = project.editing.modify(() => {
            const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape)
            const sample = createSample(2)
            const audioFileBox = AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid), box =>
                box.endInSeconds.setValue(2))
            return AudioContentFactory.createNotStretchedRegion({
                boxGraph: project.boxGraph, targetTrack: trackBox, audioFileBox, sample, position: Bar, name: "Vox"
            })
        }).unwrap("audio region")
        const jobs = AudioBounce.collectJobs([adapterOf(project, audioRegion)], false, false)
        expect(jobs).toHaveLength(1)
        expect(jobs[0].label).toBe("Vox")
        expect(jobs[0].start).toBe(Bar)
        expect(jobs[0].end).toBeCloseTo(Bar * 2, 6)
    })
})

describe("AudioBounce.canMerge", () => {
    it("needs at least two regions of the same unit", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const a = adapterOf(project, createNoteRegion(project, lead.trackBox, 0, Bar))
        const b = adapterOf(project, createNoteRegion(project, bass.trackBox, 0, Bar))
        const c = adapterOf(project, createNoteRegion(project, lead.trackBox, Bar, Bar))
        expect(AudioBounce.canMerge([a])).toBe(false)
        expect(AudioBounce.canMerge([a, b])).toBe(false)
        expect(AudioBounce.canMerge([a, b, c])).toBe(true)
    })
})

describe("AudioBounce.stemConfiguration", () => {
    it("maps pre-fx to the instrument output", () => {
        const stem = AudioBounce.stemConfiguration("pre-fx", "x")
        expect(stem.useInstrumentOutput).toBe(true)
        expect(stem.skipChannelStrip).toBe(false)
        expect(stem.includeSends).toBe(false)
    })

    it("maps pre-fader to the effect chain output before the channel strip", () => {
        const stem = AudioBounce.stemConfiguration("pre-fader", "x")
        expect(stem.useInstrumentOutput).toBe(false)
        expect(stem.skipChannelStrip).toBe(true)
        expect(stem.includeAudioEffects).toBe(true)
        expect(stem.includeSends).toBe(false)
    })

    it("maps post-fader to the channel strip output", () => {
        const stem = AudioBounce.stemConfiguration("post-fader", "x")
        expect(stem.useInstrumentOutput).toBe(false)
        expect(stem.skipChannelStrip).toBe(false)
        expect(stem.includeAudioEffects).toBe(true)
        expect(stem.includeSends).toBe(false)
    })

    it("keys the export configuration by the unit uuid with exactly one stem", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const job = AudioBounce.collectJobs([adapterOf(project, createNoteRegion(project, synth.trackBox, 0, Bar))],
            false, false)[0]
        const {stems} = AudioBounce.exportConfiguration(job, "post-fader")
        expect(Object.keys(stems ?? {})).toEqual([UUID.toString(synth.audioUnitBox.address.uuid)])
    })
})

describe("AudioBounce.prepareCopy", () => {
    it("removes every other note region of the unit on all its tracks and keeps the job regions", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const secondTrack = project.editing.modify(() => project.api.createNoteTrack(synth.audioUnitBox))
            .unwrap("track")
        const target = createNoteRegion(project, synth.trackBox, Bar, Bar)
        const before = createNoteRegion(project, synth.trackBox, 0, Bar)
        const after = createNoteRegion(project, synth.trackBox, Bar * 4, Bar)
        const parallel = createNoteRegion(project, secondTrack, Bar, Bar)
        const job = AudioBounce.collectJobs([adapterOf(project, target)], false, false)[0]
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        const has = (box: NoteRegionBox) => copy.boxGraph.findBox(box.address.uuid).nonEmpty()
        expect(has(target)).toBe(true)
        expect(has(before)).toBe(false)
        expect(has(after)).toBe(false)
        expect(has(parallel)).toBe(false)
    })

    it("keeps the regions of other units and automation regions of the unit", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const target = createNoteRegion(project, lead.trackBox, 0, Bar)
        const other = createNoteRegion(project, bass.trackBox, 0, Bar)
        const automation = createAutomationRegion(project, lead.audioUnitBox)
        const job = AudioBounce.collectJobs([adapterOf(project, target)], false, false)[0]
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        expect(copy.boxGraph.findBox(other.address.uuid).nonEmpty()).toBe(true)
        expect(copy.boxGraph.findBox(automation.address.uuid).nonEmpty()).toBe(true)
    })

    it("keeps every region of a merged job", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const a = createNoteRegion(project, synth.trackBox, 0, Bar)
        const b = createNoteRegion(project, synth.trackBox, Bar * 2, Bar)
        const left = createNoteRegion(project, synth.trackBox, Bar * 8, Bar)
        const job = AudioBounce.collectJobs([adapterOf(project, a), adapterOf(project, b)], true, false)[0]
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        expect(copy.boxGraph.findBox(a.address.uuid).nonEmpty()).toBe(true)
        expect(copy.boxGraph.findBox(b.address.uuid).nonEmpty()).toBe(true)
        expect(copy.boxGraph.findBox(left.address.uuid).nonEmpty()).toBe(false)
    })

    it("unmutes the job region, the unit and its tracks and clears every solo", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const target = createNoteRegion(project, lead.trackBox, 0, Bar, "", true)
        project.editing.modify(() => {
            lead.audioUnitBox.mute.setValue(true)
            lead.trackBox.enabled.setValue(false)
            bass.audioUnitBox.solo.setValue(true)
        })
        const job = AudioBounce.collectJobs([adapterOf(project, target)], false, false)[0]
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        const find = <T>(box: { address: { uuid: UUID.Bytes } }) => copy.boxGraph.findBox(box.address.uuid)
            .unwrap("copied") as T
        expect(find<NoteRegionBox>(target).mute.getValue()).toBe(false)
        expect(find<AudioUnitBox>(lead.audioUnitBox).mute.getValue()).toBe(false)
        expect(find<TrackBox>(lead.trackBox).enabled.getValue()).toBe(true)
        expect(find<AudioUnitBox>(bass.audioUnitBox).solo.getValue()).toBe(false)
    })

    it("never touches the source project", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const target = createNoteRegion(project, synth.trackBox, 0, Bar, "", true)
        const other = createNoteRegion(project, synth.trackBox, Bar, Bar)
        project.editing.modify(() => synth.audioUnitBox.mute.setValue(true))
        const job = AudioBounce.collectJobs([adapterOf(project, target)], false, false)[0]
        AudioBounce.prepareCopy(project.copy(), job)
        expect(target.mute.getValue()).toBe(true)
        expect(synth.audioUnitBox.mute.getValue()).toBe(true)
        expect(other.isAttached()).toBe(true)
    })
})

describe("AudioBounce.audibleLength", () => {
    const frames = (length: int, ...audible: ReadonlyArray<[int, int, number]>): ReadonlyArray<Float32Array> => {
        const channels = [new Float32Array(length), new Float32Array(length)]
        audible.forEach(([channel, index, value]) => channels[channel][index] = value)
        return channels
    }

    it("keeps the exact span when everything after it is silent", () => {
        expect(AudioBounce.audibleLength(frames(100), 40, 100)).toBe(40)
    })

    it("keeps the exact span even when it is silent itself", () => {
        expect(AudioBounce.audibleLength(frames(100), 0, 100)).toBe(0)
    })

    it("ends right after the last audible frame in the tail", () => {
        expect(AudioBounce.audibleLength(frames(100, [0, 70, 0.5]), 40, 100)).toBe(71)
    })

    it("looks at every channel", () => {
        expect(AudioBounce.audibleLength(frames(100, [0, 50, 0.5], [1, 80, -0.5]), 40, 100)).toBe(81)
    })

    it("ignores sound before the minimum length", () => {
        expect(AudioBounce.audibleLength(frames(100, [0, 10, 1.0]), 40, 100)).toBe(40)
    })

    it("treats values at the threshold as silence and above as sound", () => {
        const threshold = AudioBounce.SilenceThreshold
        expect(AudioBounce.audibleLength(frames(100, [0, 60, threshold]), 40, 100)).toBe(40)
        expect(AudioBounce.audibleLength(frames(100, [0, 60, threshold * 1.01]), 40, 100)).toBe(61)
    })

    it("only scans up to the given length", () => {
        expect(AudioBounce.audibleLength(frames(100, [0, 90, 1.0]), 40, 80)).toBe(40)
    })

    it("keeps a sound on the very last frame", () => {
        expect(AudioBounce.audibleLength(frames(100, [1, 99, 1.0]), 40, 100)).toBe(100)
    })
})

describe("AudioBounce.assignLanes", () => {
    it("puts spans that follow each other on one lane", () => {
        expect(AudioBounce.assignLanes([{start: 0, end: 10}, {start: 10, end: 20}, {start: 30, end: 40}]))
            .toEqual([0, 0, 0])
    })

    it("moves an overlapping span to the next lane", () => {
        expect(AudioBounce.assignLanes([{start: 0, end: 15}, {start: 10, end: 20}])).toEqual([0, 1])
    })

    it("reuses the first lane that is free again", () => {
        expect(AudioBounce.assignLanes([
            {start: 0, end: 100}, {start: 10, end: 20}, {start: 30, end: 40}, {start: 35, end: 50}, {start: 100, end: 110}
        ])).toEqual([0, 1, 1, 2, 0])
    })

    it("stacks three spans on the same start", () => {
        expect(AudioBounce.assignLanes([{start: 0, end: 10}, {start: 0, end: 10}, {start: 0, end: 10}]))
            .toEqual([0, 1, 2])
    })

    it("returns nothing for nothing", () => {
        expect(AudioBounce.assignLanes([])).toEqual([])
    })
})

describe("AudioBounce.fileInto", () => {
    const [a, b, c] = [uuidString(1), uuidString(2), uuidString(3)]

    it("creates the Bounces folder at the root", () => {
        const result = AudioBounce.fileInto(structure([]), [a, b])
        expect(result.folders).toEqual([{name: AudioBounce.FolderName, uuids: [a, b]}])
    })

    it("appends to an existing Bounces folder and keeps its sub folders", () => {
        const result = AudioBounce.fileInto(structure([
            {name: "Drums", uuids: [c]},
            {name: AudioBounce.FolderName, uuids: [a], folders: [{name: "Old"}]}
        ]), [b])
        expect(result.folders).toEqual([
            {name: "Drums", uuids: [c]},
            {name: AudioBounce.FolderName, uuids: [a, b], folders: [{name: "Old"}]}
        ])
    })

    it("leaves a sample where the user filed it", () => {
        const source = structure([{name: "Keep", folders: [{name: "Deep", uuids: [a]}]}])
        expect(AudioBounce.fileInto(source, [a])).toBe(source)
    })

    it("takes a sample that is identical to a trashed one out of the trash", () => {
        const result = AudioBounce.fileInto(structure([], [{uuid: a, path: ""}, {uuid: b, path: "X"}]), [a])
        expect(result.trash).toEqual([{uuid: b, path: "X"}])
        expect(result.folders).toEqual([{name: AudioBounce.FolderName, uuids: [a]}])
    })

    it("files each uuid once", () => {
        const result = AudioBounce.fileInto(structure([]), [a, a, b])
        expect(result.folders[0].uuids).toEqual([a, b])
    })

    it("does not duplicate a uuid already in Bounces", () => {
        const source = structure([{name: AudioBounce.FolderName, uuids: [a]}])
        expect(AudioBounce.fileInto(source, [a])).toBe(source)
    })

    it("does not match a nested folder named Bounces", () => {
        const result = AudioBounce.fileInto(structure([{name: "X", folders: [{name: AudioBounce.FolderName}]}]), [a])
        expect(result.folders).toEqual([
            {name: "X", folders: [{name: AudioBounce.FolderName}]},
            {name: AudioBounce.FolderName, uuids: [a]}
        ])
    })

    it("returns the same structure for an empty list", () => {
        const source = structure([])
        expect(AudioBounce.fileInto(source, [])).toBe(source)
    })
})

describe("AudioBounce.applyEdit", () => {
    it("creates a Tape unit right below the source with the bounced region at the original position", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const region = createNoteRegion(project, lead.trackBox, Bar * 2, Bar, "Hook")
        const job = AudioBounce.collectJobs([adapterOf(project, region)], false, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 2)])
        const order = unitsInOrder(project)
        const leadIndex = order.findIndex(unit => unit.box === lead.audioUnitBox)
        const bounceUnit = order[leadIndex + 1]
        expect(bounceUnit.label).toBe("Lead Bounce")
        expect(order[leadIndex + 2].box).toBe(bass.audioUnitBox)
        const bounced = regionsOf(bounceUnit)
        expect(bounced).toHaveLength(1)
        expect(bounced[0].type).toBe("audio-region")
        expect(bounced[0].position).toBe(Bar * 2)
        expect(bounced[0].label).toBe("Hook")
        expect(bounced[0].mute).toBe(false)
    })

    it("mutes the source regions", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const a = createNoteRegion(project, lead.trackBox, 0, Bar)
        const b = createNoteRegion(project, lead.trackBox, Bar * 2, Bar)
        const untouched = createNoteRegion(project, lead.trackBox, Bar * 4, Bar)
        const jobs = AudioBounce.collectJobs([adapterOf(project, a), adapterOf(project, b)], false, false)
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 2)))
        expect(a.mute.getValue()).toBe(true)
        expect(b.mute.getValue()).toBe(true)
        expect(untouched.mute.getValue()).toBe(false)
    })

    it("puts all bounces of one unit on one Tape unit", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const regions = [0, 2, 4].map(bar => createNoteRegion(project, lead.trackBox, Bar * bar, Bar))
        const jobs = AudioBounce.collectJobs(regions.map(box => adapterOf(project, box)), false, false)
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 2)))
        const tapes = tapeUnits(project)
        expect(tapes).toHaveLength(1)
        expect(tapes[0].tracks.values()).toHaveLength(1)
        expect(regionsOf(tapes[0]).map(region => region.position)).toEqual([0, Bar * 2, Bar * 4])
    })

    it("creates one Tape unit per source unit, each directly below its source", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const bass = createSynth(project, "Bass")
        const drums = createSynth(project, "Drums")
        const regions = [
            createNoteRegion(project, lead.trackBox, 0, Bar),
            createNoteRegion(project, drums.trackBox, 0, Bar)
        ]
        const jobs = AudioBounce.collectJobs(regions.map(box => adapterOf(project, box)), false, false)
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 2)))
        const labels = unitsInOrder(project).map(unit => unit.label).filter(label => label.length > 0)
        const leadAt = labels.indexOf("Lead")
        expect(labels.slice(leadAt, leadAt + 5)).toEqual(["Lead", "Lead Bounce", "Bass", "Drums", "Drums Bounce"])
        expect(bass.audioUnitBox.isAttached()).toBe(true)
    })

    it("keeps unit indices contiguous", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        createSynth(project, "Bass")
        const job = AudioBounce.collectJobs([adapterOf(project, createNoteRegion(project, lead.trackBox, 0, Bar))],
            false, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 2)])
        expect(unitsInOrder(project).map(unit => unit.indexField.getValue()))
            .toEqual(unitsInOrder(project).map((_, index) => index))
    })

    it("moves bounces that would overlap onto a second track of the Tape unit", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const a = createNoteRegion(project, lead.trackBox, 0, Bar)
        const b = createNoteRegion(project, lead.trackBox, Bar, Bar)
        const c = createNoteRegion(project, lead.trackBox, Bar * 4, Bar)
        const jobs = AudioBounce.collectJobs([a, b, c].map(box => adapterOf(project, box)), false, false)
        // two bars of audio each (a tail), so the first runs into the second
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 4)))
        const tape = tapeUnits(project)[0]
        const tracks = tape.tracks.values()
        expect(tracks).toHaveLength(2)
        expect(tracks[0].regions.collection.asArray().map(region => region.position)).toEqual([0, Bar * 4])
        expect(tracks[1].regions.collection.asArray().map(region => region.position)).toEqual([Bar])
        expect(project.invalid()).toBe(false)
    })

    it("keeps a bounce that exactly ends where the next starts on the same track", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const a = createNoteRegion(project, lead.trackBox, 0, Bar)
        const b = createNoteRegion(project, lead.trackBox, Bar, Bar)
        const jobs = AudioBounce.collectJobs([a, b].map(box => adapterOf(project, box)), false, false)
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 2)))
        expect(tapeUnits(project)[0].tracks.values()).toHaveLength(1)
        expect(project.invalid()).toBe(false)
    })

    it("is one undo step that restores the project", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const region = createNoteRegion(project, lead.trackBox, 0, Bar)
        const unitsBefore = unitsInOrder(project).length
        const job = AudioBounce.collectJobs([adapterOf(project, region)], false, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 2)])
        expect(unitsInOrder(project).length).toBe(unitsBefore + 1)
        project.editing.undo()
        expect(unitsInOrder(project).length).toBe(unitsBefore)
        expect(region.mute.getValue()).toBe(false)
        expect(tapeUnits(project)).toHaveLength(0)
        project.editing.redo()
        expect(tapeUnits(project)).toHaveLength(1)
        expect(region.mute.getValue()).toBe(true)
    })

    it("names the merged bounce after the first region", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const a = createNoteRegion(project, lead.trackBox, 0, Bar, "Verse")
        const b = createNoteRegion(project, lead.trackBox, Bar * 2, Bar, "Chorus")
        const job = AudioBounce.collectJobs([adapterOf(project, b), adapterOf(project, a)], true, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 6)])
        const bounced = regionsOf(tapeUnits(project)[0])
        expect(bounced).toHaveLength(1)
        expect(bounced[0].label).toBe("Verse")
        expect(a.mute.getValue()).toBe(true)
        expect(b.mute.getValue()).toBe(true)
    })

    it("uses the duration of the rendered audio including a tail", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        const region = createNoteRegion(project, lead.trackBox, 0, Bar)
        const job = AudioBounce.collectJobs([adapterOf(project, region)], false, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 3)])
        const bounced = regionsOf(tapeUnits(project)[0])[0]
        expect(bounced.complete).toBeCloseTo(Bar * 1.5, 6)
    })

    it("bounces into a project whose Tape unit name is taken", async () => {
        const project = await createProject()
        const lead = createSynth(project, "Lead")
        createSynth(project, "Lead Bounce")
        const region = createNoteRegion(project, lead.trackBox, 0, Bar)
        const job = AudioBounce.collectJobs([adapterOf(project, region)], false, false)[0]
        AudioBounce.applyEdit(project, [renderedFor(project, job, 2)])
        const tape = tapeUnits(project)[0]
        expect(tape.label).not.toBe("Lead Bounce")
        expect(tape.label.startsWith("Lead Bounce")).toBe(true)
        expect(asInstanceOf(tape.box, AudioUnitBox)).toBeDefined()
    })
})

describe("AudioBounce.renderFrames", () => {
    const Rate = 48000
    // A signal source that is audible until `audibleUntil` and silent after, counting the frames it was asked for.
    const source = (audibleUntil: int) => {
        let position = 0
        const requests: Array<int> = []
        const step: Bounce.Step = async count => {
            requests.push(count)
            const channels = [new Float32Array(count), new Float32Array(count)]
            for (let index = 0; index < count; index++) {
                if (position + index < audibleUntil) {channels[0][index] = 0.5; channels[1][index] = -0.5}
            }
            position += count
            return channels
        }
        return {step, requests}
    }

    it("returns exactly the span without tail", async () => {
        const {step} = source(Number.MAX_SAFE_INTEGER)
        const audio = await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 100_000, tail: false}, Rate)
        expect(audio.numberOfFrames).toBe(100_000)
        expect(audio.frames[0][99_999]).toBe(0.5)
        expect(audio.frames[1][99_999]).toBe(-0.5)
    })

    it("asks for whole chunks only", async () => {
        const {step, requests} = source(0)
        await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 100_001, tail: false}, Rate)
        expect(requests.every(count => count === AudioBounce.ChunkFrames)).toBe(true)
        expect(requests.length).toBe(Math.ceil(100_001 / AudioBounce.ChunkFrames))
    })

    it("keeps the audible tail and drops the silence after it", async () => {
        const {step} = source(130_000)
        const audio = await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 100_000, tail: true}, Rate)
        expect(audio.numberOfFrames).toBe(130_000)
    })

    it("stops stepping once a second of silence follows the span", async () => {
        const {step, requests} = source(100_000)
        await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 100_000, tail: true}, Rate)
        const asked = requests.reduce((sum, count) => sum + count, 0)
        expect(asked).toBeLessThanOrEqual(100_000 + Rate * AudioBounce.TailSilenceSeconds + AudioBounce.ChunkFrames * 2)
    })

    it("caps a tail that never ends", async () => {
        const {step} = source(Number.MAX_SAFE_INTEGER)
        const audio = await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 1000, tail: true}, Rate)
        expect(audio.numberOfFrames).toBe(1000 + AudioBounce.MaxTailSeconds * Rate)
    })

    it("reports progress that rises to one", async () => {
        const {step} = source(0)
        const values: Array<number> = []
        await AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 200_000, tail: false}, Rate, value => values.push(value))
        expect(values.length).toBeGreaterThan(1)
        expect(values.every((value, index) => index === 0 || value >= values[index - 1])).toBe(true)
        expect(values[values.length - 1]).toBe(1)
    })

    it("rejects when aborted and stops stepping", async () => {
        const {step, requests} = source(0)
        const controller = new AbortController()
        controller.abort()
        await expect(AudioBounce.renderFrames(step, {skipFrames: 0, numFrames: 200_000, tail: false}, Rate, () => {}, controller.signal)).rejects.toThrow()
        expect(requests).toHaveLength(0)
    })
})

describe("AudioBounce loop mode", () => {
    const createLoopedRegion = (project: Project, trackBox: TrackBox, position: ppqn, duration: ppqn,
                                loopDuration: ppqn, loopOffset: ppqn = 0, name: string = ""): NoteRegionBox =>
        project.editing.modify(() => project.api.createNoteRegion({
            trackBox, position, duration, loopDuration, loopOffset, name
        })).unwrap("createLoopedRegion")

    it("creates one job per region spanning one pass from the region position", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, Bar * 2, Bar * 8, Bar)
        const jobs = AudioBounce.collectJobs([adapterOf(project, region)], false, true)
        expect(jobs).toHaveLength(1)
        expect(jobs[0].loop).toBe(true)
        expect([jobs[0].start, jobs[0].end]).toEqual([Bar * 2, Bar * 3])
    })

    it("ignores merge", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const a = createLoopedRegion(project, synth.trackBox, 0, Bar * 2, Bar)
        const b = createLoopedRegion(project, synth.trackBox, Bar * 4, Bar * 2, Bar)
        const jobs = AudioBounce.collectJobs([adapterOf(project, a), adapterOf(project, b)], true, true)
        expect(jobs).toHaveLength(2)
        expect(jobs.every(job => job.loop && job.regions.length === 1)).toBe(true)
    })

    it("spans the full loop even when the region is shorter than one pass", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, 0, Bar / 2, Bar * 2)
        const [job] = AudioBounce.collectJobs([adapterOf(project, region)], false, true)
        expect(job.end).toBe(Bar * 2)
    })

    it("plays two passes from the loop start in the copy", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, Bar, Bar * 8, Bar * 2, Bar / 2)
        const [job] = AudioBounce.collectJobs([adapterOf(project, region)], false, true)
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        const copied = copy.boxGraph.findBox<NoteRegionBox>(region.address.uuid).unwrap("copied")
        expect(copied.position.getValue()).toBe(Bar)
        expect(copied.loopOffset.getValue()).toBe(0)
        expect(copied.loopDuration.getValue()).toBe(Bar * 2)
        expect(copied.duration.getValue()).toBe(Bar * 4)
        expect(region.loopOffset.getValue()).toBe(Bar / 2)
        expect(region.duration.getValue()).toBe(Bar * 8)
    })

    it("doubles an audio region in its own time base", async () => {
        const project = await createProject()
        const audioRegion = project.editing.modify(() => {
            const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape)
            const sample = createSample(3)
            const audioFileBox = AudioFileBox.create(project.boxGraph, UUID.parse(sample.uuid), box =>
                box.endInSeconds.setValue(3))
            const box = AudioContentFactory.createNotStretchedRegion({
                boxGraph: project.boxGraph, targetTrack: trackBox, audioFileBox, sample, position: 0
            })
            box.loopDuration.setValue(1.5)
            box.loopOffset.setValue(Bar / 4)
            return box
        }).unwrap("audio region")
        const [job] = AudioBounce.collectJobs([adapterOf(project, audioRegion)], false, true)
        expect(job.end).toBeCloseTo(Bar * 0.75, 6)
        const copy = project.copy()
        AudioBounce.prepareCopy(copy, job)
        const copied = copy.boxGraph.findBox<AudioRegionBox>(audioRegion.address.uuid).unwrap("copied")
        expect(copied.duration.getValue()).toBe(3)
        expect(copied.loopOffset.getValue()).toBe(0)
    })

    it("renders two passes and keeps only the second", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, 0, Bar * 4, Bar)
        const [job] = AudioBounce.collectJobs([adapterOf(project, region)], false, true)
        const span = AudioBounce.renderSpan(project, job, true, 48000)
        expect(span).toEqual({skipFrames: 96000, numFrames: 96000, tail: false})
    })

    it("keeps the given tail option outside loop mode", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, 0, Bar * 4, Bar)
        const [job] = AudioBounce.collectJobs([adapterOf(project, region)], false, false)
        expect(AudioBounce.renderSpan(project, job, true, 48000)).toEqual({skipFrames: 0, numFrames: 96000 * 4, tail: true})
    })

    it("loops the bounced region like the source", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const region = createLoopedRegion(project, synth.trackBox, Bar * 2, Bar * 6, Bar, Bar / 4, "Groove")
        const [job] = AudioBounce.collectJobs([adapterOf(project, region)], false, true)
        AudioBounce.applyEdit(project, [renderedFor(project, job, 2)])
        const bounced = asInstanceOf(regionsOf(tapeUnits(project)[0])[0].box, AudioRegionBox)
        expect(bounced.position.getValue()).toBe(Bar * 2)
        expect(bounced.duration.getValue()).toBeCloseTo(12, 9)
        expect(bounced.loopDuration.getValue()).toBeCloseTo(2, 9)
        expect(bounced.loopOffset.getValue()).toBe(Bar / 4)
        expect(bounced.label.getValue()).toBe("Groove")
        expect(region.mute.getValue()).toBe(true)
        expect(project.invalid()).toBe(false)
    })

    it("places looped bounces by the source span, not by the rendered pass", async () => {
        const project = await createProject()
        const synth = createSynth(project, "Lead")
        const secondTrack = project.editing.modify(() => project.api.createNoteTrack(synth.audioUnitBox))
            .unwrap("track")
        const a = createLoopedRegion(project, synth.trackBox, 0, Bar * 4, Bar)
        const b = createLoopedRegion(project, secondTrack, Bar * 2, Bar * 2, Bar)
        const jobs = AudioBounce.collectJobs([adapterOf(project, a), adapterOf(project, b)], false, true)
        AudioBounce.applyEdit(project, jobs.map(job => renderedFor(project, job, 2)))
        expect(tapeUnits(project)[0].tracks.values()).toHaveLength(2)
        expect(project.invalid()).toBe(false)
    })
})

describe("AudioBounce.renderFrames skip", () => {
    const ramp: Bounce.Step = (() => {
        let position = 0
        return async (count: int) => {
            const channels = [new Float32Array(count), new Float32Array(count)]
            for (let index = 0; index < count; index++) {
                channels[0][index] = channels[1][index] = (position + index) / 1_000_000
            }
            position += count
            return channels
        }
    })()

    it("drops the skipped frames and returns exactly the requested pass", async () => {
        const audio = await AudioBounce.renderFrames(ramp, {skipFrames: 1000, numFrames: 500, tail: false}, 48000)
        expect(audio.numberOfFrames).toBe(500)
        expect(audio.frames[0][0]).toBeCloseTo(1000 / 1_000_000, 9)
        expect(audio.frames[1][499]).toBeCloseTo(1499 / 1_000_000, 9)
    })
})
