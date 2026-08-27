import {Option} from "@opendaw/lib-std"
import {
    AnyClipBoxAdapter,
    AnyRegionBoxAdapter,
    AudioClipBoxAdapter,
    AudioRegionBoxAdapter,
    NoteClipBoxAdapter,
    NoteRegionBoxAdapter,
    TrackBoxAdapter,
    ValueClipBoxAdapter,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"

const Placeholder = "◻"
const Separator = " · "
const Unresolved = "N/A"

const orPlaceholder = (label: string): string => label.length === 0 ? Placeholder : label

// Value clips and regions render their automated parameter name, composed at draw time (#212), with any custom
// label appended behind it. Recorded automation used to store the parameter name as its label, which would read
// "Crush · Crush"; migration cannot clear those (parameter names live in the device adapters, not the saved
// graph), so a custom label equal to the parameter name is treated as no custom label.
const composeValueLabel = (label: string, trackBoxAdapter: Option<TrackBoxAdapter>): string => {
    const parameter = trackBoxAdapter.flatMap(track => track.targetControlName).unwrapOrElse(Unresolved)
    const custom = label.trim()
    return custom.length === 0 || custom.toLowerCase() === parameter.toLowerCase()
        ? parameter
        : `${parameter}${Separator}${custom}`
}

export namespace TimelineLabels {
    export const forRegion = (adapter: AnyRegionBoxAdapter): string => adapter.accept({
        visitNoteRegionBoxAdapter: ({label}: NoteRegionBoxAdapter): string => label,
        visitAudioRegionBoxAdapter: ({label}: AudioRegionBoxAdapter): string => orPlaceholder(label),
        visitValueRegionBoxAdapter: ({label, trackBoxAdapter}: ValueRegionBoxAdapter): string =>
            composeValueLabel(label, trackBoxAdapter)
    }) ?? adapter.label

    export const forClip = (adapter: AnyClipBoxAdapter): string => adapter.accept({
        visitNoteClipBoxAdapter: ({label}: NoteClipBoxAdapter): string => label,
        visitAudioClipBoxAdapter: ({label}: AudioClipBoxAdapter): string => orPlaceholder(label),
        visitValueClipBoxAdapter: ({label, trackBoxAdapter}: ValueClipBoxAdapter): string =>
            composeValueLabel(label, trackBoxAdapter)
    }) ?? adapter.label
}