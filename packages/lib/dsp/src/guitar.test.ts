import {describe, expect, it} from "vitest"
import {readFileSync, writeFileSync} from "node:fs"
import {resolve} from "node:path"
import {Guitar} from "./guitar"

// Shared with the device-guitar crate test (fretting::tests::parity_fixture): run with GUITAR_FIXTURE=write to regenerate.
const Fixture = resolve(__dirname, "../../../../crates/stock-devices/device-guitar/tests/fretting-parity.txt")

const mask = (...intervals: ReadonlyArray<number>) => intervals.reduce((bits, interval) => bits | (1 << interval), 0)

const Voicings: ReadonlyArray<number> = [
    mask(0, 4, 7), mask(0, 3, 7), mask(0, 3, 6), mask(0, 4, 8), mask(0, 2, 7), mask(0, 5, 7), mask(0, 4, 7, 10),
    mask(0, 4, 7, 11), mask(0, 3, 7, 10), mask(0, 3, 6, 10), mask(4, 7, 12), mask(7, 12, 15), mask(0, 4, 7, 10, 14)
]

const rows = (): string => {
    const lines: Array<string> = []
    for (let root = 0; root < 12; root++) {
        for (const voicing of Voicings) {
            for (let tuning = 0; tuning < Guitar.Tunings.length; tuning++) {
                for (let position = 0; position < Guitar.PositionFrets.length; position++) {
                    lines.push([root, voicing, tuning, position, ...Guitar.tab(root, voicing, tuning, position)].join(" "))
                }
            }
        }
    }
    return lines.join("\n") + "\n"
}

const text = (tab: Guitar.Tab) => tab.map(fret => fret < 0 ? "x" : String(fret)).join("")

describe("Guitar.tab", () => {
    it("plays the common open shapes", () => {
        expect(text(Guitar.tab(0, mask(0, 4, 7), 0, 0))).toBe("x32010")
        expect(text(Guitar.tab(7, mask(0, 4, 7), 0, 0))).toBe("320003")
        expect(text(Guitar.tab(9, mask(0, 3, 7), 0, 0))).toBe("x02210")
        expect(text(Guitar.tab(4, mask(0, 3, 7), 0, 0))).toBe("022000")
        expect(text(Guitar.tab(2, mask(0, 4, 7), 0, 0))).toBe("xx0232")
        expect(text(Guitar.tab(5, mask(0, 4, 7), 0, 0))).toBe("133211")
    })
    it("matches the Rust fretting for every chord, tuning and position", () => {
        if (process.env.GUITAR_FIXTURE === "write") {writeFileSync(Fixture, rows())}
        expect(rows()).toBe(readFileSync(Fixture, "utf8"))
    })
})
