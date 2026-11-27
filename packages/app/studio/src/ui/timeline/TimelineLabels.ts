import {Option} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {
    AnyClipBoxAdapter,
    AnyRegionBoxAdapter,
    AudioClipBoxAdapter,
    AudioRegionBoxAdapter,
    Grooves,
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
    export const withGain = (label: string, gain: number): string => {
        if (Math.round(gain * 10.0) === 0) {return label}
        const text = Number.isFinite(gain) ? `${gain > 0.0 ? "+" : ""}${gain.toFixed(1)}` : "-∞"
        return `${label} ${text} dB`
    }

    export const forRegion = (adapter: AnyRegionBoxAdapter): string => adapter.accept({
        visitNoteRegionBoxAdapter: ({label}: NoteRegionBoxAdapter): string => label,
        visitAudioRegionBoxAdapter: ({label, gain}: AudioRegionBoxAdapter): string =>
            withGain(orPlaceholder(label), gain.getValue()),
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

    export const grooveOf = (box: Box): Option<string> => Grooves.pointerOf(box)
        .flatMap(pointer => pointer.targetVertex)
        .map(({box}) => Grooves.asGrooveBox(box).label.getValue())

    export const forClip =(adapter: AnyClipBoxAdapter): string => adapter.accept({
        visitNoteClipBoxAdapter: ({label}: NoteClipBoxAdapter): string => label,
        visitAudioClipBoxAdapter: ({label, gain}: AudioClipBoxAdapter): string =>
            withGain(orPlaceholder(label), gain.getValue()),
        visitValueClipBoxAdapter: ({label}: ValueClipBoxAdapter): string => label
    }) ?? adapter.label
}