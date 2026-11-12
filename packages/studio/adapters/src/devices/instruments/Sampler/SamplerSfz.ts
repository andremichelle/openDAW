import {clamp, int, isDefined, Optional} from "@opendaw/lib-std"
import {SamplerImport} from "./SamplerImport"

// An SFZ file as a Sampler instrument. The regions name their samples by path, `samplePaths` lists them in
// the order the zones refer to.
export namespace SamplerSfz {
    export type Result = { readonly instrument: SamplerImport.Instrument, readonly samplePaths: ReadonlyArray<string> }
    type Opcodes = Record<string, string>

    const NoteOffsets: Readonly<Record<string, int>> = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}
    const Inherited: ReadonlyArray<string> = ["global", "master", "group"]

    // a key as a number or a note name, where c4 is 60
    export const parseKey = (text: string): Optional<int> => {
        const trimmed = text.trim().toLowerCase()
        if (/^-?\d+$/.test(trimmed)) {return clamp(parseInt(trimmed), 0, 127)}
        const note = /^([a-g])([#b]?)(-?\d)$/.exec(trimmed)
        if (!isDefined(note)) {return undefined}
        const key = NoteOffsets[note[1]] + (note[2] === "#" ? 1 : note[2] === "b" ? -1 : 0) + (parseInt(note[3]) + 1) * 12
        return key >= 0 && key <= 127 ? key : undefined
    }

    // The headers of the file in order, each with its opcodes. `#define` variables are replaced, comments dropped.
    export const tokenize = (text: string): ReadonlyArray<{ header: string, opcodes: Opcodes }> => {
        const variables = new Map<string, string>()
        const lines = text.replace(/\r/g, "").split("\n").map(line => line.replace(/\/\/.*$/, "")).filter(line => {
            const define = /^\s*#define\s+(\$\w+)\s+(.*?)\s*$/.exec(line)
            if (isDefined(define)) {variables.set(define[1], define[2])}
            return !/^\s*#/.test(line)
        })
        const names = Array.from(variables.keys()).sort((shorter, longer) => longer.length - shorter.length)
        const source = names.reduce((result, name) => result.split(name).join(variables.get(name) ?? ""), lines.join("\n"))
        const sections: Array<{ header: string, opcodes: Opcodes }> = []
        const pattern = /<(\w+)>|([A-Za-z_][\w]*)=/g
        let pending: Optional<{ name: string, from: int }> = undefined
        const close = (until: int): void => {
            if (!isDefined(pending)) {return}
            const section = sections.at(-1)
            if (isDefined(section)) {section.opcodes[pending.name] = source.slice(pending.from, until).trim()}
            pending = undefined
        }
        for (let match = pattern.exec(source); isDefined(match); match = pattern.exec(source)) {
            close(match.index)
            if (isDefined(match[1])) {
                sections.push({header: match[1].toLowerCase(), opcodes: {}})
            } else {
                pending = {name: match[2].toLowerCase(), from: pattern.lastIndex}
            }
        }
        close(source.length)
        return sections
    }

    export const parse = (text: string, name: string): Result => {
        const samplePaths: Array<string> = []
        const groups: Array<SamplerImport.Group> = []
        const zones: Array<SamplerImport.Zone> = []
        const scope: Record<string, Opcodes> = {}
        let control: Opcodes = {}
        let envelope: Optional<SamplerImport.Envelope> = undefined
        let filter: Optional<SamplerImport.Filter> = undefined
        const groupFor = (roundRobin: int, choke: int, trigger: int): int => {
            const existing = groups.findIndex(group => group.roundRobin === roundRobin && group.choke === choke && group.trigger === trigger)
            if (existing >= 0) {return existing}
            const label = trigger === 1 ? "Release" : choke > 0 ? `Choke ${choke}` : `Group ${groups.length + 1}`
            groups.push({label, roundRobin, choke, trigger})
            return groups.length - 1
        }
        tokenize(text).forEach(({header, opcodes}) => {
            if (header === "control") {
                control = {...control, ...opcodes}
                return
            }
            if (Inherited.includes(header)) {
                // a header resets the ones nested below it
                Inherited.slice(Inherited.indexOf(header)).forEach(lower => delete scope[lower])
                scope[header] = opcodes
                return
            }
            if (header !== "region") {return}
            const region: Opcodes = {...scope["global"], ...scope["master"], ...scope["group"], ...opcodes}
            const number = (key: string): Optional<number> => {
                const value = isDefined(region[key]) ? parseFloat(region[key]) : NaN
                return Number.isFinite(value) ? value : undefined
            }
            const key = (name: string): Optional<int> => isDefined(region[name]) ? parseKey(region[name]) : undefined
            const path = region["sample"]
            if (!isDefined(path) || path.length === 0 || path.startsWith("*")) {return}
            const fullPath = `${control["default_path"] ?? ""}${path}`.replace(/\\/g, "/")
            const known = samplePaths.indexOf(fullPath)
            const sample = known >= 0 ? known : samplePaths.push(fullPath) - 1
            const single = key("key")
            const keyLow = key("lokey") ?? single ?? 0
            const keyHigh = key("hikey") ?? single ?? 127
            const sequenceLength = number("seq_length") ?? 1
            const random = isDefined(region["lorand"]) || isDefined(region["hirand"])
            const chokeGroup = number("group") ?? 0
            const choke = chokeGroup > 0 && number("off_by") === chokeGroup ? clamp(chokeGroup, 1, 127) : 0
            const mode = (region["loop_mode"] ?? region["loopmode"] ?? "").toLowerCase()
            const loopStart = number("loop_start") ?? number("loopstart")
            const loopEnd = number("loop_end") ?? number("loopend")
            const end = number("end")
            const cents = number("tune") ?? 0
            zones.push({
                sample,
                group: groupFor(random ? 2 : sequenceLength > 1 ? 1 : 0, choke, (region["trigger"] ?? "").toLowerCase() === "release" ? 1 : 0),
                keyLow,
                keyHigh: Math.max(keyLow, keyHigh),
                velocityLow: clamp(number("lovel") ?? 1, 1, 127),
                velocityHigh: clamp(number("hivel") ?? 127, 1, 127),
                rootKey: key("pitch_keycenter") ?? single ?? 60,
                transpose: clamp((number("transpose") ?? 0) + Math.trunc(cents / 100), -24, 24),
                tune: cents % 100,
                keyTrack: clamp((number("pitch_keytrack") ?? 100) / 100.0, 0.0, 1.0),
                gain: number("volume") ?? 0.0,
                panning: clamp((number("pan") ?? 0) / 100.0, -1.0, 1.0),
                sequence: clamp(number("seq_position") ?? (random ? Math.round((number("lorand") ?? 0) * 100) + 1 : 1), 1, 128),
                reverse: (region["direction"] ?? "").toLowerCase() === "reverse",
                oneShot: mode === "one_shot",
                sampleStart: Math.max(0, number("offset") ?? 0),
                sampleEnd: isDefined(end) && end > 0 ? end + 1 : undefined,
                // loop points without a mode loop, as the format says
                loopMode: mode === "loop_continuous" || (mode === "" && isDefined(loopEnd)) ? 2 : mode === "loop_sustain" ? 1 : 0,
                loopStart: Math.max(0, loopStart ?? 0),
                loopEnd: isDefined(loopEnd) ? loopEnd + 1 : undefined
            })
            if (!isDefined(envelope)) {
                envelope = {
                    delay: number("ampeg_delay") ?? 0.0,
                    attack: number("ampeg_attack") ?? 0.001,
                    hold: number("ampeg_hold") ?? 0.0,
                    decay: number("ampeg_decay") ?? 0.001,
                    sustain: clamp((number("ampeg_sustain") ?? 100.0) / 100.0, 0.0, 1.0),
                    release: number("ampeg_release") ?? 0.001
                }
                const cutoff = number("cutoff")
                if (isDefined(cutoff)) {filter = {cutoff, resonance: clamp((number("resonance") ?? 0.0) / 40.0, 0.0, 1.0)}}
            }
        })
        return {instrument: {name, groups, zones, envelope, filter}, samplePaths}
    }
}
