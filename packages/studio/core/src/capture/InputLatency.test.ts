import {describe, expect, it} from "vitest"
import {InputLatency} from "./InputLatency"

// The resolution order is: per-capture override (unless it inherits), then the engine preference. A value
// of zero at either level falls through to the latency the stream reports. The fixtures are deliberately
// far apart so that a case cannot pass by resolving to the wrong one of them.

const outputLatency = 0.05
const reportedLatency = 0.02
const preferredLatency = 0.005
const overriddenLatency = 0.03

describe("InputLatency.resolve", () => {
    it("applies the reported latency when the preference is zero and the override inherits", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, reportedLatency)).toBe(reportedLatency)
    })
    it("falls back to zero when the browser reports no latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, undefined)).toBe(0.0)
    })
    it("falls back to zero when the reported latency argument is omitted", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency)).toBe(0.0)
    })
    it("falls back to zero when the browser reports a zero latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, 0.0)).toBe(0.0)
    })
    it("falls back to zero when the browser reports a value that is not a number", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, Number.NaN)).toBe(0.0)
    })
    it("falls back to zero when the browser reports an infinite latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, Number.POSITIVE_INFINITY)).toBe(0.0)
    })
    it("applies a reported latency that sits exactly on the ceiling", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, InputLatency.ReportedMaximum))
            .toBe(InputLatency.ReportedMaximum)
    })
    it("falls back to zero when the reported latency exceeds the ceiling", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, 0.0, outputLatency, InputLatency.ReportedMaximum + 0.001))
            .toBe(0.0)
    })
    it("prefers a numeric per-capture override over the reported latency", () => {
        expect(InputLatency.resolve(overriddenLatency, 0.0, outputLatency, reportedLatency)).toBe(overriddenLatency)
    })
    it("prefers a numeric preference over the reported latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, preferredLatency, outputLatency, reportedLatency))
            .toBe(preferredLatency)
    })
    it("applies the reported latency for a per-capture zero, not the preference", () => {
        expect(InputLatency.resolve(0.0, preferredLatency, outputLatency, reportedLatency)).toBe(reportedLatency)
    })
    it("resolves a per-capture EqualsOutput to the output latency", () => {
        expect(InputLatency.resolve(InputLatency.EqualsOutput, preferredLatency, outputLatency, reportedLatency))
            .toBe(outputLatency)
    })
    it("resolves a preferred EqualsOutput to the output latency", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.EqualsOutput, outputLatency, reportedLatency))
            .toBe(outputLatency)
    })
    it("treats a negative value that is no sentinel like zero", () => {
        expect(InputLatency.resolve(-0.5, preferredLatency, outputLatency, reportedLatency)).toBe(reportedLatency)
        expect(InputLatency.resolve(InputLatency.Inherit, -0.5, outputLatency, reportedLatency)).toBe(reportedLatency)
        expect(InputLatency.resolve(InputLatency.Inherit, -0.5, outputLatency, undefined)).toBe(0.0)
    })
    it("treats a stray Inherit stored in the preference like zero", () => {
        expect(InputLatency.resolve(InputLatency.Inherit, InputLatency.Inherit, outputLatency, reportedLatency))
            .toBe(reportedLatency)
    })
})

describe("InputLatency.resolveWithSource", () => {
    it("names the reported source when the reported latency is usable", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, 0.0, outputLatency, reportedLatency))
            .toEqual({seconds: reportedLatency, source: "reported"})
    })
    it("names the unavailable source when the browser reports nothing", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, 0.0, outputLatency, undefined))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the unavailable source when the browser reports zero", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, 0.0, outputLatency, 0.0))
            .toEqual({seconds: 0.0, source: "reported-unavailable"})
    })
    it("names the out-of-range source for a latency above the ceiling", () => {
        expect(InputLatency.resolveWithSource(
            InputLatency.Inherit, 0.0, outputLatency, InputLatency.ReportedMaximum + 0.001))
            .toEqual({seconds: 0.0, source: "reported-out-of-range"})
    })
    it("names the capture source for a numeric per-capture override", () => {
        expect(InputLatency.resolveWithSource(overriddenLatency, 0.0, outputLatency, reportedLatency))
            .toEqual({seconds: overriddenLatency, source: "capture"})
    })
    it("names the preference source for a numeric preference", () => {
        expect(InputLatency.resolveWithSource(InputLatency.Inherit, preferredLatency, outputLatency, reportedLatency))
            .toEqual({seconds: preferredLatency, source: "preference"})
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
})
