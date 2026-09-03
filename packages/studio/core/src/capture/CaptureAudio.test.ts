import {describe, expect, it} from "vitest"
import {int, isDefined, Option, UUID} from "@opendaw/lib-std"
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
    connected: Array<unknown>
    disconnected: Array<unknown>
    gain: {value: number}
    pan: {value: number}
    channelCount: number
    channelCountMode: string
}

const createFakeNode = (): FakeNode => ({
    connect(target: unknown) {this.connected.push(target)},
    disconnect(target?: unknown) {this.disconnected.push(target)},
    connected: new Array<unknown>(),
    disconnected: new Array<unknown>(),
    gain: {value: 0},
    pan: {value: 0},
    channelCount: 2,
    channelCountMode: "explicit"
})

// The audio chain's silent sink is the only node the source is connected to that has its gain at zero:
// the record gain and the monitor gain both sit at unity while the chain is built.
const keepAliveSinkOf = (sourceNode: FakeNode): FakeNode => {
    const sinks = sourceNode.connected.filter(target => (target as FakeNode).gain?.value === 0) as Array<FakeNode>
    expect(sinks.length).toBe(1)
    return sinks[0]
}

type FakeTrack = {label: string, stopped: boolean, getSettings: () => MediaTrackSettings, stop: () => void}

// One track object per stream, kept across `getAudioTracks()` calls so `stop()` is observable.
const createFakeStream = (deviceId: string, tracks: Array<FakeTrack>) => {
    const track: FakeTrack = {
        label: "Fake Input",
        stopped: false,
        getSettings: () => ({deviceId, channelCount: 2, latency: 0.005}) as MediaTrackSettings,
        stop() {track.stopped = true}
    }
    tracks.push(track)
    return {getAudioTracks: () => [track]}
}

// `AudioDevices.requestStream` goes through `navigator.mediaDevices`; nothing else in these tests does.
// The counter tells a reused stream from a re-opened one: every re-open is one more `getUserMedia`.
const installFakeMediaDevices = (deviceId: string): {calls: int, tracks: Array<FakeTrack>} => {
    const counter = {calls: 0, tracks: new Array<FakeTrack>()}
    Reflect.set(globalThis, "navigator", {
        mediaDevices: {
            getUserMedia: async () => {
                counter.calls++
                return createFakeStream(deviceId, counter.tracks)
            },
            enumerateDevices: async () => []
        }
    })
    return counter
}

const createFakeRecordingWorklet = () => ({
    uuid: UUID.generate(),
    terminated: false,
    set bpm(_: number) {},
    set sampleService(_: unknown) {},
    terminate(): void {this.terminated = true}
})

const setup = async ({state = "running", resumesTo = "running", deviceId = "fake-device"}:
                     {state?: AudioContextState, resumesTo?: AudioContextState, deviceId?: string} = {}) => {
    const getUserMediaCounter = installFakeMediaDevices(deviceId)
    const {Project} = await import("../project/Project")
    const {CaptureAudio} = await import("./CaptureAudio")
    const destination = createFakeNode()
    const createdSourceNodes = new Array<FakeNode>()
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
        destination,
        createGain: () => createFakeNode(),
        createStereoPanner: () => createFakeNode(),
        createMediaStreamSource: () => {
            const sourceNode = createFakeNode()
            createdSourceNodes.push(sourceNode)
            return sourceNode
        }
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
    const getUserMediaCalls = (): int => getUserMediaCounter.calls
    const openedTracks = (): ReadonlyArray<FakeTrack> => getUserMediaCounter.tracks
    return {
        capture, project, audioContext, preparedWorklets, removedFromSampleManager, recordGainNode,
        destination, createdSourceNodes, getUserMediaCalls, openedTracks
    }
}

// Arming requests the stream from the fake `getUserMedia`, which settles in microtasks, so the audio
// chain is there after flushing them.
const armAndAwaitChain = async (capture: Awaited<ReturnType<typeof setup>>["capture"]): Promise<void> => {
    capture.armed.setValue(true)
    for (let attempt = 0; attempt < 100 && capture.outputNode.isEmpty(); attempt++) {await Promise.resolve()}
    expect(capture.outputNode.nonEmpty()).toBe(true)
}

