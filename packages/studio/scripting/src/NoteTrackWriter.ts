import {NoteRegionImpl, NoteTrackImpl} from "./impl"
import {asDefined, isDefined, UUID} from "@moises-ai/lib-std"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@moises-ai/studio-boxes"
import {TrackType} from "@moises-ai/studio-adapters"
import {BoxGraph} from "@moises-ai/lib-box"
import {NoteRegion} from "./Api"
import {IndexRef} from "./IndexRef"

export class NoteTrackWriter {
    readonly #map: Map<NoteRegion, NoteEventCollectionBox> = new Map()

    write(boxGraph: BoxGraph,
          audioUnitBox: AudioUnitBox,
          noteTracks: ReadonlyArray<NoteTrackImpl>,
          indexRef: IndexRef): void {
        noteTracks.forEach(({enabled, regions}: NoteTrackImpl) => {
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Notes)
                box.enabled.setValue(enabled)
                box.index.setValue(indexRef.index++)
                box.target.refer(audioUnitBox)
                box.tracks.refer(audioUnitBox.tracks)
            })
            regions.forEach((region: NoteRegionImpl) => {
                const {
                    position, duration, loopDuration, loopOffset, events, hue, label, mute, mirror
                } = region
                const noteEventCollectionBox = isDefined(mirror)
                    ? asDefined(this.#map.get(mirror), "mirror region not found in map")
                    : NoteEventCollectionBox.create(boxGraph, UUID.generate())
                this.#map.set(region, noteEventCollectionBox)
                events.forEach(event => {
                    NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(event.position)
                        box.duration.setValue(event.duration)
                        box.pitch.setValue(event.pitch)
                        box.cent.setValue(event.cents) // TODO rename to plural
                        box.velocity.setValue(event.velocity)
                        box.events.refer(noteEventCollectionBox.events)
                    })
                })
                NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(loopDuration)
                    box.loopOffset.setValue(loopOffset)
                    box.hue.setValue(hue)
                    box.label.setValue(label)
                    box.mute.setValue(mute)
                    box.regions.refer(trackBox.regions)
                    box.events.refer(noteEventCollectionBox.owners)
                })
            })
        })
    }
}