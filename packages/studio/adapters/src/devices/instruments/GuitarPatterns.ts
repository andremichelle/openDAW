import {int} from "@opendaw/lib-std"
import {GuitarDeviceBox} from "@opendaw/studio-boxes"

// The built in strum patterns: one letter per step. D down, U up, d/u down/up on the high strings, M palm muted
// down, X chuck, B bass, A alternate bass, 1-6 pick one string (1 = high e), S stop the strings, . and - nothing.
export namespace GuitarPatterns {
    // WASM CONTRACT: the stroke kinds mirror `strum.rs` in device-guitar
    export const Rest = 0
    export const Down = 1
    export const Up = 2
    export const Mute = 3
    export const Chuck = 4
    export const Bass = 5
    export const Alternate = 6
    export const Pick = 7
    export const Stop = 8

    export const StepCount = 64
    export const AllStrings = 0b111111

    export type Kind = { readonly kind: int, readonly glyph: string, readonly label: string }
    export const Kinds: ReadonlyArray<Kind> = [
        {kind: Down, glyph: "↓", label: "Down"},
        {kind: Up, glyph: "↑", label: "Up"},
        {kind: Mute, glyph: "⇣", label: "Palm mute"},
        {kind: Chuck, glyph: "×", label: "Chuck"},
        {kind: Bass, glyph: "●", label: "Bass"},
        {kind: Alternate, glyph: "○", label: "Alternate bass"},
        {kind: Pick, glyph: "♪", label: "Pick the lane strings"},
        {kind: Stop, glyph: "■", label: "Stop the strings"},
        {kind: Rest, glyph: "·", label: "Rest"}
    ]

    export type Pattern = { readonly style: string, readonly name: string, readonly text: string }
    const style = (name: string, entries: ReadonlyArray<[string, string]>): ReadonlyArray<Pattern> =>
        entries.map(([pattern, text]) => ({style: name, name: pattern, text}))

    export const Library: ReadonlyArray<Pattern> = [
        ...style("Strumming", [
            ["Down Quarters", "D...D...D...D..."], ["Down Eighths", "D.D.D.D.D.D.D.D."], ["Down Up Eighths", "D.U.D.U.D.U.D.U."],
            ["Pop", "D...D.U...U.D.U."], ["Folk", "D.D..UDUD.D..UDU"], ["Island", "D.DU.UDUD.DU.UDU"],
            ["Sixteenths", "DUDUDUDUDUDUDUDU"], ["Ballad Strum", "D.....U.D...d.u."], ["Strum and Ring", "D.......U......."],
            ["Two Bar Pop", "D...D.U...U.D.U.D...D.U.D.U.D.U."]]),
        ...style("Rock", [
            ["Rock Eighths", "M.M.M.M.M.M.M.M."], ["Power Drive", "D.MMD.MMD.MMD.MM"], ["Gallop", "M.MMM.MMM.MMM.MM"],
            ["Punk", "DDDDDDDDDDDDDDDD"], ["Anthem", "D.......D...D.U."]]),
        ...style("Funk and Soul", [
            ["Funk Sixteenths", "D.XUX.UXD.XUX.UX"], ["Funk Chops", "X.u...u.X.u..uX."], ["Motown", "....DS......DS.."],
            ["Disco", "X.u.X.u.X.u.X.u."], ["Soul Ballad", "D...d.u.X...d.u."]]),
        ...style("Reggae and Ska", [
            ["Reggae", "....u.......u..."], ["One Drop", "....u.u.....u.u."], ["Ska", "..u...u...u...u."],
            ["Rocksteady", "....u..u....u..u"]]),
        ...style("Latin", [
            ["Bossa Nova", "B..d..d.A.d..d..B..d..d.A.d..d.."], ["Rumba", "D.DUX.DUD.DUX.DU"], ["Samba", "B.dd.dd.A.dd.dd."],
            ["Son Montuno", "D..U..D...U.D..."], ["Tango", "D.D.D.D.DDDD.D.D"]]),
        ...style("Country", [
            ["Boom Chick", "B...d...A...d..."], ["Train Beat", "MXMXMXMXMXMXMXMX"], ["Waltz", "B...d...d..."],
            ["Two Step", "B.d.A.d.B.d.A.d."]]),
        ...style("Fingerstyle", [
            ["Travis", "B.3.A.2.B.3.A.2."], ["Arpeggio Up", "B.3.2.1.B.3.2.1."], ["Arpeggio Up Down", "B.4.3.2.1.2.3.4."],
            ["Ballad Picking", "B.3.2.3.1.3.2.3."], ["Pinch", "B.2.3.2.A.2.3.2."], ["Six Eight", "B.3.2.1.2.3."],
            ["Classical", "B321B321A321A321"]])
    ]

