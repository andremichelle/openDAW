import {asInstanceOf, isInstanceOf} from "@opendaw/lib-std"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, RegionOverlap, UnionBoxTypes} from "@opendaw/studio-adapters"
import type {LocalLayer} from "../ysync"
import type {Project} from "../project"
import {RecordTrack} from "./RecordTrack"

export namespace RoomTake {
    // what the room changed during the take decides the track and index the take finally lands on
    export const settle = ({editing}: Project, layer: LocalLayer): void => {
        layer.run(() => editing.modify(() => {
            const boxes = layer.boxes()
            boxes.filter(box => isInstanceOf(box, TrackBox)).forEach(box => settleIndex(asInstanceOf(box, TrackBox)))
            const tracks = new Set<TrackBox>()
            boxes.forEach(box => {
                if (!UnionBoxTypes.isRegionBox(box)) {return}
                box.regions.targetVertex.ifSome(vertex => tracks.add(asInstanceOf(vertex.box, TrackBox)))
            })
            tracks.forEach(track => settleOverlap(track, layer))
        }, false))
    }

    const unitOf = (track: TrackBox): AudioUnitBox =>
        asInstanceOf(track.tracks.targetVertex.unwrap("track without a unit").box, AudioUnitBox)

    const settleIndex = (track: TrackBox): void => {
        const unit = unitOf(track)
        const taken = unit.tracks.pointerHub.incoming().some(({box}) => box !== track
            && asInstanceOf(box, TrackBox).index.getValue() === track.index.getValue())
        if (taken) {track.index.setValue(RecordTrack.nextIndex(unit))}
    }

    const settleOverlap = (track: TrackBox, layer: LocalLayer): void => {
        if (RegionOverlap.find(RegionOverlap.sortedRegions(track)).isEmpty()) {return}
        const regions = RegionOverlap.sortedRegions(track)
        const others = regions.filter(region => !layer.owns(region.address.uuid))
        regions.filter(region => layer.owns(region.address.uuid)).forEach(take => others.forEach(other => clip(other, take)))
    }

    // automation overwrites what it was recorded over, like it does on one client
    const clip = (other: AnyRegionBox, take: AnyRegionBox): void => {
        if (!other.isAttached()) {return}
        const takeStart = take.position.getValue()
        const takeEnd = takeStart + take.duration.getValue()
        const start = other.position.getValue()
        const end = start + other.duration.getValue()
        if (end <= takeStart || start >= takeEnd) {return}
        if (start < takeStart) {
            other.duration.setValue(takeStart - start)
            other.loopDuration.setValue(Math.min(other.loopDuration.getValue(), takeStart - start))
        } else if (end > takeEnd) {
            other.position.setValue(takeEnd)
            other.duration.setValue(end - takeEnd)
        } else {
            other.delete()
        }
    }
}
