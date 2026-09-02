import {describe, expect, it} from "vitest"
import {isDefined, Option, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {CaptureAudioBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {CaptureDevices} from "./CaptureDevices"
import type {RecordingWorklet} from "../RecordingWorklet"

// A recording is placed from reports the audio thread sends while rendering, so a capture may only be
// prepared on a running context. These tests drive `prepareRecording` against contexts that are
// running, that resume on demand, and that stay suspended.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

type FakeNode = {
    connect: (target: unknown) => void
    disconnect: (target?: unknown) => void
    disconnected: Array<unknown>
    gain: {value: number}
    pan: {value: number}
    channelCount: number
    channelCountMode: string
}

const createFakeNode = (): FakeNode => ({
    connect: () => {},
    disconnect(target?: unknown) {this.disconnected.push(target)},
    disconnected: new Array<unknown>(),
    gain: {value: 0},
    pan: {value: 0},
    channelCount: 2,
    channelCountMode: "explicit"
})

const createFakeStream = () => ({
    getAudioTracks: () => [{
        label: "Fake Input",
        getSettings: () => ({deviceId: "fake-device", channelCount: 2, latency: 0.005}),
        stop: () => {}
    }]
})

// `AudioDevices.requestStream` goes through `navigator.mediaDevices`; nothing else in these tests does.
const installFakeMediaDevices = () => {
    Reflect.set(globalThis, "navigator", {
        mediaDevices: {
            getUserMedia: async () => createFakeStream(),
            enumerateDevices: async () => []
        }
    })
}

const createFakeRecordingWorklet = () => ({
    uuid: UUID.generate(),
    terminated: false,
    set bpm(_: number) {},
    set sampleService(_: unknown) {},
    terminate(): void {this.terminated = true}
})

const setup = async ({state = "running", resumesTo = "running"}:
                     {state?: AudioContextState, resumesTo?: AudioContextState} = {}) => {
    installFakeMediaDevices()
    const {Project} = await import("../project/Project")
    const {CaptureAudio} = await import("./CaptureAudio")
    const audioContext = {
        state,
        outputLatency: 0.020,
        baseLatency: 0.005,
        sampleRate: 48_000,
        resumeCalls: 0,
        async resume(): Promise<void> {
            this.resumeCalls++
            this.state = resumesTo
        },
        createGain: () => createFakeNode(),
        createStereoPanner: () => createFakeNode(),
        createMediaStreamSource: () => createFakeNode()
    }
    const preparedWorklets = new Array<ReturnType<typeof createFakeRecordingWorklet>>()
    const removedFromSampleManager = new Array<UUID.Bytes>()
    const env = {
        audioContext,
        audioWorklets: {
            createRecording: () => {
                const worklet = createFakeRecordingWorklet()
                preparedWorklets.push(worklet)
                return worklet as unknown as RecordingWorklet
            }
        },
        sampleManager: {
            record: () => {},
            remove: (uuid: UUID.Bytes) => {removedFromSampleManager.push(uuid)}
        },
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    const captureBox = project.editing.modify(() => {
        const box = CaptureAudioBox.create(project.boxGraph, UUID.generate())
        primaryAudioUnitBox.capture.refer(box) // the box is mandatory-referenced
        return box
    }).unwrap()
    const manager = {project} as unknown as CaptureDevices
    const capture = new CaptureAudio(manager, primaryAudioUnitBox, captureBox)
    // The record gain node is the one the audio chain holds; the monitor nodes come from the same factory.
    const recordGainNode = (): FakeNode => capture.outputNode.unwrap("no audio chain") as unknown as FakeNode
    return {capture, audioContext, preparedWorklets, removedFromSampleManager, recordGainNode}
}

describe("CaptureAudio", () => {
    describe("preparing a recording", () => {
        it("prepares on a running context", async () => {
            const {capture, audioContext, preparedWorklets} = await setup()
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(audioContext.resumeCalls).toBe(0)
            expect(preparedWorklets.length).toBe(1)
            expect(preparedWorklets[0].terminated).toBe(false)
        })

        it("resumes a suspended context and prepares once it is running", async () => {
            const {capture, audioContext, preparedWorklets} = await setup({state: "suspended"})
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(audioContext.resumeCalls).toBe(1)
            expect(audioContext.state).toBe("running")
            expect(preparedWorklets.length).toBe(1)
        })

        it("rejects when the context stays suspended, leaving no worklet prepared", async () => {
            const {capture, audioContext, preparedWorklets} =
                await setup({state: "suspended", resumesTo: "suspended"})
            await expect(capture.prepareRecording()).rejects.toBeDefined()
            expect(audioContext.resumeCalls).toBe(1)
            expect(preparedWorklets.length).toBe(0)
        })

        it("discards a worklet the previous prepare left behind", async () => {
            const {capture, preparedWorklets, removedFromSampleManager, recordGainNode} = await setup()
            await capture.prepareRecording()
            const orphan = preparedWorklets[0]
            const gainNode = recordGainNode()
            await capture.prepareRecording()
            expect(preparedWorklets.length).toBe(2)
            expect(orphan.terminated).toBe(true)
            expect(removedFromSampleManager).toEqual([orphan.uuid])
            expect(gainNode.disconnected).toContain(orphan)
            expect(preparedWorklets[1].terminated).toBe(false)
        })
    })

    describe("starting a recording", () => {
        it("discards the prepared worklet when the audio chain is gone", async () => {
            const {capture, preparedWorklets, removedFromSampleManager} = await setup()
            await capture.prepareRecording()
            const worklet = preparedWorklets[0]
            capture.armed.setValue(true)
            capture.armed.setValue(false) // tears the audio chain down behind the prepared worklet
            expect(capture.outputNode).toEqual(Option.None)
            expect(capture.startRecording()).toBeDefined()
            expect(worklet.terminated).toBe(true)
            expect(removedFromSampleManager).toEqual([worklet.uuid])
        })
    })
})
