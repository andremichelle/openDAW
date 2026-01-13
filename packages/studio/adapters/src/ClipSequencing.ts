import {Option, Terminable, UUID} from "@moises-ai/lib-std"
import {ppqn} from "@moises-ai/lib-dsp"
import {AnyClipBoxAdapter} from "./UnionAdapterTypes"

export type Section = {
    optClip: Option<AnyClipBoxAdapter>
    sectionFrom: ppqn
    sectionTo: ppqn
}

export interface ClipSequencing extends Terminable {
    iterate(trackKey: UUID.Bytes, a: ppqn, b: ppqn): IterableIterator<Section>
}