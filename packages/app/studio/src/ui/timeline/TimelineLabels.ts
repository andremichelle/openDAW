import {
    AnyClipBoxAdapter,
    AnyRegionBoxAdapter,
    AudioClipBoxAdapter,
    AudioRegionBoxAdapter,
    NoteClipBoxAdapter,
    NoteRegionBoxAdapter,
    ValueClipBoxAdapter,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"

const Placeholder = "◻"
const Separator = " · "
const Unresolved = "N/A"

const orPlaceholder = (label: string): string => label.length === 0 ? Placeholder : label

export namespace TimelineLabels {
    export const forRegion = (adapter: AnyRegionBoxAdapter): string => adapter.accept({
        visitNoteRegionBoxAdapter: ({label}: NoteRegionBoxAdapter): string => label,
        visitAudioRegionBoxAdapter: ({label}: AudioRegionBoxAdapter): string => orPlaceholder(label),
        visitValueRegionBoxAdapter: ({label, trackBoxAdapter}: ValueRegionBoxAdapter): string => {
            const parameter = trackBoxAdapter.flatMap(track => track.targetControlName).unwrapOrElse(Unresolved)
            // Recorded automation used to store the parameter name as its label, which would read "Crush · Crush".
            // Migration cannot clear those: parameter names live in the device adapters, not in the saved graph.
            const custom = label.trim()
            return custom.length === 0 || custom.toLowerCase() === parameter.toLowerCase()
                ? parameter
                : `${parameter}${Separator}${custom}`
        }
    }) ?? adapter.label

    export const forClip = (adapter: AnyClipBoxAdapter): string => adapter.accept({
        visitNoteClipBoxAdapter: ({label}: NoteClipBoxAdapter): string => label,
        visitAudioClipBoxAdapter: ({label}: AudioClipBoxAdapter): string => orPlaceholder(label),
        visitValueClipBoxAdapter: ({label}: ValueClipBoxAdapter): string => label
    }) ?? adapter.label
}