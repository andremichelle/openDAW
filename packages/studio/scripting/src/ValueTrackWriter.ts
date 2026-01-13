import {ValueEventImpl, ValueRegionImpl, ValueTrackImpl} from "./impl"
import {asDefined, isDefined, UUID} from "@moises-ai/lib-std"
import {AudioUnitBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@moises-ai/studio-boxes"
import {InterpolationFieldAdapter, TrackType} from "@moises-ai/studio-adapters"
import {Box, BoxGraph} from "@moises-ai/lib-box"
import {AnyDevice, ValueRegion} from "./Api"
import {IndexRef} from "./IndexRef"

export class ValueTrackWriter {
    readonly #map: Map<ValueRegion, ValueEventCollectionBox> = new Map()

    write(boxGraph: BoxGraph,
          devices: Map<AnyDevice, Box>,
          audioUnitBox: AudioUnitBox,
          valueTracks: ReadonlyArray<ValueTrackImpl>,
          indexRef: IndexRef): void {
        valueTracks.forEach(({enabled, regions, device, parameter}: ValueTrackImpl) => {
            const box = asDefined(devices.get(device), `Could not find ${device.constructor.name}`)
            const field = box[parameter]
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.enabled.setValue(enabled)
                box.index.setValue(indexRef.index++)
                box.target.refer(field)
                box.tracks.refer(audioUnitBox.tracks)
            })
            regions.forEach((region: ValueRegionImpl) => {
                const {
                    position, duration, loopDuration, loopOffset, events, hue, label, mute, mirror
                } = region
                const valueEventCollectionBox = isDefined(mirror)
                    ? asDefined(this.#map.get(mirror), "mirror region not found in map")
                    : ValueEventCollectionBox.create(boxGraph, UUID.generate())
                this.#map.set(region, valueEventCollectionBox)
                this.#orderValueEvents(events).forEach(event => {
                    const valueEvent = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(event.position)
                        box.value.setValue(event.value)
                        box.slope.setValue(NaN) // deprecated
                        box.index.setValue(event.index)
                        box.events.refer(valueEventCollectionBox.events)
                    })
                    InterpolationFieldAdapter.write(valueEvent.interpolation, event.interpolation)
                })
                ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(loopDuration)
                    box.loopOffset.setValue(loopOffset)
                    box.hue.setValue(hue)
                    box.label.setValue(label)
                    box.mute.setValue(mute)
                    box.regions.refer(trackBox.regions)
                    box.events.refer(valueEventCollectionBox.owners)
                })
            })
        })
    }

    #orderValueEvents(events: ReadonlyArray<ValueEventImpl>): Array<ValueEventImpl> {
        if (events.length === 0) return []
        const sorted = events.toSorted((a, b) => a.position - b.position)
        const result: Array<ValueEventImpl> = []
        let index = 0
        while (index < sorted.length) {
            const position = sorted[index].position
            const start = index
            while (index < sorted.length && sorted[index].position === position) {index++}
            const end = index - 1
            if (start === end) {
                sorted[start].index = 0
                result.push(sorted[start])
            } else {
                if (sorted[start].value === sorted[end].value) {
                    sorted[end].index = 0
                    result.push(sorted[end])
                } else {
                    sorted[start].index = 0
                    sorted[end].index = 1
                    result.push(sorted[start], sorted[end])
                }
            }
        }
        return result
    }
}