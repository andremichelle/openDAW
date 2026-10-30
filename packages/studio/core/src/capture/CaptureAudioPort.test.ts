import {describe, expect, it, vi} from "vitest"
import {isDefined, Option, Provider, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {CaptureAudioBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {CaptureDevices} from "./CaptureDevices"
import type {AudioInputPort, AudioInputRequest, MonitoringMode, MonitorPort, RecordingLatency} from "../io"

// CaptureAudio holds the arm state and the box settings and talks to its input only through the port.
// A fake port records every call, so these tests run without Web Audio.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createFakeMonitor = (): MonitorPort => ({
    mode: "off" as MonitoringMode,
    volumeDb: 0.0,
    pan: 0.0,
    muted: false,
    outputDeviceId: Option.None,
    setOutputDevice: () => Promise.resolve(),
    terminate: () => {}
})

const createFakeInput = (request: Provider<Option<AudioInputRequest>>) => {
    const calls = new Array<string>()
    const opened = new Array<Option<AudioInputRequest>>()
    let gainDb = 0.0
    const input: AudioInputPort & { calls: Array<string>, opened: Array<Option<AudioInputRequest>>, gain: () => number } = {
        calls, opened, gain: () => gainDb,
        monitor: createFakeMonitor(),
        nodes: Option.None,
        deviceId: Option.wrap("fake"),
        label: Option.wrap("Fake Input"),
        channelCount: 2,
        set gainDb(value: number) {gainDb = value},
        open: async () => {
            calls.push("open")
            opened.push(request())
        },
        rechannel: () => {calls.push(`rechannel ${request().mapOr(({channels}) => channels.mapOr(count => count, 0), -1)}`)},
        close: () => {calls.push("close")},
        prepareRecording: async open => {
            calls.push("prepare")
            await open()
        },
        takeRecording: () => {
            calls.push("take")
            return Option.wrap({
                uuid: UUID.generate(), firstQuantumTime: Option.None, numberOfFrames: 0,
                limit: () => {}, setFillLength: () => {}, set onSaved(_: () => void) {},
                disconnect: () => {}, terminate: () => {}
            })
        },
        readLatency: (resolveInput: (outputLatency: number) => number, calibrated: boolean): Provider<RecordingLatency> => {
            calls.push(`latency ${calibrated ? "calibrated" : "reported"}`)
            return () => ({outputLatency: 0.02, inputLatency: resolveInput(0.02)})
        },
        measureRoundTrip: async () => {
            calls.push("measure")
            return {verdict: "ok", seconds: 0.0186, spreadSeconds: 0.0, heard: 3, bursts: 3}
        },
        roundTrip: Option.None,
        forgetRoundTrip: () => {calls.push("forget")},
        subscribeRoundTrip: () => Terminable.Empty,
        terminate: () => {calls.push("terminate")}
    }
    return input
}

const setup = async () => {
    const {Project} = await import("../project/Project")
    const {CaptureAudio} = await import("./CaptureAudio")
    // the project's own capture devices build a browser input for the box as well
    const node = () => ({connect: () => {}, disconnect: () => {}, gain: {value: 0}, pan: {value: 0}})
    const env = {
        audioContext: {createGain: node, createStereoPanner: node, sampleRate: 48_000},
        sampleManager: {record: () => {}, remove: () => {}}
    } as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    const captureBox = project.editing.modify(() => {
        const box = CaptureAudioBox.create(project.boxGraph, UUID.generate())
        primaryAudioUnitBox.capture.refer(box)
        return box
    }).unwrap()
    let input = createFakeInput(() => Option.None)
    const capture = new CaptureAudio({project} as unknown as CaptureDevices, primaryAudioUnitBox, captureBox,
        request => input = createFakeInput(request))
    const settle = async () => {for (let index = 0; index < 20; index++) {await Promise.resolve()}}
    return {project, capture, input: () => input, settle}
}

