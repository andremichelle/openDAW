import {int, Option} from "@opendaw/lib-std"
import {CubedStep} from "./CubedStep"

/**
 * Reader for AudioRealism ABL `.pat` files (the pattern library shipped with ABL2 / ABL3).
 *
 * Plain text: comment lines starting with `;` carry the meta header, every other non-empty line is
 * one step. Two dialects exist in the same library and both appear in the factory folders:
 *
 *   ABL3  `10 0 1 0 1 1`   pitch down up accent slide gate
 *   ABL2  `a#3 1 0 1`      note  gate accent slide            (octave lives in the note name, so the
 *                                                              down/up flags are absent)
 *
 * The ABL3 order is VERIFIED, not guessed: `userlab.pat` was loaded into the plugin and the
 * resulting pattern bank dumped, and all 16 steps line up only under this order. Note that GATE
 * COMES LAST and does NOT match the order of the same fields in the plugin's own state XML
 * (pitch gate down up accent slide) - reading the file in XML order silently swaps gate with the
 * octave flags, which loads as a transposed pattern full of wrong rests.
 *
 * The two dialects do NOT agree on where gate goes: ABL2 puts it FIRST. That is measured, not
 * assumed - across the 238 ABL2 factory files, reading gate as the last column leaves 13 patterns
 * completely silent and finds only 1415 gated steps, while reading it as the first finds 5664 and
 * no silent pattern at all.
 *
 * Which of the remaining two columns is accent and which is slide is still inference: they occur at
 * near-identical rates (22% vs 24% of gated steps) and both are followed by a gated step ~93% of the
 * time, so the data cannot separate them. The order here follows ABL3, where accent precedes slide.
 */
export type AblPattern = {
    steps: ReadonlyArray<CubedStep>
    length: int
}

export namespace AblPattern {
    /**
     * MIDI note for the plugin's pitch 0. VERIFIED twice against captured plugin state: decoding the
     * `scream` and `userlab` banks with this base reproduces their known note sequences exactly.
     *
     * NOT the Cubed step default of 60 - using that loads every pattern two octaves high.
     */
    export const BASE_NOTE: int = 36

    const NOTE_NAMES: Record<string, int> = {
        c: 0, "c#": 1, d: 2, "d#": 3, e: 4, f: 5, "f#": 6, g: 7, "g#": 8, a: 9, "a#": 10, b: 11
    }

    /** `a#3` / `c-5` -> MIDI note. The `-` is a placeholder for "no accidental", not a minus sign. */
    const parseNoteName = (text: string): Option<int> => {
        const match = text.toLowerCase().match(/^([a-g][#-]?)(-?\d+)$/)
        if (match === null) {return Option.None}
        const semitone = NOTE_NAMES[match[1].replace("-", "")]
        if (semitone === undefined) {return Option.None}
        // The named octave maps directly, which puts the plugin's base note (pitch 0 = MIDI 36) at
        // `c-3` and middle C at `c-5` - consistent with the verified ABL3 base.
        const note = semitone + parseInt(match[2], 10) * 12
        return note >= 0 && note <= 127 ? Option.wrap(note) : Option.None
    }

    const flag = (text: string | undefined): boolean => text !== undefined && parseInt(text, 10) !== 0

    export const parse = (text: string): AblPattern => {
        const steps: Array<CubedStep> = []
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim()
            if (line.length === 0 || line.startsWith(";")) {continue}
            const columns = line.split(/\s+/)
            const named = parseNoteName(columns[0])
            if (named.nonEmpty()) {
                // ABL2: note gate accent slide
                steps.push({
                    note: named.unwrap(),
                    active: flag(columns[1]),
                    accent: flag(columns[2]),
                    slide: flag(columns[3])
                })
                continue
            }
            const pitch = parseInt(columns[0], 10)
            if (!Number.isFinite(pitch)) {continue}
            // ABL3: pitch down up accent slide gate. Pitch is a semitone offset from the plugin's
            // BASE NOTE, and the down/up flags shift it an octave.
            const octave = (flag(columns[2]) ? 12 : 0) - (flag(columns[1]) ? 12 : 0)
            const note = BASE_NOTE + pitch + octave
            steps.push({
                note: Math.max(0, Math.min(127, note)),
                accent: flag(columns[3]),
                slide: flag(columns[4]),
                active: flag(columns[5])
            })
        }
        return {steps, length: steps.length}
    }
}
