import type {Project} from "@opendaw/studio-core"

export const duplicateSelectedRegions = (project: Project): void => {
    const selected = project.regionSelection.selected().filter(region => region.trackBoxAdapter.nonEmpty())
    if (selected.length === 0) {return}
    const offset = Math.ceil(Math.max(...selected.map(region => region.complete))
        - Math.min(...selected.map(region => region.position)))
    project.editing.modify(() => {
        const copies = selected.toSorted((a, b) => b.position - a.position)
            .flatMap(region => project.api.duplicateRegion(region, {position: region.position + offset})
                .mapOr(copy => [copy], []))
        project.regionSelection.deselectAll()
        project.regionSelection.select(...copies)
        copies[0]?.trackBoxAdapter.ifSome(track => project.trackFocus.focus(track))
    })
}
