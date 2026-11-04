import {afterEach, describe, expect, it, vi} from "vitest"
import {BrowserContextClock} from "./BrowserContextClock"
import {BrowserRecordingLatency} from "./BrowserRecordingLatency"
import {BrowserRoundTrips} from "./BrowserRoundTrips"

describe("BrowserContextClock", () => {
    afterEach(() => {vi.restoreAllMocks()})

    it("maps a performance time through the output timestamp", () => {
        const context = {getOutputTimestamp: () => ({contextTime: 2.0, performanceTime: 5000.0})} as unknown as AudioContext
        expect(new BrowserContextClock(context).audibleTimeAt(5250.0)).toBeCloseTo(2.25, 9)
    })

    it("estimates from the render clock and the output latency while the stamp reads zero", () => {
        vi.spyOn(performance, "now").mockImplementation(() => 1000.0)
        const context = {
            getOutputTimestamp: () => ({contextTime: 0.0, performanceTime: 0.0}), currentTime: 3.0, outputLatency: 0.04
        } as unknown as AudioContext
        expect(new BrowserContextClock(context).audibleTimeAt(990.0)).toBeCloseTo(3.0 - 0.04 - 0.01, 9)
    })
})

describe("BrowserRoundTrips", () => {
    const entry = (output: string, seconds: number) => ({output, input: "Mic", sampleRate: 48_000, seconds, measuredAt: 1})
    const useMemoryStorage = () => {
        const items = new Map<string, string>()
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => {items.set(key, value)}
        })
    }

    afterEach(() => {vi.unstubAllGlobals()})

    it("replaces the entry of the same devices and keeps the others", () => {
        useMemoryStorage()
        BrowserRoundTrips.save(entry("Speakers", 0.1))
        BrowserRoundTrips.save(entry("Headphones", 0.02))
        BrowserRoundTrips.save(entry("Speakers", 0.115))
        expect(BrowserRoundTrips.all().map(({output, seconds}) => [output, seconds]))
            .toEqual([["Headphones", 0.02], ["Speakers", 0.115]])
    })

    it("removes only the entry of the given devices", () => {
        useMemoryStorage()
        BrowserRoundTrips.save(entry("Speakers", 0.1))
        BrowserRoundTrips.save(entry("Headphones", 0.02))
        BrowserRoundTrips.remove("Speakers", "Mic", 48_000)
        expect(BrowserRoundTrips.find("Speakers", "Mic", 48_000).isEmpty()).toBe(true)
        expect(BrowserRoundTrips.find("Headphones", "Mic", 48_000).unwrap().seconds).toBe(0.02)
    })

    it("notifies on save and on a real removal only", () => {
        useMemoryStorage()
        const observer = vi.fn()
        const subscription = BrowserRoundTrips.subscribe(observer)
        BrowserRoundTrips.save(entry("Speakers", 0.1))
        BrowserRoundTrips.remove("Speakers", "Mic", 44_100)
        BrowserRoundTrips.remove("Speakers", "Mic", 48_000)
        subscription.terminate()
        BrowserRoundTrips.save(entry("Speakers", 0.1))
        expect(observer).toHaveBeenCalledTimes(2)
    })
})

describe("BrowserRecordingLatency", () => {
    it("keeps the last real output latency when a later read is zero", () => {
        const context = {outputLatency: 0.023}
        const read = BrowserRecordingLatency.reader(context as unknown as AudioContext, outputLatency => outputLatency / 2)
        expect(read()).toEqual({outputLatency: 0.023, inputLatency: 0.0115})
        context.outputLatency = 0.0
        expect(read()).toEqual({outputLatency: 0.023, inputLatency: 0.0115})
    })

    it("takes a real read that arrives after a zero", () => {
        const context = {outputLatency: 0.0}
        const read = BrowserRecordingLatency.reader(context as unknown as AudioContext, () => 0.01)
        expect(read().outputLatency).toBe(0.0)
        context.outputLatency = 0.023
        expect(read().outputLatency).toBe(0.023)
    })
})