    export const Styles: ReadonlyArray<string> = Array.from(new Set(Library.map(({style}) => style)))
    export const DefaultPattern = Library.findIndex(({name}) => name === "Folk")

    export type Step = { readonly kind: int, readonly strings: int, readonly velocity: int, readonly speed: int }

    const treble = 0b111100

    export const parse = (text: string): ReadonlyArray<Step> => Array.from(text).map((letter, index): Step => {
        const accent = index % 4 === 0 ? 95 : index % 2 === 0 ? 80 : 70
        if (letter >= "1" && letter <= "6") {
            return {kind: Pick, strings: 1 << (6 - Number(letter)), velocity: accent, speed: 50}
        }
        switch (letter) {
            case "D":
                return {kind: Down, strings: AllStrings, velocity: accent, speed: 50}
            case "U":
                return {kind: Up, strings: AllStrings, velocity: 62, speed: 50}
            case "d":
                return {kind: Down, strings: treble, velocity: Math.round(accent * 0.9), speed: 40}
            case "u":
                return {kind: Up, strings: treble, velocity: 56, speed: 40}
            case "M":
                return {kind: Mute, strings: AllStrings, velocity: accent, speed: 40}
            case "X":
                return {kind: Chuck, strings: AllStrings, velocity: 50, speed: 30}
            case "B":
                return {kind: Bass, strings: AllStrings, velocity: accent, speed: 50}
            case "A":
                return {kind: Alternate, strings: AllStrings, velocity: accent, speed: 50}
            case "S":
                return {kind: Stop, strings: AllStrings, velocity: 80, speed: 50}
            default:
                return {kind: Rest, strings: AllStrings, velocity: 80, speed: 50}
        }
    })

    export const write = (box: GuitarDeviceBox, steps: ReadonlyArray<Step>, length: int): void => {
        for (let index = 0; index < StepCount; index++) {
            const step = steps[index] ?? {kind: Rest, strings: AllStrings, velocity: 80, speed: 50}
            box.stepKinds.getField(index).setValue(step.kind)
            box.stepStrings.getField(index).setValue(step.strings)
            box.stepVelocities.getField(index).setValue(step.velocity)
            box.stepSpeeds.getField(index).setValue(step.speed)
        }
        box.patternLength.setValue(Math.max(1, Math.min(StepCount, length)))
    }

    export const load = (box: GuitarDeviceBox, index: int): void => {
        const pattern = Library[index]
        write(box, parse(pattern.text), pattern.text.length)
        box.pattern.setValue(index)
    }

    // Rotates every lane within the pattern length, positive moves the steps to the left.
    export const rotate = (box: GuitarDeviceBox, offset: int): void => {
        const length = box.patternLength.getValue()
        for (const array of [box.stepKinds, box.stepStrings, box.stepVelocities, box.stepSpeeds]) {
            const fields = array.fields().slice(0, length)
            const values = fields.map(field => field.getValue())
            fields.forEach((field, index) => field.setValue(values[(index + offset + length) % length]))
        }
        box.pattern.setValue(-1)
    }

    export const clear = (box: GuitarDeviceBox): void => {
        write(box, [], box.patternLength.getValue())
        box.pattern.setValue(-1)
    }

    export const nameOf = (index: int): string => Library[index]?.name ?? "Custom"
}