// The stream generator runs off an observable subscription, so a change made through the box settles a
// few microtasks later with nothing to await from the caller's side.
const flushMicrotasks = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {await Promise.resolve()}
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

    describe("keeping the input path pulled", () => {
        it("connects the source to a silent sink on the destination while the chain exists", async () => {
            const {capture, createdSourceNodes, destination} = await setup()
            await armAndAwaitChain(capture)
            expect(createdSourceNodes.length).toBe(1)
            expect(keepAliveSinkOf(createdSourceNodes[0]).connected).toContain(destination)
        })

        it("disconnects the silent sink when the chain is destroyed", async () => {
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            const sink = keepAliveSinkOf(createdSourceNodes[0])
            capture.armed.setValue(false)
            expect(capture.outputNode).toEqual(Option.None)
            expect(sink.disconnected).toEqual([undefined]) // a bare disconnect drops every edge
        })

        it("tears the chain down and releases the stream when the capture is terminated", async () => {
            const {capture, createdSourceNodes, openedTracks} = await setup()
            await armAndAwaitChain(capture)
            const sink = keepAliveSinkOf(createdSourceNodes[0])
            expect(openedTracks().length).toBe(1)
            // A terminated capture is gone for good (project switch, audio unit removed); leaving the
            // sink on the destination would render its source every quantum for the life of the page.
            capture.terminate()
            expect(capture.outputNode).toEqual(Option.None)
            expect(sink.disconnected).toEqual([undefined]) // a bare disconnect drops every edge
            expect(openedTracks()[0].stopped).toBe(true)
        })

        it("leaves the silent sink in place while monitoring is switched on and off", async () => {
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            const sourceNode = createdSourceNodes[0]
            const sink = keepAliveSinkOf(sourceNode)
            capture.monitoringMode = "direct"
            capture.monitoringMode = "off"
            expect(sink.disconnected).toEqual([])
            expect(sourceNode.disconnected).not.toContain(sink)
            expect(sourceNode.disconnected).not.toContain(undefined)
            expect(sourceNode.connected.filter(target => target === sink).length).toBe(1)
        })

        it("prepares a recording with the sink on the chain the recording uses", async () => {
            const {capture, createdSourceNodes, destination, preparedWorklets} = await setup()
            await armAndAwaitChain(capture)
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(preparedWorklets.length).toBe(1)
            const newestSourceNode = createdSourceNodes[createdSourceNodes.length - 1]
            expect(keepAliveSinkOf(newestSourceNode).connected).toContain(destination)
        })
    })

    describe("reusing the audio chain across recordings", () => {
        it("keeps the chain of a capture whose box names no device", async () => {
            const {capture, createdSourceNodes, getUserMediaCalls} = await setup()
            await armAndAwaitChain(capture)
            const sourceNode = createdSourceNodes[0]
            const callsWhileArming = getUserMediaCalls()
            await capture.prepareRecording()
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            expect(createdSourceNodes).toEqual([sourceNode])
        })

        it("re-opens when the box names a device the open stream does not report", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls} =
                await setup({deviceId: "reported-device"})
            await armAndAwaitChain(capture)
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("named-device")))
            await flushMicrotasks()
            const callsBefore = getUserMediaCalls()
            const nodesBefore = createdSourceNodes.length
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsBefore + 1)
            expect(createdSourceNodes.length).toBe(nodesBefore + 1)
        })

        it("keeps the chain when the box names the device the open stream reports", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls} = await setup({deviceId: "mic-a"})
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("mic-a")))
            await armAndAwaitChain(capture)
            const sourceNode = createdSourceNodes[0]
            const callsWhileArming = getUserMediaCalls()
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            expect(createdSourceNodes).toEqual([sourceNode])
        })

        it("rebuilds the chain on the open stream when the channel count changes", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls} = await setup()
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            project.editing.modify(() => {capture.requestChannels = 1})
            expect(createdSourceNodes.length).toBe(2)
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            expect(capture.effectiveChannelCount).toBe(1)
        })

        it("re-opens the stream when the device is changed through the box while armed", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls} = await setup()
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("other-device")))
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(callsWhileArming + 1)
            expect(createdSourceNodes.length).toBe(2)
        })

        it("re-opens the stream when a named device is cleared back to the default", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls} = await setup({deviceId: "mic-a"})
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("mic-a")))
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            project.editing.modify(() => capture.deviceId.setValue(Option.None))
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(callsWhileArming + 1)
            expect(createdSourceNodes.length).toBe(2)
        })
    })
})
