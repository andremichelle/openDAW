import {describe, expect, it} from "vitest"
import {EngineSettings} from "@opendaw/studio-adapters"
import {InputLatency} from "./InputLatency"

// The resolution order is: per-capture override (unless it is exactly Inherit), then the engine preference.
// Whichever wins may still be a sentinel (EqualsOutput, Reported) that needs the recording context to resolve.
// The fixtures are deliberately far apart so that a case cannot pass by resolving to the wrong one of them.

const outputLatency = 0.05
const reportedLatency = 0.02
const preferredLatency = 0.005
const overriddenLatency = 0.03

describe("InputLatency.Reported", () => {
    it("is the lower bound the engine-preferences schema enforces", () => {
        // The adapters package cannot import this namespace, so it repeats the number. Pin them together.
        expect(EngineSettings.InputLatencyMinimum).toBe(InputLatency.Reported)
    })
})

describe("InputLatency.resolve", () => {
    it("applies the reported latency when the preference is Reported and the override inherits", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency, reportedLatency))
            .toBe(reportedLatency)
    })
    it("falls back to zero when the browser reports no latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency, undefined)).toBe(0.0)
    })
    it("falls back to zero when the reported latency argument is omitted", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency)).toBe(0.0)
    })
    it("falls back to zero when the browser reports a zero latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency, 0.0)).toBe(0.0)
    })
    it("falls back to zero when the browser reports a value that is not a number", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency, Number.NaN)).toBe(0.0)
    })
    it("falls back to zero when the browser reports an infinite latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Reported, outputLatency, Number.POSITIVE_INFINITY))
            .toBe(0.0)
    })
    it("applies a reported latency that sits exactly on the ceiling", () => {
        expect(InputLatency.resolve(
            InputLatency.Inherit, InputLatency.Reported, outputLatency, InputLatency.ReportedMaximum))
            .toBe(InputLatency.ReportedMaximum)
    })
    it("falls back to zero when the reported latency exceeds the ceiling", () => {
        expect(InputLatency.resolve(
            InputLatency.Inherit, InputLatency.Reported, outputLatency, InputLatency.ReportedMaximum + 0.001))
            .toBe(0.0)
    })
    it("prefers a numeric per-capture override over a Reported preference", () => {
        expect(InputLatency.resolve(overriddenLatency, InputLatency.Reported, outputLatency, reportedLatency))
            .toBe(overriddenLatency)
    })
    it("resolves a per-capture Reported override without inheriting the preference", () => {
        // Discriminates "=== Inherit" from "<= Inherit": the latter would read the preference instead.
        expect(InputLatency.resolve(InputLatency.Reported, preferredLatency, outputLatency, reportedLatency))
            .toBe(reportedLatency)
    })
    it("clamps a per-capture value below Inherit instead of inheriting the preference", () => {
        // Also discriminates "=== Inherit" from "<= Inherit", for a value that is no sentinel at all.
        expect(InputLatency.resolve(-2.5, preferredLatency, outputLatency, reportedLatency)).toBe(0.0)
    })
    it("resolves a per-capture EqualsOutput to the output latency", () => {
        expect(InputLatency.resolve(InputLatency.EqualsOutput, preferredLatency, outputLatency, reportedLatency))
            .toBe(outputLatency)
    })
    it("resolves a preferred EqualsOutput to the output latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.EqualsOutput, outputLatency, reportedLatency))
            .toBe(outputLatency)
    })
    it("uses a numeric preference verbatim", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, preferredLatency, outputLatency, reportedLatency))
            .toBe(preferredLatency)
    })
    it("resolves a stray Inherit stored in the preference to zero", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Inherit, outputLatency, reportedLatency))
            .toBe(0.0)
    })
    it("clamps a negative value that is not a sentinel to zero", () => {
        expect(InputLatency.resolve(-0.5, preferredLatency, outputLatency, reportedLatency)).toBe(0.0)
        expect(InputLatency.resolve(InputLatency.Inherit, -0.5, outputLatency, reportedLatency)).toBe(0.0)
    })
})

describe("InputLatency.resolveWithSource", () => {
    it("names the reported source when the reported latency is usable", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, InputLatency.Reported, outputLatency, reportedLatency))
            .toEqual({seconds: reportedLatency, source: "reported"})
    })
    it("names the unavailable source when the browser reports nothing", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, InputLatency.Reported, outputLatency, undefined))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the unavailable source when the reported latency argument is omitted", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, InputLatency.Reported, outputLatency))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the unavailable source when the browser reports zero", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, InputLatency.Reported, outputLatency, 0.0))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the unavailable source when the browser reports an infinite latency", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, InputLatency.Reported, outputLatency, Number.POSITIVE_INFINITY))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the reported source for a latency that sits exactly on the ceiling", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, InputLatency.Reported, outputLatency, InputLatency.ReportedMaximum))
            .toEqual({seconds: InputLatency.ReportedMaximum, source: "reported"})
    })
    it("names the out-of-range source for a latency above the ceiling", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, InputLatency.Reported, outputLatency, InputLatency.ReportedMaximum + 0.001))
            .toEqual({seconds: 0.0, source: "reported-out-of-range"})
    })
    it("names the capture source for a numeric per-capture override", () => {
        expect(InputLatency.resolveWithSource(overriddenLatency, InputLatency.Reported, outputLatency, reportedLatency))
            .toEqual({seconds: overriddenLatency, source: "capture"})
    })
    it("names the reported source for a per-capture Reported override", () => {
        // Discriminates "=== Inherit" from "<= Inherit": the latter would report the preference instead.
        expect(InputLatency.resolveWithSource(InputLatency.Reported, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: reportedLatency, source: "reported"})
    })
    it("names the capture source for a per-capture value below Inherit", () => {
        expect(InputLatency.resolveWithSource(-2.5, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: 0.0, source: "capture"})
    })
    it("names the equals-output source for a per-capture EqualsOutput", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.EqualsOutput, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: outputLatency, source: "equals-output"})
    })
    it("names the equals-output source for a preferred EqualsOutput", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, InputLatency.EqualsOutput, outputLatency, reportedLatency))
            .toEqual({seconds: outputLatency, source: "equals-output"})
    })
    it("names the preference source for a numeric preference", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: preferredLatency, source: "preference"})
    })
    it("names the preference source for a stray Inherit stored in the preference", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, InputLatency.Inherit, outputLatency, reportedLatency))
            .toEqual({seconds: 0.0, source: "preference"})
    })
    it("names the capture source for a clamped negative per-capture override", () => {
        expect(InputLatency.resolveWithSource(-0.5, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: 0.0, source: "capture"})
    })
})
