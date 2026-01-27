import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {IterableIterators, Option, unitValue} from "@opendaw/lib-std"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {SelectableValueEvent} from "@opendaw/studio-adapters"

export interface ValueModifyStrategy {
    showOrigin(): boolean
    snapValue(): Option<number>
    readPosition(event: SelectableValueEvent): ppqn
    readValue(event: SelectableValueEvent): unitValue
    readInterpolation(event: SelectableValueEvent): Interpolation
    translateSearch(value: ppqn): ppqn
    isVisible(event: SelectableValueEvent): boolean
    iterator(searchMin: ppqn, searchMax: ppqn): IterableIterator<SelectableValueEvent>
    readContentDuration(owner: ValueEventOwnerReader): ppqn
}

export namespace ValueModifyStrategy {
    export const Identity: ValueModifyStrategy = Object.freeze({
        showOrigin: (): boolean => false,
        snapValue: (): Option<unitValue> => Option.None,
        readPosition: (event: SelectableValueEvent): ppqn => event.position,
        readValue: (event: SelectableValueEvent): number => event.value,
        readInterpolation: (event: SelectableValueEvent): Interpolation => event.interpolation,
        translateSearch: (value: ppqn): ppqn => value,
        isVisible: (_event: SelectableValueEvent): boolean => true,
        iterator: (_searchMin: ppqn, _searchMax: ppqn): IterableIterator<SelectableValueEvent> => IterableIterators.empty(),
        readContentDuration: (region: ValueEventOwnerReader): ppqn => region.contentDuration
    })
}