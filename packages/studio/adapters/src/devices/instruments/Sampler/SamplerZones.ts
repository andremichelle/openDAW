import {Arrays, clamp, int, isDefined, Optional, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioFileBox, SamplerDeviceBox, SamplerGroupBox, SamplerZoneBox} from "@opendaw/studio-boxes"

// Creating, mapping and removing the sample zones of a Sampler. Everything edits boxes directly, the caller
// wraps it in one modification.
export namespace SamplerZones {
    export type Parsed = { readonly key: Optional<int>, readonly layer: Optional<int>, readonly robin: Optional<int> }

    const NoteOffsets: Readonly<Record<string, int>> = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}
    const Dynamics: ReadonlyArray<string> = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]
    const MinKey: int = 0
    const MaxKey: int = 127
    const MinVelocity: int = 1
    const MaxVelocity: int = 127
    const KeyFade: int = 2
    const VelocityFade: int = 8

    export const createGroup = (boxGraph: BoxGraph, device: SamplerDeviceBox, label: string): SamplerGroupBox => {
        const index = device.groups.pointerHub.incoming().reduce((highest, {box}) =>
            Math.max(highest, (box as SamplerGroupBox).index.getValue() + 1), 0)
        return SamplerGroupBox.create(boxGraph, UUID.generate(), box => {
            box.device.refer(device.groups)
            box.index.setValue(index)
            box.label.setValue(label)
        })
    }

    export const create = (boxGraph: BoxGraph, device: SamplerDeviceBox, group: SamplerGroupBox,
                           file: AudioFileBox): SamplerZoneBox =>
        SamplerZoneBox.create(boxGraph, UUID.generate(), box => {
            box.device.refer(device.zones)
            box.group.refer(group.zones)
            box.file.refer(file)
            box.index.setValue(device.zones.pointerHub.size())
        })

    // a sample no zone uses any more goes with its last zone
    export const remove = (zones: ReadonlyArray<SamplerZoneBox>): void => {
        const files = zones.map(zone => zone.file.targetVertex.unwrapOrNull()?.box)
        zones.forEach(zone => zone.delete())
        new Set(files).forEach(file => {
            if (isDefined(file) && file.isAttached() && file.pointerHub.isEmpty()) {file.delete()}
        })
    }

    export const disable = (zones: ReadonlyArray<SamplerZoneBox>): void =>
        zones.forEach(zone => zone.enabled.setValue(false))

    // removes every zone that was taken off the map, and with it the samples nothing else plays
    export const cleanUp = (device: SamplerDeviceBox): int => {
        const unused = zonesOf(device).filter(zone => !zone.enabled.getValue())
        remove(unused)
        return unused.length
    }

    export const zonesOf = (device: SamplerDeviceBox): ReadonlyArray<SamplerZoneBox> =>
        device.zones.pointerHub.incoming().map(({box}) => box as SamplerZoneBox)

    export const sharesRange = (zone: SamplerZoneBox, other: SamplerZoneBox): boolean =>
        zone.group.targetVertex.unwrapOrNull() === other.group.targetVertex.unwrapOrNull()
        && zone.keyLow.getValue() === other.keyLow.getValue() && zone.keyHigh.getValue() === other.keyHigh.getValue()
        && zone.velocityLow.getValue() === other.velocityLow.getValue()
        && zone.velocityHigh.getValue() === other.velocityHigh.getValue()

    // Reads what a file name says about its sample. Notes are scientific pitch, C4 is key 60, as sample
    // libraries write them. A dynamic is `pp` to `fff` or a numbered layer (`v3`, `vl3`), a round robin `rr2`.
    export const parseName = (name: string): Parsed => {
        const stem = name.replace(/\.[A-Za-z0-9]+$/, "")
        const note = /(?:^|[_\-\s.])([A-Ga-g])([#sb]?)(-?\d)(?=$|[_\-\s.])/.exec(stem)
        // the last one counts: a name may start with a letter that reads like a dynamic ("P_C4_ff")
        const dynamic = Array.from(stem.matchAll(/(?:^|[_\-\s.])(ppp|pp|p|mp|mf|ff|fff|f)(?=$|[_\-\s.])/gi)).at(-1)
        const layer = /(?:^|[_\-\s.])vl?(\d+)(?=$|[_\-\s.])/i.exec(stem)
        const robin = /(?:^|[_\-\s.])rr(\d+)(?=$|[_\-\s.])/i.exec(stem)
        const key = isDefined(note)
            ? NoteOffsets[note[1].toLowerCase()] + (note[2] === "b" ? -1 : note[2] === "" ? 0 : 1) + (parseInt(note[3]) + 1) * 12
            : undefined
        return {
            key: isDefined(key) && key >= MinKey && key <= MaxKey ? key : undefined,
            layer: isDefined(layer) ? parseInt(layer[1]) : isDefined(dynamic) ? Dynamics.indexOf(dynamic[1].toLowerCase()) : undefined,
            robin: isDefined(robin) ? parseInt(robin[1]) : undefined
        }
    }

    const fileNameOf = (zone: SamplerZoneBox): string =>
        zone.file.targetVertex.mapOr(({box}) => (box as AudioFileBox).fileName.getValue(), "")

    // Maps zones from their file names: the note becomes root and key, dynamics become velocity layers, round
    // robin numbers the sequence. Then the keys are spread, so no key between two samples stays empty.
    export const mapByName = (zones: ReadonlyArray<SamplerZoneBox>): void => {
        const parsed = zones.map(zone => ({zone, ...parseName(fileNameOf(zone))}))
        parsed.forEach(({zone, key, robin}) => {
            if (isDefined(key)) {
                zone.rootKey.setValue(key)
                zone.keyLow.setValue(key)
                zone.keyHigh.setValue(key)
            }
            if (isDefined(robin)) {zone.sequence.setValue(clamp(robin, 1, 128))}
        })
        const layered = parsed.filter(({layer}) => isDefined(layer))
        const keys = new Set(layered.map(({zone}) => zone.keyLow.getValue()))
        keys.forEach(key => {
            const column = layered.filter(({zone}) => zone.keyLow.getValue() === key)
            const layers = Arrays.removeDuplicates(column.map(({layer}) => layer ?? 0)).sort((a, b) => a - b)
            column.forEach(({zone, layer}) => {
                const [low, high] = layerRange(layers.indexOf(layer ?? 0), layers.length)
                zone.velocityLow.setValue(low)
                zone.velocityHigh.setValue(high)
            })
        })
        spreadKeys(zones)
    }

    const layerRange = (index: int, count: int): [int, int] => [
        index === 0 ? MinVelocity : Math.round(index * MaxVelocity / count) + 1,
        Math.round((index + 1) * MaxVelocity / count)
    ]

    // each zone reaches halfway to the neighbouring roots
    export const spreadKeys = (zones: ReadonlyArray<SamplerZoneBox>): void => {
        const roots = Arrays.removeDuplicates(zones.map(zone => zone.rootKey.getValue())).sort((a, b) => a - b)
        zones.forEach(zone => {
            const root = zone.rootKey.getValue()
            const index = roots.indexOf(root)
            if (index > 0) {zone.keyLow.setValue(Math.floor((roots[index - 1] + root) / 2) + 1)}
            if (index < roots.length - 1) {zone.keyHigh.setValue(Math.floor((root + roots[index + 1]) / 2))}
        })
    }

    // the layers on the same keys of a group share the velocity range evenly
    export const spreadVelocity = (zones: ReadonlyArray<SamplerZoneBox>): void => {
        const columnOf = (zone: SamplerZoneBox): string =>
            `${zone.group.targetAddress.mapOr(address => address.toString(), "")}/${zone.keyLow.getValue()}/${zone.keyHigh.getValue()}`
        const columns = new Map<string, Array<SamplerZoneBox>>()
        zones.forEach(zone => columns.set(columnOf(zone), [...columns.get(columnOf(zone)) ?? [], zone]))
        columns.forEach(column => {
            const layers = Arrays.removeDuplicates(column.map(zone => zone.velocityLow.getValue())).sort((a, b) => a - b)
            const targets = column.map(zone => layerRange(layers.indexOf(zone.velocityLow.getValue()), layers.length))
            column.forEach((zone, index) => {
                zone.velocityLow.setValue(targets[index][0])
                zone.velocityHigh.setValue(targets[index][1])
            })
        })
    }

    // neighbours among the zones reach into each other and fade over the overlap
    export const crossfade = (zones: ReadonlyArray<SamplerZoneBox>): void => {
        const sameGroup = (zone: SamplerZoneBox, other: SamplerZoneBox): boolean =>
            zone.group.targetVertex.unwrapOrNull() === other.group.targetVertex.unwrapOrNull()
        const changes = zones.map(zone => {
            const [keyLow, keyHigh] = [zone.keyLow.getValue(), zone.keyHigh.getValue()]
            const [velocityLow, velocityHigh] = [zone.velocityLow.getValue(), zone.velocityHigh.getValue()]
            const beside = zones.filter(other => other !== zone && sameGroup(zone, other)
                && other.velocityLow.getValue() <= velocityHigh && other.velocityHigh.getValue() >= velocityLow)
            const stacked = zones.filter(other => other !== zone && sameGroup(zone, other)
                && other.keyLow.getValue() <= keyHigh && other.keyHigh.getValue() >= keyLow)
            const keysUntouched = zone.keyFade.getValue() === 0
            const velocitiesUntouched = zone.velocityFade.getValue() === 0
            return {
                zone,
                keyLow: keysUntouched && beside.some(other => other.keyHigh.getValue() === keyLow - 1) ? keyLow - 1 : keyLow,
                keyHigh: keysUntouched && beside.some(other => other.keyLow.getValue() === keyHigh + 1) ? keyHigh + 1 : keyHigh,
                velocityLow: velocitiesUntouched && stacked.some(other => other.velocityHigh.getValue() === velocityLow - 1)
                    ? velocityLow - VelocityFade / 2 : velocityLow,
                velocityHigh: velocitiesUntouched && stacked.some(other => other.velocityLow.getValue() === velocityHigh + 1)
                    ? velocityHigh + VelocityFade / 2 : velocityHigh
            }
        })
        changes.forEach(({zone, keyLow, keyHigh, velocityLow, velocityHigh}) => {
            if (keyLow !== zone.keyLow.getValue() || keyHigh !== zone.keyHigh.getValue()) {zone.keyFade.setValue(KeyFade)}
            if (velocityLow !== zone.velocityLow.getValue() || velocityHigh !== zone.velocityHigh.getValue()) {
                zone.velocityFade.setValue(VelocityFade)
            }
            zone.keyLow.setValue(clamp(keyLow, MinKey, MaxKey))
            zone.keyHigh.setValue(clamp(keyHigh, MinKey, MaxKey))
            zone.velocityLow.setValue(clamp(velocityLow, MinVelocity, MaxVelocity))
            zone.velocityHigh.setValue(clamp(velocityHigh, MinVelocity, MaxVelocity))
        })
    }

    export const rootToLow = (zones: ReadonlyArray<SamplerZoneBox>): void =>
        zones.forEach(zone => zone.rootKey.setValue(zone.keyLow.getValue()))

    // copies each zone onto the same keys as a further round robin
    export const duplicate = (boxGraph: BoxGraph, device: SamplerDeviceBox,
                              zones: ReadonlyArray<SamplerZoneBox>): ReadonlyArray<SamplerZoneBox> => {
        const all = zonesOf(device)
        return zones.map(zone => {
            const robins = all.filter(other => sharesRange(zone, other)).length
            return SamplerZoneBox.create(boxGraph, UUID.generate(), box => {
                box.device.refer(device.zones)
                zone.group.targetVertex.ifSome(target => box.group.refer(target))
                zone.file.targetVertex.ifSome(target => box.file.refer(target))
                box.index.setValue(device.zones.pointerHub.size())
                box.enabled.setValue(zone.enabled.getValue())
                box.keyLow.setValue(zone.keyLow.getValue())
                box.keyHigh.setValue(zone.keyHigh.getValue())
                box.keyFade.setValue(zone.keyFade.getValue())
                box.rootKey.setValue(zone.rootKey.getValue())
                box.velocityLow.setValue(zone.velocityLow.getValue())
                box.velocityHigh.setValue(zone.velocityHigh.getValue())
                box.velocityFade.setValue(zone.velocityFade.getValue())
                box.transpose.setValue(zone.transpose.getValue())
                box.tune.setValue(zone.tune.getValue())
                box.keyTrack.setValue(zone.keyTrack.getValue())
                box.gain.setValue(zone.gain.getValue())
                box.panning.setValue(zone.panning.getValue())
                box.sequence.setValue(clamp(robins + 1, 1, 128))
                box.reverse.setValue(zone.reverse.getValue())
                box.oneShot.setValue(zone.oneShot.getValue())
                box.sampleStart.setValue(zone.sampleStart.getValue())
                box.sampleEnd.setValue(zone.sampleEnd.getValue())
                box.loopMode.setValue(zone.loopMode.getValue())
                box.loopStart.setValue(zone.loopStart.getValue())
                box.loopEnd.setValue(zone.loopEnd.getValue())
                box.loopFade.setValue(zone.loopFade.getValue())
            })
        })
    }

    export const moveToGroup = (zones: ReadonlyArray<SamplerZoneBox>, group: SamplerGroupBox): void =>
        zones.forEach(zone => zone.group.refer(group.zones))
}
