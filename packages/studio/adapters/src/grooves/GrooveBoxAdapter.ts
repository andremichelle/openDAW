import {AssertType, int, Observer, Option, Subscription} from "@opendaw/lib-std"
import {Box, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Groove, ppqn} from "@opendaw/lib-dsp"
import {GrooveFunctionBox, GrooveRandomBox, GrooveShuffleBox, GrooveStackBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"

export type GrooveBox = GrooveShuffleBox | GrooveFunctionBox | GrooveRandomBox | GrooveStackBox

export type GrooveKind = "shuffle" | "power" | "s-curve" | "random" | "stack"

export const isGrooveBox = (box: Box): box is GrooveBox => box.tags.type === "groove"

export interface GrooveAdapter extends IndexedBoxAdapter, Groove {
    readonly type: "groove-adapter"
    readonly box: GrooveBox
    readonly kind: GrooveKind
    readonly label: string
    readonly labelField: StringField
    readonly indexField: Int32Field
    readonly amount: Option<AutomatableParameterFieldAdapter<number>>
    readonly duration: Option<AutomatableParameterFieldAdapter<int>>
    // The cell length the display shows, 0 for a stack
    cellDuration(): ppqn
    // Fires on every change that alters warp or unwarp
    subscribeChange(observer: Observer<GrooveAdapter>): Subscription
    // Every pointer that uses this groove (devices, stack entries, the global groove of the project)
    users(): ReadonlyArray<PointerField<Pointers.Groove>>
}

export namespace GrooveAdapter {
    export const checkType: AssertType<GrooveAdapter> = (adapter: unknown): adapter is GrooveAdapter =>
        adapter !== null && typeof adapter === "object" && "type" in adapter && adapter.type === "groove-adapter"
}