describe("CaptureAudio on its input port", () => {
    it("opens the input when armed and closes it when disarmed", async () => {
        const {capture, input, settle} = await setup()
        capture.armed.setValue(true)
        await settle()
        capture.armed.setValue(false)
        // the first close is the catch-up of the unarmed state at construction
        expect(input().calls.filter(call => call === "open" || call === "close")).toEqual(["close", "open", "close"])
    })

    it("asks for the device and the channels of the box", async () => {
        const {project, capture, input, settle} = await setup()
        project.editing.modify(() => {
            capture.deviceId.setValue(Option.wrap("mic"))
            capture.requestChannels = 1
        })
        capture.armed.setValue(true)
        await settle()
        const request = input().opened.at(-1)?.unwrap()
        expect(request?.deviceId.unwrap()).toBe("mic")
        expect(request?.channels.unwrap()).toBe(1)
    })

    it("asks for nothing while disarmed or once terminated", async () => {
        const {capture, input, settle} = await setup()
        capture.armed.setValue(true)
        await settle()
        const port = input()
        capture.terminate()
        expect(port.calls).toContain("terminate")
        expect(port.opened.at(-1)?.nonEmpty()).toBe(true)
    })

    it("rebuilds with the new channel count", async () => {
        const {project, capture, input, settle} = await setup()
        capture.armed.setValue(true)
        await settle()
        project.editing.modify(() => {capture.requestChannels = 1})
        expect(input().calls.at(-1)).toBe("rechannel 1")
    })

    it("passes the record gain on", async () => {
        const {project, capture, input} = await setup()
        project.editing.modify(() => capture.captureBox.gainDb.setValue(-6.0))
        expect(input().gain()).toBe(-6.0)
    })

    it("arms when monitoring is switched on", async () => {
        const {capture, input} = await setup()
        capture.monitoringMode = "direct"
        expect(capture.armed.getValue()).toBe(true)
        expect(input().monitor.mode).toBe("direct")
        expect(capture.isMonitoring).toBe(true)
    })

    it("prepares through the port with its own sequenced open", async () => {
        const {capture, input, settle} = await setup()
        capture.armed.setValue(true)
        await settle()
        await capture.prepareRecording()
        expect(input().calls.slice(-2)).toEqual(["prepare", "open"])
    })

    it("asks for the calibrated latency unless the track overrides its input latency", async () => {
        const {project, capture, input} = await setup()
        capture.startRecording().terminate()
        expect(input().calls.at(-1)).toBe("latency calibrated")
        project.editing.modify(() => capture.captureBox.inputLatency.setValue(0.01))
        capture.startRecording().terminate()
        expect(input().calls.at(-1)).toBe("latency reported")
    })

    it("arms the input before measuring the round trip", async () => {
        const {capture, input} = await setup()
        const result = await capture.measureRoundTrip()
        expect(capture.armed.getValue()).toBe(true)
        expect(input().calls.slice(-2)).toEqual(["open", "measure"])
        expect(result.seconds).toBe(0.0186)
    })

    it("forgets the round trip through the port", async () => {
        const {capture, input} = await setup()
        capture.forgetRoundTrip()
        expect(input().calls.at(-1)).toBe("forget")
    })

    it("refuses to measure while the transport runs", async () => {
        const {capture, input} = await setup()
        vi.spyOn(capture.manager.project.engine.isPlaying, "getValue").mockReturnValue(true)
        await expect(capture.measureRoundTrip()).rejects.toBeDefined()
        expect(input().calls).not.toContain("measure")
    })

    it("reads the device from the port", async () => {
        const {capture} = await setup()
        expect(capture.label).toBe("Fake Input")
        expect(capture.streamDeviceId.unwrap()).toBe("fake")
        expect(capture.effectiveChannelCount).toBe(2)
        expect(capture.outputNode.isEmpty()).toBe(true)
    })
})
