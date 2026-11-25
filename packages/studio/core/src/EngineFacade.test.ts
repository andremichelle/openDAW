import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Terminable, UUID} from "@opendaw/lib-std"
import {EngineFacade} from "./EngineFacade"
import type {EngineWorklet} from "./EngineWorklet"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

// records every transport call the facade forwards to the engine
const createFakeWorklet = () => {
    const calls: Array<string> = []
    const worklet = {
        calls,
        playbackTimestamp: new DefaultObservableValue(0),
        countInBeatsRemaining: new DefaultObservableValue(0),
        compensationLatency: new DefaultObservableValue(0),
        compensationExceeded: new DefaultObservableValue(false),
        position: new DefaultObservableValue(0),
        bpm: new DefaultObservableValue(120),
        isPlaying: new DefaultObservableValue(false),
        isRecording: new DefaultObservableValue(false),
        isCountingIn: new DefaultObservableValue(false),
        markerState: new DefaultObservableValue(null),
        cpuLoad: new DefaultObservableValue(0),
        recordingStart: new MutableObservableOption(),
        subscribeTransportAnchors: () => Terminable.Empty,
        preferences: {update: () => {}, subscribeAll: () => Terminable.Empty},
        context: {state: "running"},
        play: () => calls.push("play"),
        stop: (reset: boolean) => calls.push(`stop:${reset}`),
        setPosition: (position: number) => calls.push(`position:${position}`),
        prepareRecordingState: (countIn: boolean) => calls.push(`record:${countIn}`),
        stopRecording: () => calls.push("stopRecording"),
        scheduleClipPlay: () => calls.push("clipPlay"),
        scheduleClipStop: () => calls.push("clipStop"),
        panic: () => calls.push("panic"),
        terminate: () => {}
    }
    return worklet
}

const createFacade = () => {
    const facade = new EngineFacade()
    const worklet = createFakeWorklet()
    facade.setWorklet(worklet as unknown as EngineWorklet)
    return {facade, worklet}
}

const driveEverything = (facade: EngineFacade) => {
    facade.play()
    facade.stop(true)
    facade.setPosition(960)
    facade.prepareRecordingState(true)
    facade.scheduleClipPlay([UUID.generate()])
    facade.scheduleClipStop([UUID.generate()])
}

describe("EngineFacade transport lock", () => {
    it("forwards every transport call while unlocked", () => {
        const {facade, worklet} = createFacade()
        driveEverything(facade)
        expect(worklet.calls).toEqual(["play", "stop:true", "position:960", "record:true", "clipPlay", "clipStop"])
        expect(facade.transportLocked.getValue()).toBe(false)
    })
    it("ignores every transport call while locked", () => {
        const {facade, worklet} = createFacade()
        const lock = facade.lockTransport()
        expect(facade.transportLocked.getValue()).toBe(true)
        driveEverything(facade)
        expect(worklet.calls).toEqual([])
        lock.terminate()
    })
    it("lets only the lock drive the transport", () => {
        const {facade, worklet} = createFacade()
        const lock = facade.lockTransport()
        lock.setPosition(1920)
        lock.play()
        lock.stop()
        lock.stop(true)
        expect(worklet.calls).toEqual(["position:1920", "play", "stop:false", "stop:true"])
        lock.terminate()
    })
    it("keeps the safety exits open while locked", () => {
        const {facade, worklet} = createFacade()
        const lock = facade.lockTransport()
        facade.stopRecording()
        facade.panic()
        expect(worklet.calls).toEqual(["stopRecording", "panic"])
        lock.terminate()
    })
    it("gives control back on release and disarms the released lock", () => {
        const {facade, worklet} = createFacade()
        const lock = facade.lockTransport()
        lock.terminate()
        expect(facade.transportLocked.getValue()).toBe(false)
        lock.play()
        expect(worklet.calls).toEqual([])
        facade.play()
        expect(worklet.calls).toEqual(["play"])
    })
    it("notifies observers when the lock changes", () => {
        const {facade} = createFacade()
        const states: Array<boolean> = []
        facade.transportLocked.subscribe(owner => states.push(owner.getValue()))
        const lock = facade.lockTransport()
        lock.terminate()
        lock.terminate()
        expect(states).toEqual([true, false])
    })
    it("refuses a second lock while one is held", () => {
        const {facade} = createFacade()
        const lock = facade.lockTransport()
        expect(() => facade.lockTransport()).toThrow()
        lock.terminate()
        facade.lockTransport().terminate()
    })
    it("survives an engine restart", () => {
        const {facade} = createFacade()
        const lock = facade.lockTransport()
        const next = createFakeWorklet()
        facade.setWorklet(next as unknown as EngineWorklet)
        facade.play()
        lock.play()
        expect(next.calls).toEqual(["play"])
        lock.terminate()
    })
    it("old locks cannot release a newer lock", () => {
        const {facade} = createFacade()
        const first = facade.lockTransport()
        first.terminate()
        const second = facade.lockTransport()
        first.terminate()
        expect(facade.transportLocked.getValue()).toBe(true)
        second.terminate()
    })
})
