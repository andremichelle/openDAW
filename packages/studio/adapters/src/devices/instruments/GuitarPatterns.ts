import {clamp, int} from "@opendaw/lib-std"
import {GuitarDeviceBox, GuitarPattern} from "@opendaw/studio-boxes"

// The built in patterns use one letter per step, see `parse` for the letters.
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
    export const Chop = 9

    export const StepCount = 64
    export const AllStrings = 0b111111

    export type Kind = { readonly kind: int, readonly glyph: string, readonly label: string }
    export const Kinds: ReadonlyArray<Kind> = [
        {kind: Down, glyph: "↓", label: "Down"},
        {kind: Up, glyph: "↑", label: "Up"},
        {kind: Mute, glyph: "⇣", label: "Palm mute"},
        {kind: Chuck, glyph: "×", label: "Chuck"},
        {kind: Chop, glyph: "↧", label: "Chop"},
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
            ["Funk Sixteenths", "D.XUX.UXD.XUX.UX"], ["Funk Chops", "c.u...u.c.u..uc."], ["Motown", "....DS......DS.."],
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
            ["Classical", "B321B321A321A321"]]),
        ...style("Rock", [
            ["Arena Chug", "m.mmp.mmm.mmp.mm"], ["Jangle", "dudududududududu"], ["Grunge Stop", "D..D..D.D..D..DS"]]),
        ...style("Metal", [
            ["Chug", "mmm.mmm.mmm.mm.."], ["Gallop Chug", "m.mmm.mmm.mmm.mm"], ["Djent", "m.mm..m.m..mm.m."],
            ["Breakdown", "p..m..m.p..m..mS"], ["Blast", "mmmmmmmmmmmmmmmm"], ["Power Hits", "pS..pS.pS.p.pS.."]]),
        ...style("Funk and Soul", [
            ["Chicken Scratch", "XuXuDuXuXuXuDuXu"], ["Ghost Notes", "DXUXDXUXDXUXDXUX"], ["Stabs", "D.S.....D.S..D.S"]]),
        ...style("Afro and Caribbean", [
            ["Highlife", "1.2.31.2.1.23.2."], ["Soukous", "3232121232321212"], ["Afrobeat", "X.u.X.uuX.u.XuX."],
            ["Calypso", "D.DUUDU.D.DUUDU."]]),
        ...style("Ambient and Cinematic", [
            ["Swell", "D..............."], ["Shimmer", "1.2.1.3.1.2.1.4."], ["Cascade", "6543212345654321"],
            ["Glass", "1...2...3...2..."], ["Heartbeat", "B..B............"]]),
        ...style("Modern Pop", [
            ["Offbeat Pulse", ".d.d.d.d.d.d.d.d"], ["Tresillo", "D..D..D.D..D..D."], ["Tropical", "..u..u.u..u..u.u"],
            ["Bedroom Pop", "d.u.d.uud.u.d.uu"]]),
        ...style("Blues", [
            ["Boogie", "B.B.A.A.B.B.A.A."], ["Stop Time", "DS......DS......"]]),
        ...style("Strumming", [
            ["Build Up", "D.......D.......D...D...D.D.DDDD"], ["Verse to Chorus", "D...D.U...U.D.U.D.DUD.DUD.DUD.DU"]]),
        ...style("Fingerstyle", [
            ["Travis Pinch", "(61).3.(42).3.(51).3.(42).3."], ["Folk Pinch", "(61).2.3.2.(51).2.3.2."],
            ["Double Stops", "6.(12).5.(23).6.(12).5.(23)."], ["Triad Rolls", "(123)...(234)...(123).3.(234)..."],
            ["Harp Thirds", "(13).2.(24).3.(13).2.(24).3."], ["Waltz Pinch", "6.(123).(123).5.(123).(123)."],
            ["Forward Roll", "6.2.1.6.2.1.6.2."], ["Spanish Arpeggio", "(64)321(53)212(64)321(53)212"],
            ["Bass and Pinch", "6.(123).4.(123).5.(123).4.(123)."], ["Rolling Pinch", "(61)23(12)(52)34(23)(61)23(12)(52)34(23)"],
            ["Lullaby", "(61)...3...(12)...3..."]])
    ]

    export const Styles: ReadonlyArray<string> = Array.from(new Set(Library.map(({style}) => style)))
    export const DefaultPattern = Library.findIndex(({name}) => name === "Folk")
    export const SlotCount = 16
    // WASM CONTRACT: the bend amounts mirror `BENDS` in device-guitar
    export const Bends: ReadonlyArray<string> = ["None", "¼", "½", "1", "2"]

    // WASM CONTRACT: a step's bends pack 3 bits per string from the low E, read by `stroke` in device-guitar
    export const bendOf = (bends: int, string: int): int => Math.min(Bends.length - 1, (bends >>> (string * 3)) & 7)

    export const withBend = (bends: int, string: int, amount: int): int =>
        (bends & ~(7 << (string * 3))) | (clamp(amount, 0, Bends.length - 1) << (string * 3))

    export const sanitizeBends = (bends: int): int =>
        Array.from({length: 6}, (_, string) => string).reduce((packed, string) => withBend(packed, string, bendOf(bends, string)), 0)
    export const SeedNames: ReadonlyArray<string> = [
        "Folk", "Pop", "Down Up Eighths", "Ballad Strum", "Rock Eighths", "Power Drive", "Funk Sixteenths", "Reggae",
        "Bossa Nova", "Boom Chick", "Train Beat", "Waltz", "Travis", "Arpeggio Up", "Ballad Picking", "Pinch"
    ]

    export type Step = { readonly kind: int, readonly strings: int, readonly velocity: int, readonly speed: int }

    const treble = 0b111100
    const bass = 0b000111

    export const tokens = (text: string): ReadonlyArray<string> => text.match(/\([1-6]+\)|./g) ?? []

    export const parse = (text: string): ReadonlyArray<Step> => tokens(text).map((letter, index): Step => {
        const accent = index % 4 === 0 ? 95 : index % 2 === 0 ? 80 : 70
        if (letter.startsWith("(")) {
            const strings = Array.from(letter.slice(1, -1)).reduce((mask, digit) => mask | 1 << (6 - Number(digit)), 0)
            return {kind: Pick, strings, velocity: accent, speed: 50}
        }
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
            case "m":
                return {kind: Mute, strings: bass, velocity: accent, speed: 30}
            case "p":
                return {kind: Down, strings: bass, velocity: accent, speed: 30}
            case "X":
                return {kind: Chuck, strings: AllStrings, velocity: 50, speed: 30}
            case "c":
                return {kind: Chop, strings: treble, velocity: accent, speed: 20}
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

    export const write = (pattern: GuitarPattern, steps: ReadonlyArray<Step>, length: int): void => {
        for (let index = 0; index < StepCount; index++) {
            const step = steps[index] ?? {kind: Rest, strings: AllStrings, velocity: 80, speed: 50}
            pattern.stepKinds.getField(index).setValue(step.kind)
            pattern.stepStrings.getField(index).setValue(step.strings)
            pattern.stepVelocities.getField(index).setValue(step.velocity)
            pattern.stepSpeeds.getField(index).setValue(step.speed)
            pattern.stepBends.getField(index).setValue(0)
        }
        pattern.length.setValue(clamp(length, 1, StepCount))
    }

    export const load = (pattern: GuitarPattern, index: int): void => {
        const steps = parse(Library[index].text)
        write(pattern, steps, steps.length)
        pattern.library.setValue(index)
    }

    export type Snapshot = {
        readonly kinds: ReadonlyArray<int>
        readonly strings: ReadonlyArray<int>
        readonly velocities: ReadonlyArray<int>
        readonly speeds: ReadonlyArray<int>
        readonly bends: ReadonlyArray<int>
        readonly length: int
        readonly library: int
    }

    export const snapshot = (pattern: GuitarPattern): Snapshot => ({
        kinds: pattern.stepKinds.fields().map(field => field.getValue()),
        strings: pattern.stepStrings.fields().map(field => field.getValue()),
        velocities: pattern.stepVelocities.fields().map(field => field.getValue()),
        speeds: pattern.stepSpeeds.fields().map(field => field.getValue()),
        bends: pattern.stepBends.fields().map(field => field.getValue()),
        length: pattern.length.getValue(),
        library: pattern.library.getValue()
    })

    export const apply = (pattern: GuitarPattern, {kinds, strings, velocities, speeds, bends, length, library}: Snapshot): void => {
        for (let index = 0; index < StepCount; index++) {
            pattern.stepKinds.getField(index).setValue(clamp(kinds[index] ?? Rest, Rest, Chop))
            pattern.stepStrings.getField(index).setValue((strings[index] ?? AllStrings) & AllStrings)
            pattern.stepVelocities.getField(index).setValue(clamp(velocities[index] ?? 80, 0, 100))
            pattern.stepSpeeds.getField(index).setValue(clamp(speeds[index] ?? 50, 0, 100))
            pattern.stepBends.getField(index).setValue(sanitizeBends(bends[index] ?? 0))
        }
        pattern.length.setValue(clamp(length, 1, StepCount))
        pattern.library.setValue(library >= 0 && library < Library.length ? library : -1)
    }

    export const strums = (kind: int): boolean => kind === Down || kind === Up || kind === Mute || kind === Chop

    // A pick starts without strings, a strum after a stroke that ignored them takes all six again.
    export const setStroke = (pattern: GuitarPattern, index: int, kind: int): void => {
        const previous = pattern.stepKinds.getField(index).getValue()
        if (kind === Pick && previous !== Pick) {
            pattern.stepStrings.getField(index).setValue(0)
            pattern.stepBends.getField(index).setValue(0)
        } else if (strums(kind) && !strums(previous)) {
            pattern.stepStrings.getField(index).setValue(AllStrings)
            pattern.stepBends.getField(index).setValue(0)
        } else if (!strums(kind) && kind !== Pick) {
            pattern.stepBends.getField(index).setValue(0)
        }
        pattern.stepKinds.getField(index).setValue(kind)
        pattern.library.setValue(-1)
    }

    export const setLength = (pattern: GuitarPattern, length: int): void => {
        pattern.length.setValue(clamp(length, 1, StepCount))
        pattern.library.setValue(-1)
    }

    export const slot = (box: GuitarDeviceBox, index: int): GuitarPattern =>
        box.patterns.getField(clamp(index, 0, SlotCount - 1))

    export const seed = (box: GuitarDeviceBox): void => SeedNames.forEach((name, index) =>
        load(slot(box, index), Library.findIndex(pattern => pattern.name === name)))

    // Rotates every lane within the pattern length, positive moves the steps to the left.
    export const rotate = (pattern: GuitarPattern, offset: int): void => {
        const length = pattern.length.getValue()
        for (const array of [pattern.stepKinds, pattern.stepStrings, pattern.stepVelocities, pattern.stepSpeeds, pattern.stepBends]) {
            const fields = array.fields().slice(0, length)
            const values = fields.map(field => field.getValue())
            fields.forEach((field, index) => field.setValue(values[(index + offset + length) % length]))
        }
        pattern.library.setValue(-1)
    }

    export const clear = (pattern: GuitarPattern): void => {
        write(pattern, [], pattern.length.getValue())
        pattern.library.setValue(-1)
    }

    export const nameOf = (index: int): string => Library[index]?.name ?? "Custom"
}
