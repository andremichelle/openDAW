import {asDefined, int, Maybe, ObservableValue, Observer, Option, Selectable, Subscription} from "@moises-ai/lib-std"
import {AudioClipBox, BoxVisitor, NoteClipBox, ValueClipBox} from "@moises-ai/studio-boxes"
import {Box} from "@moises-ai/lib-box"
import {ValueClipBoxAdapter} from "./clip/ValueClipBoxAdapter"
import {ppqn} from "@moises-ai/lib-dsp"
import {AudioClipBoxAdapter} from "./clip/AudioClipBoxAdapter"
import {AnyClipBox} from "../unions"
import {NoteClipBoxAdapter} from "./clip/NoteClipBoxAdapter"
import {BoxAdapter} from "../BoxAdapter"
import {TrackBoxAdapter} from "./TrackBoxAdapter"
import {AnyClipBoxAdapter} from "../UnionAdapterTypes"
import {BoxAdapters} from "../BoxAdapters"

export interface ClipBoxAdapterVisitor<R> {
    visitAudioClipBoxAdapter?(adapter: AudioClipBoxAdapter): R
    visitNoteClipBoxAdapter?(adapter: NoteClipBoxAdapter): R
    visitValueClipBoxAdapter?(adapter: ValueClipBoxAdapter): R
}

export interface ClipBoxAdapter<CONTENT> extends BoxAdapter, Selectable {
    get box(): AnyClipBox
    get isSelected(): boolean
    get hasCollection(): boolean
    get duration(): ppqn
    get hue(): int
    get mute(): boolean
    get label(): string
    get isMirrowed(): boolean
    get canMirror(): boolean
    get optCollection(): Option<CONTENT>
    get trackBoxAdapter(): Option<TrackBoxAdapter>

    consolidate(): void
    clone(consolidate: boolean): void
    catchupAndSubscribeSelected(observer: Observer<ObservableValue<boolean>>): Subscription
    subscribeChange(observer: Observer<void>): Subscription
    accept<VISITOR extends ClipBoxAdapterVisitor<any>>(visitor: VISITOR)
        : VISITOR extends ClipBoxAdapterVisitor<infer R> ? Maybe<R> : void
}

export const ClipAdapters = {
    for: (boxAdapters: BoxAdapters, box: Box): AnyClipBoxAdapter => asDefined(box.accept<BoxVisitor<AnyClipBoxAdapter>>({
        visitNoteClipBox: (box: NoteClipBox) => boxAdapters.adapterFor(box, NoteClipBoxAdapter),
        visitValueClipBox: (box: ValueClipBox) => boxAdapters.adapterFor(box, ValueClipBoxAdapter),
        visitAudioClipBox: (box: AudioClipBox) => boxAdapters.adapterFor(box, AudioClipBoxAdapter)
    }), "")
}