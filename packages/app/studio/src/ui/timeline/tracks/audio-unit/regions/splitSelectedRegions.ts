import {RegionEditing} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"

export const splitSelectedRegions = (project: Project, position = project.engine.position.getValue()): void => {
    const selected = project.regionSelection.selected().filter(region =>
        region.trackBoxAdapter.nonEmpty() && region.position < position && position < region.complete
        && !region.trackBoxAdapter.flatMap(track => track.optAudioUnit)
            .mapOr(unit => project.audioUnitFreeze.isFrozenUuid(unit.address.uuid), false))
    if (selected.length === 0) {return}
    project.editing.modify(() => {
        selected.forEach(region => RegionEditing.cut(region, position, true))
    })
}
