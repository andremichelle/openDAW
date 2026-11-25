import {afterEach, describe, expect, it, vi} from "vitest"
import {BrowserContextClock} from "./BrowserContextClock"
import {BrowserRecordingLatency} from "./BrowserRecordingLatency"
import {BrowserRoundTrips} from "./BrowserRoundTrips"
import {RoundTrip} from "../RoundTrip"

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

    const measured = (seconds: number, verdict: RoundTrip.Verdict = "ok") => ({
        result: {verdict, seconds, spreadSeconds: 0.0, heard: 3, bursts: 3},
        entry: entry("Speakers", seconds)
    })

    it("hands a second call on the same input the running measurement", async () => {
        const owner = {}
        const run = vi.fn(async () => measured(0.02))
        const [first, second] = await Promise.all([
            BrowserRoundTrips.measure(owner, run), BrowserRoundTrips.measure(owner, run)])
        expect(run).toHaveBeenCalledTimes(1)
        expect(second).toBe(first)
    })

    it("refuses to measure another input while a measurement runs", async () => {
        const {promise, resolve} = Promise.withResolvers<ReturnType<typeof measured>>()
        const running = BrowserRoundTrips.measure({}, () => promise)
        await expect(BrowserRoundTrips.measure({}, async () => measured(0.03))).rejects.toBeDefined()
        resolve(measured(0.02))
        await running
        await expect(BrowserRoundTrips.measure({}, async () => measured(0.03))).resolves.toBeDefined()
    })

    it("stores a measured result only when it is accepted", async () => {
        useMemoryStorage()
        const {result} = await BrowserRoundTrips.measure({}, async () => measured(0.02))
        expect(BrowserRoundTrips.all()).toHaveLength(0)
        expect(BrowserRoundTrips.accept(result)).toBe(true)
        expect(BrowserRoundTrips.all().map(({seconds}) => seconds)).toEqual([0.02])
    })

    it("stores an accepted result again after it was forgotten", async () => {
        useMemoryStorage()
        const {result, entry} = await BrowserRoundTrips.measure({}, async () => measured(0.02))
        BrowserRoundTrips.accept(result)
        BrowserRoundTrips.remove(entry.output, entry.input, entry.sampleRate)
        expect(BrowserRoundTrips.all()).toHaveLength(0)
        expect(BrowserRoundTrips.accept(result)).toBe(true)
        expect(BrowserRoundTrips.all()).toHaveLength(1)
    })

    it("stores a shared measurement once, however many callers accept it", async () => {
        useMemoryStorage()
        const observer = vi.fn()
        const subscription = BrowserRoundTrips.subscribe(observer)
        const {result} = await BrowserRoundTrips.measure({}, async () => measured(0.025))
        BrowserRoundTrips.accept(result)
        BrowserRoundTrips.accept(result)
        subscription.terminate()
        expect(observer).toHaveBeenCalledTimes(1)
    })

    it("releases and cancels a measurement that never finishes", async () => {
        vi.useFakeTimers()
        let cancelled = false
        const hung = BrowserRoundTrips.measure({}, signal => {
            signal.addEventListener("abort", () => cancelled = true)
            return new Promise<ReturnType<typeof measured>>(() => {})
        })
        const refused = expect(hung).rejects.toBeDefined()
        await vi.advanceTimersByTimeAsync(31_000)
        await refused
        expect(cancelled).toBe(true)
        vi.useRealTimers()
        await expect(BrowserRoundTrips.measure({}, async () => measured(0.03))).resolves.toBeDefined()
    })

    it("accepts neither an unsteady result nor one it did not measure last", async () => {
        useMemoryStorage()
        const unsteady = await BrowserRoundTrips.measure({}, async () => measured(0.02, "unsteady"))
        expect(BrowserRoundTrips.accept(unsteady.result)).toBe(false)
        const older = await BrowserRoundTrips.measure({}, async () => measured(0.02))
        await BrowserRoundTrips.measure({}, async () => measured(0.04))
        expect(BrowserRoundTrips.accept(older.result)).toBe(false)
        expect(BrowserRoundTrips.all()).toHaveLength(0)
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
