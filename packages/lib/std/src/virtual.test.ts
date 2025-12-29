import {describe, expect, it, vi} from "vitest"
import {VirtualObject} from "./virtual"

type TestData = {
    metronome: {
        enabled: boolean
        gain: number
    }
    transport: {
        bpm: number
    }
}

const createTestData = (): TestData => ({
    metronome: {enabled: true, gain: 0.5},
    transport: {bpm: 120}
})

describe("VirtualObject", () => {
    describe("subscribe precision", () => {
        it("should NOT notify when sibling property changes", () => {
            const obj = new VirtualObject(createTestData())
            const enabledObserver = vi.fn()

            obj.subscribe(enabledObserver, "metronome", "enabled")
            obj.proxy.metronome.gain = 0.8

            expect(enabledObserver).not.toHaveBeenCalled()
        })

        it("should NOT notify when unrelated branch changes", () => {
            const obj = new VirtualObject(createTestData())
            const metronomeObserver = vi.fn()

            obj.subscribe(metronomeObserver, "metronome")
            obj.proxy.transport.bpm = 140

            expect(metronomeObserver).not.toHaveBeenCalled()
        })

        it("should notify exact path match", () => {
            const obj = new VirtualObject(createTestData())
            const gainObserver = vi.fn()

            obj.subscribe(gainObserver, "metronome", "gain")
            obj.proxy.metronome.gain = 0.8

            expect(gainObserver).toHaveBeenCalledTimes(1)
            expect(gainObserver).toHaveBeenCalledWith(0.8)
        })

        it("should notify parent when child changes", () => {
            const obj = new VirtualObject(createTestData())
            const metronomeObserver = vi.fn()

            obj.subscribe(metronomeObserver, "metronome")
            obj.proxy.metronome.gain = 0.8

            expect(metronomeObserver).toHaveBeenCalledTimes(1)
        })

        it("should notify child subscriber when parent path notified via update", () => {
            const obj = new VirtualObject(createTestData())
            const gainObserver = vi.fn()

            obj.subscribe(gainObserver, "metronome", "gain")
            obj.update({metronome: {enabled: false, gain: 0.3}, transport: {bpm: 120}})

            expect(gainObserver).toHaveBeenCalledTimes(1)
            expect(gainObserver).toHaveBeenCalledWith(0.3)
        })

        it("should notify only once per change even with multiple subscribers", () => {
            const obj = new VirtualObject(createTestData())
            const observer1 = vi.fn()
            const observer2 = vi.fn()

            obj.subscribe(observer1, "metronome", "gain")
            obj.subscribe(observer2, "metronome", "gain")
            obj.proxy.metronome.gain = 0.8

            expect(observer1).toHaveBeenCalledTimes(1)
            expect(observer2).toHaveBeenCalledTimes(1)
        })
    })

    describe("subscribeAll", () => {
        it("should notify for any root key change", () => {
            const obj = new VirtualObject(createTestData())
            const observer = vi.fn()

            obj.subscribeAll(observer)
            obj.proxy.metronome.gain = 0.8
            obj.proxy.transport.bpm = 140

            expect(observer).toHaveBeenCalledTimes(2)
            expect(observer).toHaveBeenNthCalledWith(1, "metronome")
            expect(observer).toHaveBeenNthCalledWith(2, "transport")
        })
    })

    describe("update batching", () => {
        it("should notify root key only once when multiple nested properties change", () => {
            const obj = new VirtualObject(createTestData())
            const observer = vi.fn()

            obj.subscribeAll(observer)
            obj.update({metronome: {enabled: false, gain: 0.3}, transport: {bpm: 120}})

            expect(observer).toHaveBeenCalledTimes(1)
            expect(observer).toHaveBeenCalledWith("metronome")
        })

        it("should NOT notify when update has same values", () => {
            const obj = new VirtualObject(createTestData())
            const observer = vi.fn()

            obj.subscribeAll(observer)
            obj.update(createTestData())

            expect(observer).not.toHaveBeenCalled()
        })
    })

    describe("catchupAndSubscribe", () => {
        it("should call observer immediately with current value", () => {
            const obj = new VirtualObject(createTestData())
            const observer = vi.fn()

            obj.catchupAndSubscribe(observer, "metronome", "gain")

            expect(observer).toHaveBeenCalledTimes(1)
            expect(observer).toHaveBeenCalledWith(0.5)
        })

        it("should also notify on subsequent changes", () => {
            const obj = new VirtualObject(createTestData())
            const observer = vi.fn()

            obj.catchupAndSubscribe(observer, "metronome", "gain")
            obj.proxy.metronome.gain = 0.8

            expect(observer).toHaveBeenCalledTimes(2)
            expect(observer).toHaveBeenNthCalledWith(1, 0.5)
            expect(observer).toHaveBeenNthCalledWith(2, 0.8)
        })
    })

    describe("createMutableObservableValue", () => {
        it("should get value at path", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")

            expect(observable.getValue()).toBe(0.5)
        })

        it("should set value at path", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")

            observable.setValue(0.8)

            expect(obj.proxy.metronome.gain).toBe(0.8)
        })

        it("should notify on value change via proxy", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")
            const observer = vi.fn()

            observable.subscribe(observer)
            obj.proxy.metronome.gain = 0.8

            expect(observer).toHaveBeenCalledTimes(1)
            expect(observer).toHaveBeenCalledWith(observable)
            expect(observable.getValue()).toBe(0.8)
        })

        it("should notify on value change via setValue", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")
            const observer = vi.fn()

            observable.subscribe(observer)
            observable.setValue(0.8)

            expect(observer).toHaveBeenCalledTimes(1)
        })

        it("should NOT notify for sibling changes", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")
            const observer = vi.fn()

            observable.subscribe(observer)
            obj.proxy.metronome.enabled = false

            expect(observer).not.toHaveBeenCalled()
        })

        it("should stop notifying after terminate", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")
            const observer = vi.fn()

            observable.subscribe(observer)
            observable.terminate()
            obj.proxy.metronome.gain = 0.8

            expect(observer).not.toHaveBeenCalled()
        })

        it("catchupAndSubscribe should call immediately and on changes", () => {
            const obj = new VirtualObject(createTestData())
            const observable = obj.createMutableObservableValue("metronome", "gain")
            const observer = vi.fn()

            observable.catchupAndSubscribe(observer)
            obj.proxy.metronome.gain = 0.8

            expect(observer).toHaveBeenCalledTimes(2)
        })
    })
})
