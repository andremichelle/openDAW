import {describe, expect, it} from "vitest"
import {ppqn, PPQN, SMPTE} from "@opendaw/lib-dsp"
import {int} from "@opendaw/lib-std"

describe("SignatureTrackAdapter", () => {
    const BPM = 60
    const FPS = 25
    const STORAGE_SIGNATURE: Readonly<[int, int]> = [4, 4]
    const barPpqn = (nominator: int, denominator: int): ppqn =>
        PPQN.fromSignature(nominator, denominator)
    const secondsToPpqn = (seconds: number): ppqn =>
        PPQN.secondsToPulses(seconds, BPM)
    describe("SMPTE conversions", () => {
        it("should convert SMPTE to seconds at 25 fps", () => {
            expect(SMPTE.toSeconds(SMPTE.create(16), FPS)).toBe(16)
            expect(SMPTE.toSeconds(SMPTE.create(26), FPS)).toBe(26)
            expect(SMPTE.toSeconds(SMPTE.create(36, 12, 40), FPS)).toBe(36.5)
            expect(SMPTE.toSeconds(SMPTE.create(44, 18, 60), FPS)).toBe(44.75)
        })
        it("should format SMPTE as short string", () => {
            expect(SMPTE.toShortString(SMPTE.create(16))).toBe("16s")
            expect(SMPTE.toShortString(SMPTE.create(36, 12, 40))).toBe("36s 12fr 40sub")
        })
    })
    describe("bar duration calculations", () => {
        it("should compute bar duration for different signatures", () => {
            expect(barPpqn(4, 4)).toBe(3840)   // 4 quarter notes
            expect(barPpqn(5, 4)).toBe(4800)   // 5 quarter notes
            expect(barPpqn(7, 8)).toBe(3360)   // 7 eighth notes
            expect(barPpqn(11, 16)).toBe(2640) // 11 sixteenth notes
        })
    })
    describe("absolute position calculation with relative-position model", () => {
        it("should calculate event 1 (5/4) position from storage signature", () => {
            const relativePosition = 4
            const position = relativePosition * barPpqn(STORAGE_SIGNATURE[0], STORAGE_SIGNATURE[1])
            const expectedSeconds = SMPTE.toSeconds(SMPTE.create(16), FPS)
            expect(position).toBe(15360)
            expect(secondsToPpqn(expectedSeconds)).toBe(15360)
        })
        it("should calculate event 2 (7/8) position from event 1 signature", () => {
            const event1Position = 4 * barPpqn(4, 4) // 15360
            const event2RelPos = 2
            const position = event1Position + event2RelPos * barPpqn(5, 4)
            const expectedSeconds = SMPTE.toSeconds(SMPTE.create(26), FPS)
            expect(position).toBe(24960)
            expect(secondsToPpqn(expectedSeconds)).toBe(24960)
        })

        it("should calculate event 3 (11/16) position from event 2 signature", () => {
            const event2Position = 15360 + 2 * barPpqn(5, 4) // 24960
            const event3RelPos = 3
            const position = event2Position + event3RelPos * barPpqn(7, 8)
            const expectedSeconds = SMPTE.toSeconds(SMPTE.create(36, 12, 40), FPS)
            expect(position).toBe(35040)
            expect(secondsToPpqn(expectedSeconds)).toBe(35040)
        })
        it("should calculate event 4 (4/4) position from event 3 signature", () => {
            const event3Position = 24960 + 3 * barPpqn(7, 8) // 35040
            const event4RelPos = 3
            const position = event3Position + event4RelPos * barPpqn(11, 16)
            const expectedSeconds = SMPTE.toSeconds(SMPTE.create(44, 18, 60), FPS)
            expect(position).toBe(42960)
            expect(secondsToPpqn(expectedSeconds)).toBe(42960)
        })
    })
    describe("storage data model", () => {
        it("should verify test data matches expected positions", () => {
            const events = [
                {index: 0, relativePosition: 4, nominator: 5, denominator: 4},
                {index: 1, relativePosition: 2, nominator: 7, denominator: 8},
                {index: 2, relativePosition: 3, nominator: 11, denominator: 16},
                {index: 3, relativePosition: 3, nominator: 4, denominator: 4}
            ]
            const expectedPositions = [15360, 24960, 35040, 42960]
            let accumulatedPpqn = 0
            let prevSignature = STORAGE_SIGNATURE
            for (let i = 0; i < events.length; i++) {
                const event = events[i]
                accumulatedPpqn += event.relativePosition * barPpqn(prevSignature[0], prevSignature[1])
                expect(accumulatedPpqn).toBe(expectedPositions[i])
                prevSignature = [event.nominator, event.denominator]
            }
        })
    })
})