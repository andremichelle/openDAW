import {Color, int} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Colors} from "@opendaw/studio-enums"

export namespace SamplerModel {
    export type ZoneKey = "group" | "sequence" | "keyLo" | "keyHi" | "velLo" | "velHi" | "rootKey" | "keyFade"
        | "velFade" | "coarse" | "tune" | "track" | "gain" | "pan" | "start" | "end" | "reverse" | "oneShot" | "loopMode"
        | "loopStart" | "loopEnd" | "loopFade" | "decay"
    export type Zone = Record<ZoneKey, number> & { name: string }
    export type GroupKey = "robin" | "choke" | "trigger" | "gain"
    export type Group = Record<GroupKey, number> & { readonly name: string, readonly color: Color }
    export type Instrument = {
        readonly name: string
        readonly groups: ReadonlyArray<Group>
        readonly zones: Array<Zone>
        readonly samples: Array<string>
    }

    export const RobinModes: ReadonlyArray<string> = ["Off", "Cycle", "Random"]
    export const Triggers: ReadonlyArray<string> = ["Attack", "Release"]
    // On loops while the key is held and plays out on release, Always keeps looping through the release
    export const LoopModes: ReadonlyArray<string> = ["Off", "On", "Always"]

    const zone = (name: string, group: int, keyLo: int, keyHi: int, velLo: int, velHi: int, rootKey: int,
                  overrides: Partial<Record<ZoneKey, number>> = {}): Zone => ({
        name, group, sequence: 1, keyLo, keyHi, velLo, velHi, rootKey, keyFade: 0, velFade: 0, coarse: 0, tune: 0, track: 100,
        gain: 0, pan: 0, start: 0, end: 1, reverse: 0, oneShot: 0, loopMode: 0, loopStart: 0.4, loopEnd: 0.9,
        loopFade: 0.05, decay: 4, ...overrides
    })
    const group = (name: string, color: Color, overrides: Partial<Record<GroupKey, number>> = {}): Group =>
        ({name, color, robin: 0, choke: 0, trigger: 0, gain: 0, ...overrides})
    const layers = (count: int): ReadonlyArray<[int, int]> => Array.from({length: count}, (_, index) =>
        [index === 0 ? 1 : Math.round(index * 127 / count) + 1, Math.round((index + 1) * 127 / count)])

    const piano = (): Instrument => {
        const dynamics: ReadonlyArray<string> = ["pp", "mf", "ff"]
        const zones: Array<Zone> = []
        for (let root = 21; root <= 108; root += 3) {
            layers(3).forEach(([velLo, velHi], layer) => zones.push(zone(
                `Upright_${MidiKeys.toFullString(root)}_${dynamics[layer]}.wav`, 0, Math.max(root - 1, 21),
                Math.min(root + 1, 108), velLo, velHi, root, {decay: 2 + (root - 21) / 12})))
        }
        return {name: "Upright Piano", groups: [group("Sustain", Colors.blue)], zones, samples: zones.map(({name}) => name)}
    }

    // the same samples as dropped in, before any mapping
    const dropped = (): Instrument => {
        const {zones} = piano()
        zones.forEach(entry => {
            entry.keyLo = entry.keyHi = entry.rootKey = 60
            entry.velLo = 1
            entry.velHi = 127
        })
        return {name: "Dropped Samples", groups: [group("Sustain", Colors.blue)], zones, samples: zones.map(({name}) => name)}
    }

    const drums = (): Instrument => {
        const zones: Array<Zone> = []
        const drum = (name: string, groupIndex: int, key: int, numLayers: int, robins: int, decay: number) =>
            layers(numLayers).forEach(([velLo, velHi], layer) => {
                for (let robin = 1; robin <= robins; robin++) {
                    zones.push(zone(`${name}_v${layer + 1}_rr${robin}.wav`, groupIndex, key, key, velLo, velHi, key,
                        {sequence: robin, oneShot: 1, track: 0, decay}))
                }
            })
        drum("Kick", 0, 36, 4, 3, 9)
        drum("Rim", 1, 37, 2, 2, 14)
        drum("Snare", 1, 38, 4, 4, 8)
        drum("SnareEdge", 1, 40, 4, 4, 8)
        drum("HatClosed", 2, 42, 3, 4, 16)
        drum("HatPedal", 2, 44, 3, 2, 14)
        drum("HatOpen", 2, 46, 3, 2, 4)
        drum("TomFloor", 3, 41, 3, 2, 5)
        drum("TomLow", 3, 45, 3, 2, 6)
        drum("TomMid", 3, 47, 3, 2, 6)
        drum("TomHigh", 3, 50, 3, 2, 7)
        drum("Crash", 4, 49, 2, 2, 2)
        drum("Ride", 4, 51, 3, 2, 3)
        drum("RideBell", 4, 53, 2, 2, 3)
        drum("Splash", 4, 55, 2, 1, 4)
        return {
            name: "Studio Kit",
            groups: [
                group("Kick", Colors.blue, {robin: 1}),
                group("Snare", Colors.yellow, {robin: 1}),
                group("Hats", Colors.green, {robin: 2, choke: 1}),
                group("Toms", Colors.purple, {robin: 1}),
                group("Cymbals", Colors.cream, {robin: 1})
            ],
            zones, samples: zones.map(({name}) => name)
        }
    }

    const organ = (): Instrument => {
        const zones: Array<Zone> = []
        const stop = (name: string, groupIndex: int, low: int, high: int, gain: number) => {
            for (let root = low + 1; root <= high; root += 4) {
                zones.push(zone(`${name}_${MidiKeys.toFullString(root)}.wav`, groupIndex, root - 1,
                    Math.min(root + 2, high), 1, 127, root, {loopMode: 1, decay: 0, gain}))
            }
        }
        stop("Principal8", 0, 36, 96, 0)
        stop("Flute4", 1, 48, 96, -6)
        stop("Release", 2, 36, 96, -12)
        return {
            name: "Chamber Organ",
            groups: [
                group("Principal 8'", Colors.blue),
                group("Flute 4'", Colors.green),
                group("Release", Colors.purple, {trigger: 1})
            ],
            zones, samples: zones.map(({name}) => name)
        }
    }

    export const create = (): ReadonlyArray<Instrument> => [piano(), drums(), organ(), dropped()]
}
