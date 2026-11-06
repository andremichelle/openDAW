import {describe, expect, it, vi} from "vitest"
import {int, isDefined, Option, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {CaptureAudioBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {CaptureDevices} from "./CaptureDevices"
import type {RecordingWorklet} from "../RecordingWorklet"
import {ChannelMapping} from "../io/ChannelMapping"

// A recording is placed from reports the audio thread sends while rendering, so a capture may only be
// prepared on a running context. These tests drive `prepareRecording` against contexts that are
// running, that resume on demand, and that stay suspended.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

type FakeNode = {
    connect: (target: unknown, output?: int, input?: int) => void
    disconnect: (target?: unknown) => void
    connected: Array<unknown>
    routes: Array<{target: unknown, output: int, input: int}>
    disconnected: Array<unknown>
    gain: {value: number}
    pan: {value: number}
    channelCount: number
    channelCountMode: string
    channelInterpretation: string
}

const createFakeNode = (): FakeNode => ({
    connect(target: unknown, output: int = 0, input: int = 0) {
        this.connected.push(target)
        this.routes.push({target, output, input})
    },
    disconnect(target?: unknown) {this.disconnected.push(target)},
    connected: new Array<unknown>(),
    routes: new Array<{target: unknown, output: int, input: int}>(),
    disconnected: new Array<unknown>(),
    gain: {value: 0},
    pan: {value: 0},
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers"
})

// The audio chain's silent sink is the only node the source is connected to that has its gain at zero:
// the record gain and the monitor gain both sit at unity while the chain is built.
const keepAliveSinkOf = (sourceNode: FakeNode): FakeNode => {
    const sinks = sourceNode.connected.filter(target => (target as FakeNode).gain?.value === 0) as Array<FakeNode>
    expect(sinks.length).toBe(1)
    return sinks[0]
}

type FakeTrack = {
    label: string, stopped: boolean, readyState: MediaStreamTrackState,
    getSettings: () => MediaTrackSettings, stop: () => void
}

// One track object per stream, kept across `getAudioTracks()` calls so `stop()` is observable.
const createFakeStream = (deviceId: string, tracks: Array<FakeTrack>, channelCount: int) => {
    const track: FakeTrack = {
        label: "Fake Input",
        stopped: false,
        readyState: "live",
        getSettings: () => ({deviceId, channelCount, latency: 0.005}) as MediaTrackSettings,
        stop() {
            track.stopped = true
            track.readyState = "ended"
        }
    }
    tracks.push(track)
    return {getAudioTracks: () => [track]}
}

type FakeHold = {resolve: () => void, reject: (reason: Error) => void}
type FakeMediaDevices = {
    calls: int, tracks: Array<FakeTrack>, holds: Array<FakeHold>, constraints: Array<MediaTrackConstraints>
}

// `AudioDevices.requestStream` goes through `navigator.mediaDevices`; nothing else in these tests does.
// The counter tells a reused stream from a re-opened one: every re-open is one more `getUserMedia`.
// A held `getUserMedia` settles only once its hold is released or rejected, so a test can act while it is pending.
const installFakeMediaDevices = (deviceId: string, holdStreams: boolean, channelCount: int): FakeMediaDevices => {
    const devices: FakeMediaDevices = {calls: 0, tracks: new Array<FakeTrack>(), holds: [], constraints: []}
    Reflect.set(globalThis, "navigator", {
        mediaDevices: {
            getUserMedia: async ({audio}: {audio: MediaTrackConstraints}) => {
                devices.calls++
                devices.constraints.push(audio)
                if (holdStreams) {await new Promise<void>((resolve, reject) => devices.holds.push({resolve, reject}))}
                return createFakeStream(deviceId, devices.tracks, channelCount)
            },
            enumerateDevices: async () => []
        }
    })
    return devices
}

const createFakeRecordingWorklet = () => ({
    uuid: UUID.generate(),
    terminated: false,
    set bpm(_: number) {},
    set sampleService(_: unknown) {},
    terminate(): void {this.terminated = true}
})

const setup = async ({
                         state = "running", resumesTo = "running", deviceId = "fake-device", holdStreams = false,
                         channelCount = 2
                     }: {
    state?: AudioContextState, resumesTo?: AudioContextState, deviceId?: string, holdStreams?: boolean,
    channelCount?: int
} = {}) => {
    const mediaDevices = installFakeMediaDevices(deviceId, holdStreams, channelCount)
    const {Project} = await import("../project/Project")
    const {CaptureAudio} = await import("./CaptureAudio")
    const destination = createFakeNode()
    const createdSourceNodes = new Array<FakeNode>()
    const createdSplitters = new Array<FakeNode & {numberOfOutputs: int}>()
    const createdMergers = new Array<FakeNode>()
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
        createChannelSplitter: (numberOfOutputs: int) => {
            const splitter = {...createFakeNode(), numberOfOutputs}
            createdSplitters.push(splitter)
            return splitter
        },
        createChannelMerger: () => {
            const merger = createFakeNode()
            createdMergers.push(merger)
            return merger
        },
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
    const getUserMediaCalls = (): int => mediaDevices.calls
    const openedTracks = (): ReadonlyArray<FakeTrack> => mediaDevices.tracks
    const requestedChannels = (): Array<unknown> => mediaDevices.constraints.map(({channelCount}) => channelCount)
    const releaseStreams = (): void => mediaDevices.holds.splice(0).forEach(hold => hold.resolve())
    const rejectStreams = (): void =>
        mediaDevices.holds.splice(0).forEach(hold => hold.reject(new Error("NotFoundError")))
    return {
        capture, project, audioContext, preparedWorklets, removedFromSampleManager, recordGainNode,
        destination, createdSourceNodes, getUserMediaCalls, openedTracks, releaseStreams, rejectStreams,
        createdSplitters, createdMergers, requestedChannels, captureBox, primaryAudioUnitBox, manager
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
            capture.armed.setValue(true)
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(audioContext.resumeCalls).toBe(0)
            expect(preparedWorklets.length).toBe(1)
            expect(preparedWorklets[0].terminated).toBe(false)
        })

        it("resumes a suspended context and prepares once it is running", async () => {
            const {capture, audioContext, preparedWorklets} = await setup({state: "suspended"})
            capture.armed.setValue(true)
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
            capture.armed.setValue(true)
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

        it("opens no stream for a capture that is not armed", async () => {
            const {capture, preparedWorklets, getUserMediaCalls} = await setup()
            await expect(capture.prepareRecording()).rejects.toBeDefined()
            expect(getUserMediaCalls()).toBe(0)
            expect(preparedWorklets.length).toBe(0)
        })
    })

    describe("monitoring with effects", () => {
        // issue #461: the engine splits the registered node discretely, so a raw stereo source kept only the left input
        it("registers a speakers mixdown, not the raw source, when mono is forced", async () => {
            const {capture, project, createdSourceNodes} = await setup()
            const register = vi.spyOn(project.engine, "registerMonitoringSource")
            project.editing.modify(() => {capture.requestChannels = 1})
            capture.monitoringMode = "effects"
            await armAndAwaitChain(capture)
            const [, node, numChannels] = register.mock.lastCall ?? []
            const mixdown = node as unknown as FakeNode
            expect(numChannels).toBe(1)
            expect(mixdown).not.toBe(createdSourceNodes.at(-1))
            expect(createdSourceNodes.at(-1)?.connected).toContain(mixdown)
            expect(mixdown.channelCount).toBe(1)
            expect(mixdown.channelCountMode).toBe("explicit")
            expect(mixdown.channelInterpretation).toBe("speakers")
            expect(mixdown.gain.value).toBe(1)
        })

        it("registers a stereo mixdown at unity gain for a stereo capture", async () => {
            const {capture, project} = await setup()
            const register = vi.spyOn(project.engine, "registerMonitoringSource")
            capture.monitoringMode = "effects"
            await armAndAwaitChain(capture)
            const [, node, numChannels] = register.mock.lastCall ?? []
            const mixdown = node as unknown as FakeNode
            expect(numChannels).toBe(2)
            expect(mixdown.channelCount).toBe(2)
            expect(mixdown.gain.value).toBe(1)
        })
    })

    describe("starting a recording", () => {
        it("discards the prepared worklet when the audio chain is gone", async () => {
            const {capture, preparedWorklets, removedFromSampleManager} = await setup()
            capture.armed.setValue(true)
            await capture.prepareRecording()
            const worklet = preparedWorklets[0]
            capture.armed.setValue(false) // tears the audio chain down behind the prepared worklet
            expect(capture.outputNode).toEqual(Option.None)
            expect(capture.startRecording()).toBeDefined()
            expect(worklet.terminated).toBe(true)
            expect(removedFromSampleManager).toEqual([worklet.uuid])
        })

        it("discards the prepared worklet when the capture is terminated", async () => {
            const {capture, preparedWorklets, removedFromSampleManager} = await setup()
            capture.armed.setValue(true)
            await capture.prepareRecording()
            const worklet = preparedWorklets[0]
            capture.terminate()
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

        it("stops a stream that arrives after the capture was terminated, without building a chain", async () => {
            const {capture, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true})
            capture.armed.setValue(true)
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            expect(openedTracks().length).toBe(0)
            capture.terminate()
            releaseStreams()
            await flushMicrotasks()
            expect(openedTracks().length).toBe(1)
            expect(openedTracks()[0].stopped).toBe(true)
            expect(createdSourceNodes.length).toBe(0)
            expect(capture.outputNode).toEqual(Option.None)
            expect(capture.stream.isEmpty()).toBe(true)
        })

        it("stops a stream that arrives after disarming, without building a chain", async () => {
            const {capture, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true})
            capture.armed.setValue(true)
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            capture.armed.setValue(false)
            releaseStreams()
            await flushMicrotasks()
            expect(openedTracks().length).toBe(1)
            expect(openedTracks()[0].stopped).toBe(true)
            expect(createdSourceNodes.length).toBe(0)
            expect(capture.outputNode).toEqual(Option.None)
            expect(capture.stream.isEmpty()).toBe(true)
        })

        it("requests no stream for an update queued before the capture was terminated", async () => {
            const {capture, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true})
            capture.armed.setValue(true)
            await flushMicrotasks()
            capture.armed.setValue(false)
            capture.armed.setValue(true) // queued behind the pending request
            capture.terminate()
            releaseStreams()
            await flushMicrotasks()
            releaseStreams()
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            expect(openedTracks().map(track => track.stopped)).toEqual([true])
            expect(createdSourceNodes.length).toBe(0)
            expect(capture.stream.isEmpty()).toBe(true)
        })

        it("requests no stream for a device change queued before the capture was disarmed", async () => {
            const {capture, project, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true})
            capture.armed.setValue(true)
            await flushMicrotasks()
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("other-device")))
            await flushMicrotasks() // queued behind the pending request
            capture.armed.setValue(false)
            releaseStreams()
            await flushMicrotasks()
            releaseStreams()
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            expect(openedTracks().map(track => track.stopped)).toEqual([true])
            expect(createdSourceNodes.length).toBe(0)
            expect(capture.stream.isEmpty()).toBe(true)
        })

        it("discards a stream whose device was changed while its request was pending", async () => {
            const {capture, project, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true, deviceId: "other-device"})
            capture.armed.setValue(true)
            await flushMicrotasks()
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("other-device")))
            await flushMicrotasks() // queued behind the pending request
            releaseStreams()
            await flushMicrotasks()
            releaseStreams()
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(2)
            expect(openedTracks().map(track => track.stopped)).toEqual([true, false])
            expect(createdSourceNodes.length).toBe(1) // the stale stream never became a chain
            expect(capture.outputNode.nonEmpty()).toBe(true)
        })

        it("falls back to the default input when the named device is unavailable", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls, releaseStreams, rejectStreams} =
                await setup({holdStreams: true})
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("unplugged-device")))
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            capture.armed.setValue(true)
            await flushMicrotasks()
            rejectStreams()
            await flushMicrotasks()
            releaseStreams()
            await flushMicrotasks()
            warn.mockRestore()
            expect(getUserMediaCalls()).toBe(2)
            expect(createdSourceNodes.length).toBe(1)
            expect(capture.outputNode.nonEmpty()).toBe(true)
        })

        it("requests no fallback for a named device that fails after the capture was disarmed", async () => {
            const {capture, project, createdSourceNodes, getUserMediaCalls, rejectStreams} =
                await setup({holdStreams: true})
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("unplugged-device")))
            capture.armed.setValue(true)
            await flushMicrotasks()
            capture.armed.setValue(false)
            rejectStreams()
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            expect(createdSourceNodes.length).toBe(0)
            expect(capture.stream.isEmpty()).toBe(true)
        })

        it("keeps the stream of a request that was pending across a disarm and re-arm", async () => {
            const {capture, createdSourceNodes, openedTracks, getUserMediaCalls, releaseStreams} =
                await setup({holdStreams: true})
            capture.armed.setValue(true)
            await flushMicrotasks()
            capture.armed.setValue(false)
            capture.armed.setValue(true) // queued behind the pending request, which it then reuses
            releaseStreams()
            await flushMicrotasks()
            releaseStreams()
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(1)
            expect(openedTracks().map(track => track.stopped)).toEqual([false])
            expect(createdSourceNodes.length).toBe(1)
            expect(capture.outputNode.nonEmpty()).toBe(true)
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

    // A stream stays open across recordings. A live source node reads about 24 ms late for good after another
    // stream opened or closed on the device, so it is replaced shortly after, never while a take records from it.
    describe("reusing the stream across recordings", () => {
        it("keeps the stream of a capture whose box names no device", async () => {
            const {capture, getUserMediaCalls, openedTracks} = await setup()
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            await capture.prepareRecording()
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            expect(openedTracks().map(track => track.stopped)).toEqual([false])
        })

        it("keeps the source node across recordings", async () => {
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            await capture.prepareRecording()
            await capture.prepareRecording()
            expect(createdSourceNodes.length).toBe(1)
        })

        it("builds a fresh source node on the open stream shortly after another stream opened", async () => {
            vi.useFakeTimers()
            const {capture, createdSourceNodes, getUserMediaCalls} = await setup()
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            const {AudioDevices} = await import("../AudioDevices")
            AudioDevices.notifyStreamsChanged()
            expect(createdSourceNodes.length).toBe(1)
            vi.advanceTimersByTime(300)
            expect(createdSourceNodes.length).toBe(2)
            expect(createdSourceNodes[0].disconnected).toContain(undefined)
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            vi.useRealTimers()
        })

        // A meter connected to the output node must follow the fresh chain, or it keeps reading the discarded node
        it("tells output node subscribers about the fresh chain", async () => {
            vi.useFakeTimers()
            const {capture} = await setup()
            await armAndAwaitChain(capture)
            const before = capture.outputNode.unwrap()
            const seen: Array<Option<AudioNode>> = []
            const subscription = capture.subscribeOutputNode(node => seen.push(node))
            const {AudioDevices} = await import("../AudioDevices")
            AudioDevices.notifyStreamsChanged()
            vi.advanceTimersByTime(300)
            const after = capture.outputNode.unwrap()
            expect(after).not.toBe(before)
            expect(seen.map(node => node.unwrapOrNull())).toEqual([null, after])
            subscription.terminate()
            vi.useRealTimers()
        })

        it("tells output node subscribers about a rechanneled chain", async () => {
            const {capture} = await setup()
            await armAndAwaitChain(capture)
            const seen: Array<Option<AudioNode>> = []
            const subscription = capture.subscribeOutputNode(node => seen.push(node))
            capture.input.rechannel()
            expect(seen.map(node => node.unwrapOrNull())).toEqual([null, capture.outputNode.unwrap()])
            subscription.terminate()
        })

        it("waits for the take to end before it builds the fresh source node", async () => {
            vi.useFakeTimers()
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            await capture.prepareRecording()
            const sink = capture.input.takeRecording().unwrap()
            const {AudioDevices} = await import("../AudioDevices")
            AudioDevices.notifyStreamsChanged()
            vi.advanceTimersByTime(300)
            expect(createdSourceNodes.length).toBe(1)
            sink.disconnect()
            vi.advanceTimersByTime(300)
            expect(createdSourceNodes.length).toBe(2)
            vi.useRealTimers()
        })

        it("ignores the streams it opens itself", async () => {
            vi.useFakeTimers()
            const {capture, createdSourceNodes} = await setup()
            capture.armed.setValue(true)
            for (let attempt = 0; attempt < 100 && capture.outputNode.isEmpty(); attempt++) {await Promise.resolve()}
            vi.advanceTimersByTime(300)
            expect(createdSourceNodes.length).toBe(1)
            vi.useRealTimers()
        })

        it("re-opens when the open track has ended, even though nothing else changed", async () => {
            const {capture, createdSourceNodes, getUserMediaCalls, openedTracks} = await setup()
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            openedTracks()[0].readyState = "ended" // the device was unplugged
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsWhileArming + 1)
            expect(openedTracks().length).toBe(2)
            expect(createdSourceNodes.length).toBe(2)
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

        it("keeps the stream when the box names the device the open stream reports", async () => {
            const {capture, project, getUserMediaCalls, openedTracks} = await setup({deviceId: "mic-a"})
            project.editing.modify(() => capture.deviceId.setValue(Option.wrap("mic-a")))
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            await capture.prepareRecording()
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            expect(openedTracks().map(track => track.stopped)).toEqual([false])
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

    // issue #519: Bitwig-like channel mapping, a stereo pair or a single input of the device
    describe("channel mapping", () => {
        const fields = (captureBox: CaptureAudioBox): Array<int> =>
            [captureBox.requestChannels.getValue(), captureBox.leftInputs.getValue(), captureBox.rightInputs.getValue()]

        it("feeds recording and monitoring from the second input alone for Mono 2", async () => {
            const {capture, project, captureBox, createdSourceNodes, createdSplitters, createdMergers, recordGainNode,
                getUserMediaCalls} = await setup()
            const register = vi.spyOn(project.engine, "registerMonitoringSource")
            capture.monitoringMode = "effects"
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.mono(1)})
            await flushMicrotasks()
            expect(fields(captureBox)).toEqual([1, 0b10, 0])
            expect(getUserMediaCalls()).toBe(callsWhileArming)
            const splitter = Option.wrap(createdSplitters.at(-1)).unwrap()
            expect(splitter.numberOfOutputs).toBe(2)
            expect(createdSourceNodes.at(-1)?.connected).toContain(splitter)
            expect(createdSourceNodes.at(-1)?.connected).not.toContain(recordGainNode())
            expect(splitter.routes.map(({output, input}) => [output, input])).toEqual([[1, 0]])
            const side = splitter.routes[0].target as FakeNode
            expect(side.channelCount).toBe(1)
            expect(side.gain.value).toBe(1)
            expect(side.connected).toContain(recordGainNode())
            const [, node, numChannels] = register.mock.lastCall ?? []
            expect(side.connected).toContain(node)
            expect(numChannels).toBe(1)
            expect(createdMergers.length).toBe(0)
            expect(recordGainNode().channelCount).toBe(1)
            expect(capture.effectiveChannelCount).toBe(1)
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.mono(1))).toBe(true)
        })

        it("opens a single input as stereo, so the browser hands over the channels unmixed", async () => {
            const {capture, project, createdSplitters, requestedChannels} = await setup()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.mono(0)})
            await armAndAwaitChain(capture)
            expect(requestedChannels().at(-1)).toEqual({ideal: 2})
            const splitter = Option.wrap(createdSplitters.at(-1)).unwrap()
            expect(splitter.numberOfOutputs).toBe(1)
            expect(splitter.routes.map(({output}) => output)).toEqual([0])
            expect(capture.effectiveChannelCount).toBe(1)
        })

        it("re-opens a four-channel device for the pair 3/4 and merges it to left and right", async () => {
            const {capture, project, createdSplitters, createdMergers, recordGainNode, getUserMediaCalls,
                requestedChannels} = await setup({channelCount: 4})
            await armAndAwaitChain(capture)
            const callsWhileArming = getUserMediaCalls()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.stereo(2)})
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(callsWhileArming + 1)
            expect(requestedChannels().at(-1)).toEqual({ideal: 4})
            const splitter = Option.wrap(createdSplitters.at(-1)).unwrap()
            const merger = Option.wrap(createdMergers.at(-1)).unwrap()
            expect(splitter.numberOfOutputs).toBe(4)
            expect(splitter.routes.map(({output}) => output)).toEqual([2, 3])
            expect(splitter.routes.map(({target}) => (target as FakeNode).routes
                .find(route => route.target === merger)?.input)).toEqual([0, 1])
            expect(merger.connected).toContain(recordGainNode())
            expect(capture.effectiveChannelCount).toBe(2)
        })

        it("keeps the open stream when a re-chosen pair needs no more inputs than were asked for", async () => {
            const {capture, project, getUserMediaCalls} = await setup({channelCount: 4})
            await armAndAwaitChain(capture)
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.stereo(2)})
            await flushMicrotasks()
            const callsAfterPair = getUserMediaCalls()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.mono(3)})
            await flushMicrotasks()
            expect(getUserMediaCalls()).toBe(callsAfterPair)
        })

        it("falls back to the first input when the device lacks the mapped ones", async () => {
            const {capture, project, createdSplitters, createdMergers} = await setup()
            await armAndAwaitChain(capture)
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.stereo(2)})
            await flushMicrotasks()
            const splitter = Option.wrap(createdSplitters.at(-1)).unwrap()
            expect(splitter.numberOfOutputs).toBe(1)
            expect(splitter.routes.map(({output}) => output)).toEqual([0])
            expect(createdMergers.length).toBe(0)
            expect(capture.effectiveChannelCount).toBe(1)
        })

        it("stores Stereo 1/2 and Mono 1+2 Mixed as the channel count, with no splitter", async () => {
            const {capture, project, captureBox, createdSplitters} = await setup()
            await armAndAwaitChain(capture)
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.MonoMixed})
            expect(fields(captureBox)).toEqual([1, 0, 0])
            expect(capture.effectiveChannelCount).toBe(1)
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.MonoMixed)).toBe(true)
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.Stereo})
            expect(fields(captureBox)).toEqual([2, 0, 0])
            expect(capture.effectiveChannelCount).toBe(2)
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.Stereo)).toBe(true)
            expect(createdSplitters.length).toBe(0)
        })

        it("drops a mapping when the channel count is set directly", async () => {
            const {capture, project, captureBox} = await setup()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.mono(1)})
            project.editing.modify(() => {capture.requestChannels = 2})
            expect(fields(captureBox)).toEqual([2, 0, 0])
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.Stereo)).toBe(true)
        })

        it("undoes back to the previous mapping", async () => {
            const {capture, project, captureBox} = await setup()
            project.editing.modify(() => {capture.channelMapping = ChannelMapping.mono(1)})
            project.editing.undo()
            expect(fields(captureBox)).toEqual([2, 0, 0])
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.Stereo)).toBe(true)
        })

        it("reads a stored mapping when the capture is created", async () => {
            const {project, captureBox, primaryAudioUnitBox, manager} = await setup()
            const {CaptureAudio} = await import("./CaptureAudio")
            project.editing.modify(() => {
                captureBox.requestChannels.setValue(1)
                captureBox.leftInputs.setValue(0b10)
            })
            const capture = new CaptureAudio(manager, primaryAudioUnitBox, captureBox)
            expect(ChannelMapping.equals(capture.channelMapping, ChannelMapping.mono(1))).toBe(true)
            capture.terminate()
        })
    })
})
