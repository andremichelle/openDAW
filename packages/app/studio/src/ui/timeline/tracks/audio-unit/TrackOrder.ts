import {Arrays, int, Option} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {
    BoxAdapters, DeviceBoxAdapter, DeviceHost, Devices, InstrumentCompositeCellBoxAdapter, PlayfieldSampleBoxAdapter,
    TrackBoxAdapter, TrackType
} from "@opendaw/studio-adapters"

export namespace TrackOrder {
    // Group order within a unit (mirrors the device panel): instrument tracks, midi-fx automation, instrument
    // automation, audio-fx automation. `path` is the device's index chain from the unit's chain down through
    // nested composites (composite index, cell/slot index, inner device index, ...), compared lexicographically,
    // so one device's automation stays together and nested devices sort right after their composite.
    export type Key = {category: int, path: ReadonlyArray<int>}

    const InstrumentTracks: Key = {category: 0, path: Arrays.empty()}
    const Unresolved: Key = {category: 9, path: Arrays.empty()}

    // A composite's nested chain host (FX Composite cell, Playfield slot) with its branch index and owning device.
    const nestedHost = (host: DeviceHost): Option<{parent: DeviceBoxAdapter, index: int}> =>
        host.asCompositeCell().match<Option<{parent: DeviceBoxAdapter, index: int}>>({
            some: cell => Option.wrap({parent: cell.compositeDevice(), index: cell.indexField.getValue()}),
            none: () => host instanceof PlayfieldSampleBoxAdapter
                ? Option.wrap({parent: host.device(), index: host.indexField.getValue()})
                : Option.None
        })

    // Inside an instrument LAYER the three device kinds share one host, so they rank like on an audio unit.
    const kindRank = (adapter: DeviceBoxAdapter): int =>
        Devices.isMidiEffect(adapter) ? 1 : Devices.isInstrument(adapter) ? 2 : Devices.isAudioEffect(adapter) ? 3 : 9

    const deviceOrderKey = (adapter: DeviceBoxAdapter): Key => {
        const ownIndex = Devices.isEffect(adapter) ? adapter.indexField.getValue() : 0
        const host = adapter.deviceHost()
        if (host.isAudioUnit) {
            const category = Devices.isMidiEffect(adapter) ? 1
                : Devices.isInstrument(adapter) ? 2
                    : Devices.isAudioEffect(adapter) ? 3 : 9
            return {category, path: [ownIndex]}
        }
        return nestedHost(host).match({
            none: () => ({category: 9, path: [ownIndex]}),
            some: ({parent, index}) => {
                const outer = deviceOrderKey(parent)
                return host instanceof InstrumentCompositeCellBoxAdapter
                    ? {category: outer.category, path: [...outer.path, index, kindRank(adapter), ownIndex]}
                    : {category: outer.category, path: [...outer.path, index, ownIndex]}
            }
        })
    }

    // An indirectly targeted parameter (modular) reaches its device through a Parameter edge
    // (mirrors TrackBoxAdapter#resolveOwnerDeviceBox).
    const ownerDeviceBox = (box: Box): Option<Box> => {
        for (const [pointer] of box.outgoingEdges()) {
            if (pointer.pointerType === Pointers.Parameter) {
                return pointer.targetVertex.map(vertex => vertex.box)
            }
        }
        return Option.None
    }

    export const keyOf = (boxAdapters: BoxAdapters, adapter: TrackBoxAdapter): Key => {
        if (adapter.type !== TrackType.Value) {return InstrumentTracks}
        return adapter.target.targetVertex.match({
            none: () => Unresolved,
            some: targetVertex => {
                const box = targetVertex.box
                // A LAYER's own strip (gain / pan / mute / solo) leads that layer's lanes.
                const layer = boxAdapters.optAdapter(box).flatMap(target =>
                    target instanceof InstrumentCompositeCellBoxAdapter ? Option.wrap(target) : Option.None)
                if (layer.nonEmpty()) {
                    const cell = layer.unwrap()
                    const outer = deviceOrderKey(cell.compositeDevice())
                    return {category: outer.category, path: [...outer.path, cell.indexField.getValue(), 0]}
                }
                const direct = boxAdapters.optAdapter(box).flatMap(deviceAdapter =>
                    Devices.isAny(deviceAdapter) ? Option.wrap(deviceAdapter) : Option.None)
                const resolved = direct.nonEmpty()
                    ? direct
                    : ownerDeviceBox(box)
                        .flatMap(owner => boxAdapters.optAdapter(owner))
                        .flatMap(deviceAdapter =>
                            Devices.isAny(deviceAdapter) ? Option.wrap(deviceAdapter) : Option.None)
                return resolved.mapOr(deviceOrderKey, Unresolved)
            }
        })
    }

    const comparePaths = (a: ReadonlyArray<int>, b: ReadonlyArray<int>): int => {
        const shared = Math.min(a.length, b.length)
        for (let level = 0; level < shared; level++) {
            if (a[level] !== b[level]) {return a[level] - b[level]}
        }
        return a.length - b.length
    }

    export const compare = (a: Key, b: Key): int =>
        a.category !== b.category ? a.category - b.category : comparePaths(a.path, b.path)
}
