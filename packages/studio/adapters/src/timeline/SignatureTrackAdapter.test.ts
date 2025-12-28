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
    describe("changeSignature algorithm", () => {
        // Test data: Storage 4/4, changing to 3/4
        // Original positions: [15360, 24960, 35040, 42960]
        // Original bars (0-indexed): [4, 6, 9, 12] → displayed (1-indexed): [5, 7, 10, 13]
        //
        // After change to 3/4, Logic Pro shows: [6, 8, 11, 14]
        // So new accumulated bars should be: [5, 7, 10, 13] (0-indexed)

        type MockEvent = {
            index: int
            relativePosition: int
            nominator: int
            denominator: int
        }

        const simulateChangeSignature = (
            events: MockEvent[],
            oldStorage: Readonly<[int, int]>,
            newStorage: Readonly<[int, int]>
        ): { newRelPositions: int[], newAccumulatedBars: int[], newAccumulatedPpqn: ppqn[] } => {
            // Step 1: Calculate original absolute ppqn positions
            const originalPositions: ppqn[] = []
            let accPpqn = 0
            let prevSig = oldStorage
            for (const event of events) {
                accPpqn += event.relativePosition * barPpqn(prevSig[0], prevSig[1])
                originalPositions.push(accPpqn)
                prevSig = [event.nominator, event.denominator]
            }

            // Step 2: Recalculate relative positions for new storage
            // Logic Pro appears to accumulate fractional bar errors and apply correction
            const newRelPositions: int[] = []
            const newAccumulatedPpqn: ppqn[] = []
            const newAccumulatedBars: int[] = []
            const newStorageBarPpqn = barPpqn(newStorage[0], newStorage[1])

            let prevAccumulatedPpqn = 0
            let prevBarPpqn = newStorageBarPpqn
            let accumulatedFraction = 0

            for (let i = 0; i < events.length; i++) {
                const targetPpqn = originalPositions[i]
                const exactBars = (targetPpqn - prevAccumulatedPpqn) / prevBarPpqn
                const wholeBars = Math.floor(exactBars)
                const fraction = exactBars - wholeBars

                accumulatedFraction += fraction

                // Apply correction when accumulated fraction exceeds 1.0
                let newRelPos = wholeBars
                if (accumulatedFraction >= 1.0) {
                    newRelPos += 1
                    accumulatedFraction -= 1.0
                }
                newRelPos = Math.max(1, newRelPos)
                newRelPositions.push(newRelPos)

                prevAccumulatedPpqn += newRelPos * prevBarPpqn
                newAccumulatedPpqn.push(prevAccumulatedPpqn)

                prevBarPpqn = barPpqn(events[i].nominator, events[i].denominator)
            }

            // Calculate accumulated bars
            let accBars = 0
            for (const relPos of newRelPositions) {
                accBars += relPos
                newAccumulatedBars.push(accBars)
            }

            return {newRelPositions, newAccumulatedBars, newAccumulatedPpqn}
        }

        it("should preserve approximate positions when changing 4/4 to 3/4", () => {
            const events: MockEvent[] = [
                {index: 0, relativePosition: 4, nominator: 5, denominator: 4},
                {index: 1, relativePosition: 2, nominator: 7, denominator: 8},
                {index: 2, relativePosition: 3, nominator: 11, denominator: 16},
                {index: 3, relativePosition: 3, nominator: 4, denominator: 4}
            ]
            const oldStorage: Readonly<[int, int]> = [4, 4]
            const newStorage: Readonly<[int, int]> = [3, 4]

            const result = simulateChangeSignature(events, oldStorage, newStorage)

            // Logic Pro shows bars: [6, 8, 11, 15] (1-indexed)
            // So accumulated bars (0-indexed) should be: [5, 7, 10, 14]
            expect(result.newAccumulatedBars).toEqual([5, 7, 10, 14])

            // Verify relative positions
            expect(result.newRelPositions).toEqual([5, 2, 3, 4])

            // Verify positions are close to original (within 1 bar tolerance)
            const originalPositions = [15360, 24960, 35040, 42960]
            for (let i = 0; i < originalPositions.length; i++) {
                const maxBarPpqn = Math.max(
                    barPpqn(4, 4), barPpqn(5, 4), barPpqn(7, 8), barPpqn(11, 16)
                )
                const drift = Math.abs(result.newAccumulatedPpqn[i] - originalPositions[i])
                expect(drift).toBeLessThanOrEqual(maxBarPpqn)
            }
        })

        it("should verify original positions are preserved", () => {
            // The algorithm should not LOSE any events or drastically change positions
            const events: MockEvent[] = [
                {index: 0, relativePosition: 4, nominator: 5, denominator: 4},
                {index: 1, relativePosition: 2, nominator: 7, denominator: 8},
                {index: 2, relativePosition: 3, nominator: 11, denominator: 16},
                {index: 3, relativePosition: 3, nominator: 4, denominator: 4}
            ]

            // Changing 4/4 → 3/4 → 4/4 should return to roughly original positions
            const result1 = simulateChangeSignature(events, [4, 4], [3, 4])
            const eventsAfterChange = events.map((e, i) => ({
                ...e,
                relativePosition: result1.newRelPositions[i]
            }))
            const result2 = simulateChangeSignature(eventsAfterChange, [3, 4], [4, 4])

            // Bars should be close to original [4, 6, 9, 12]
            // Due to rounding, there may be small drift
            const originalBars = [4, 6, 9, 12]
            for (let i = 0; i < originalBars.length; i++) {
                const drift = Math.abs(result2.newAccumulatedBars[i] - originalBars[i])
                expect(drift).toBeLessThanOrEqual(1) // Allow 1 bar drift due to rounding
            }
        })
    })
    describe("deleteAdapter algorithm", () => {
        // Test data: Storage 4/4
        // Original events: [bar 5 (5/4), bar 7 (7/8), bar 10 (11/16), bar 13 (4/4)]
        // Original ppqn: [15360, 24960, 35040, 42960]
        //
        // After deleting the 5/4 event (bar 5), Logic Pro shows:
        // - 7/8 goes to bar 8
        // - 11/16 goes to bar 10
        // - 4/4 goes to bar 14

        type MockEvent = {
            index: int
            relativePosition: int
            nominator: int
            denominator: int
            accumulatedPpqn: ppqn
        }

        const simulateDeleteAdapter = (
            events: MockEvent[],
            storage: Readonly<[int, int]>,
            deleteIndex: int
        ): { newRelPositions: int[], newAccumulatedBars: int[] } => {
            const deleteEventIndex = events.findIndex(e => e.index === deleteIndex)
            if (deleteEventIndex === -1) {return {newRelPositions: [], newAccumulatedBars: []}}

            const eventsAfter = events.slice(deleteEventIndex + 1)
            const originalPositions = eventsAfter.map(e => e.accumulatedPpqn)

            // Determine previous signature
            const prevEvent = deleteEventIndex > 0 ? events[deleteEventIndex - 1] : null
            const [prevNom, prevDenom] = prevEvent !== null
                ? [prevEvent.nominator, prevEvent.denominator]
                : storage
            const prevAccumulatedPpqn = prevEvent !== null ? prevEvent.accumulatedPpqn : 0

            // Recalculate using round() for deletion
            const newRelPositions: int[] = []
            let accumulatedPpqn = prevAccumulatedPpqn
            let durationBar = barPpqn(prevNom, prevDenom)

            for (let i = 0; i < eventsAfter.length; i++) {
                const targetPpqn = originalPositions[i]
                const exactBars = (targetPpqn - accumulatedPpqn) / durationBar
                const newRelPos = Math.max(1, Math.round(exactBars))
                newRelPositions.push(newRelPos)

                accumulatedPpqn += newRelPos * durationBar
                durationBar = barPpqn(eventsAfter[i].nominator, eventsAfter[i].denominator)
            }

            // Calculate accumulated bars
            const newAccumulatedBars: int[] = []
            let accBars = prevEvent !== null
                ? events.slice(0, deleteEventIndex).reduce((sum, e) => sum + e.relativePosition, 0)
                : 0
            for (const relPos of newRelPositions) {
                accBars += relPos
                newAccumulatedBars.push(accBars)
            }

            return {newRelPositions, newAccumulatedBars}
        }

        it("should recalculate positions when deleting first event (5/4)", () => {
            const events: MockEvent[] = [
                {index: 0, relativePosition: 4, nominator: 5, denominator: 4, accumulatedPpqn: 15360},
                {index: 1, relativePosition: 2, nominator: 7, denominator: 8, accumulatedPpqn: 24960},
                {index: 2, relativePosition: 3, nominator: 11, denominator: 16, accumulatedPpqn: 35040},
                {index: 3, relativePosition: 3, nominator: 4, denominator: 4, accumulatedPpqn: 42960}
            ]

            const result = simulateDeleteAdapter(events, STORAGE_SIGNATURE, 0)

            // Logic Pro shows bars: [8, 10, 14] (1-indexed)
            // So accumulated bars (0-indexed) should be: [7, 9, 13]
            expect(result.newAccumulatedBars).toEqual([7, 9, 13])

            // Verify relative positions
            expect(result.newRelPositions).toEqual([7, 2, 4])
        })
    })
    describe("createEvent algorithm", () => {
        // Test data: Storage 4/4
        // Original events: [bar 5 (5/4), bar 7 (7/8), bar 10 (11/16), bar 13 (4/4)]
        // Original ppqn: [15360, 24960, 35040, 42960]
        //
        // Creating new event at bar 3 with 3/4 signature, Logic Pro shows:
        // - New 3/4 at bar 3
        // - 5/4 at bar 6 (was bar 5)
        // - 7/8 at bar 8 (was bar 7)
        // - 11/16 at bar 11 (was bar 10)
        // - 4/4 at bar 14 (was bar 13)

        type MockEvent = {
            index: int
            relativePosition: int
            nominator: int
            denominator: int
            accumulatedPpqn: ppqn
        }

        type StorageEvent = {
            index: -1
            accumulatedPpqn: 0
            nominator: int
            denominator: int
        }

        const simulateCreateEvent = (
            events: MockEvent[],
            storage: Readonly<[int, int]>,
            position: ppqn,
            newNominator: int,
            newDenominator: int
        ): { newRelPositions: int[], newAccumulatedBars: int[] } => {
            // Build allEvents including storage
            const storageEvent: StorageEvent = {
                index: -1, accumulatedPpqn: 0,
                nominator: storage[0], denominator: storage[1]
            }
            type AllEvent = StorageEvent | MockEvent
            const allEvents: AllEvent[] = [storageEvent, ...events]

            // Find previous event
            let prevEvent: AllEvent = allEvents[0]
            let insertAfterIndex = 0
            for (let i = 1; i < allEvents.length; i++) {
                const event = allEvents[i] as MockEvent
                if (event.accumulatedPpqn > position) {break}
                prevEvent = event
                insertAfterIndex = i
            }

            // Calculate new event's relativePosition
            const prevBarPpqn = barPpqn(prevEvent.nominator, prevEvent.denominator)
            const prevAccPpqn = prevEvent.index === -1 ? 0 : (prevEvent as MockEvent).accumulatedPpqn
            const barsFromPrev = (position - prevAccPpqn) / prevBarPpqn
            const newRelPos = Math.max(1, Math.round(barsFromPrev))

            // Calculate new event's accumulated ppqn
            const newEventPpqn = prevAccPpqn + newRelPos * prevBarPpqn
            const newBarPpqn = barPpqn(newNominator, newDenominator)

            // Get successor events and calculate their new relativePositions
            const successorEvents = allEvents.slice(insertAfterIndex + 1) as MockEvent[]
            const newRelPositions: int[] = [newRelPos]

            let accPpqn = newEventPpqn
            let prevDurationBar = newBarPpqn

            for (let i = 0; i < successorEvents.length; i++) {
                const event = successorEvents[i]
                if (i === 0) {
                    // First successor: recalculate based on distance from new event
                    const barsToNext = (event.accumulatedPpqn - accPpqn) / prevDurationBar
                    const relPos = Math.max(1, Math.round(barsToNext))
                    newRelPositions.push(relPos)
                    accPpqn += relPos * prevDurationBar
                } else {
                    // Other successors: keep original relativePosition
                    newRelPositions.push(event.relativePosition)
                    accPpqn += event.relativePosition * prevDurationBar
                }
                prevDurationBar = barPpqn(event.nominator, event.denominator)
            }

            // Calculate accumulated bars
            const newAccumulatedBars: int[] = []
            let accBars = 0
            for (const relPos of newRelPositions) {
                accBars += relPos
                newAccumulatedBars.push(accBars)
            }

            return {newRelPositions, newAccumulatedBars}
        }

        it("should create event at bar 3 with 3/4 and adjust successors", () => {
            const events: MockEvent[] = [
                {index: 0, relativePosition: 4, nominator: 5, denominator: 4, accumulatedPpqn: 15360},
                {index: 1, relativePosition: 2, nominator: 7, denominator: 8, accumulatedPpqn: 24960},
                {index: 2, relativePosition: 3, nominator: 11, denominator: 16, accumulatedPpqn: 35040},
                {index: 3, relativePosition: 3, nominator: 4, denominator: 4, accumulatedPpqn: 42960}
            ]

            // Bar 3 = 2 bars of 4/4 = 7680 ppqn
            const position = 2 * barPpqn(4, 4) // 7680
            const result = simulateCreateEvent(events, STORAGE_SIGNATURE, position, 3, 4)

            // Logic Pro shows bars: [3, 6, 8, 11, 14] (1-indexed)
            // So accumulated bars (0-indexed) should be: [2, 5, 7, 10, 13]
            expect(result.newAccumulatedBars).toEqual([2, 5, 7, 10, 13])

            // Verify relative positions: [2, 3, 2, 3, 3]
            expect(result.newRelPositions).toEqual([2, 3, 2, 3, 3])
        })
    })
})