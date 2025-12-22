import {EventCollection, ppqn, PPQN, TimeBase, TimeBaseConverter} from "@opendaw/lib-dsp"
import {
    asEnumValue,
    DefaultObservableValue,
    int,
    isInstanceOf,
    Maybe,
    MutableObservableOption,
    MutableObservableValue,
    Notifier,
    ObservableOption,
    ObservableValue,
    Observer,
    Option,
    safeExecute,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioClipBox} from "@opendaw/studio-boxes"
import {Address, Int32Field, PointerField, Propagation, Update} from "@opendaw/lib-box"
import {ClipBoxAdapter, ClipBoxAdapterVisitor} from "../ClipBoxAdapter"
import {Pointers} from "@opendaw/studio-enums"
import {TrackBoxAdapter} from "../TrackBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AudioFileBoxAdapter} from "../../audio/AudioFileBoxAdapter"
import {AudioContentBoxAdapter} from "../AudioContentBoxAdapter"
import {AudioPlayMode} from "../../audio/AudioPlayMode"
import {AudioPitchStretchBoxAdapter} from "../../audio/AudioPitchStretchBoxAdapter"
import {AudioTimeStretchBoxAdapter} from "../../audio/AudioTimeStretchBoxAdapter"
import {WarpMarkerBoxAdapter} from "../../audio/WarpMarkerBoxAdapter"

export class AudioClipBoxAdapter implements AudioContentBoxAdapter, ClipBoxAdapter<never> {
    readonly type = "audio-clip"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioClipBox

    readonly #playMode: MutableObservableOption<AudioPlayMode>
    readonly #selectedValue: DefaultObservableValue<boolean>
    readonly #durationConverter: TimeBaseConverter
    readonly #changeNotifier: Notifier<void>

    readonly #isConstructing: boolean // Prevents stack overflow due to infinite adapter queries

    #fileAdapter: Option<AudioFileBoxAdapter> = Option.None
    #fileSubscription: Option<Subscription> = Option.None
    #playModeSubscription: Terminable = Terminable.Empty

    constructor(context: BoxAdaptersContext, box: AudioClipBox) {
        this.#context = context
        this.#box = box

        this.#isConstructing = true
        this.#playMode = new MutableObservableOption()
        this.#selectedValue = this.#terminator.own(new DefaultObservableValue(false))
        this.#durationConverter = TimeBaseConverter.aware(context.tempoMap, box.timeBase, box.duration)
        this.#changeNotifier = this.#terminator.own(new Notifier<void>())

        this.#terminator.ownAll(
            this.#box.pointerHub.subscribe({
                onAdded: () => this.#dispatchChange(),
                onRemoved: () => this.#dispatchChange()
            }),
            this.#box.playMode.catchupAndSubscribe(({targetVertex}) => {
                this.#playModeSubscription.terminate()
                targetVertex.match({
                    none: () => this.#playMode.clear(),
                    some: ({box}) => {
                        const playMode: AudioPlayMode = this.#context.boxAdapters.adapterFor(box, AudioPlayMode.isAudioPlayMode)
                        this.#playModeSubscription = playMode.subscribe(() => this.#dispatchChange())
                        this.#playMode.wrap(playMode)
                    }
                })
            }),
            this.#box.file.catchupAndSubscribe((pointerField: PointerField<Pointers.AudioFile>) => {
                this.#fileAdapter = pointerField.targetVertex
                    .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, AudioFileBoxAdapter))
                this.#fileSubscription.ifSome(subscription => subscription.terminate())
                this.#fileSubscription = this.#fileAdapter.map(adapter =>
                    adapter.getOrCreateLoader().subscribe(() => this.#dispatchChange()))
            }),
            this.#box.subscribe(Propagation.Children, (_update: Update) => this.#dispatchChange())
        )
        this.#isConstructing = false
    }

    catchupAndSubscribeSelected(observer: Observer<ObservableValue<boolean>>): Subscription {
        return this.#selectedValue.catchupAndSubscribe(observer)
    }

    subscribeChange(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}
    accept<R>(visitor: ClipBoxAdapterVisitor<R>): Maybe<R> {return safeExecute(visitor.visitAudioClipBoxAdapter, this)}

    consolidate(): void {}
    clone(_mirrored: boolean): void {
        const clonedPlayMode = this.observableOptPlayMode.map(mode => mode.clone())
        AudioClipBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.index.setValue(this.indexField.getValue())
            box.gain.setValue(this.gain.getValue())
            box.timeBase.setValue(this.timeBase)
            box.label.setValue(this.label)
            box.hue.setValue(this.hue)
            box.duration.setValue(this.duration)
            box.mute.setValue(this.mute)
            box.clips.refer(this.#box.clips.targetVertex.unwrap())
            box.file.refer(this.#box.file.targetVertex.unwrap())
            box.events.refer(this.#box.events.targetVertex.unwrap())
            clonedPlayMode.ifSome(mode => box.playMode.refer(mode))
        })
    }

    onSelected(): void {this.#selectedValue.setValue(true)}
    onDeselected(): void {this.#selectedValue.setValue(false)}

    get isSelected(): boolean {return this.#selectedValue.getValue()}

    get box(): AudioClipBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get duration(): ppqn {return this.#durationConverter.toPPQN(0)}
    set duration(value: ppqn) {this.#durationConverter.fromPPQN(value, 0)}
    get mute(): boolean {return this.#box.mute.getValue()}
    get hue(): int {return this.#box.hue.getValue()}
    get gain(): MutableObservableValue<number> {return this.#box.gain}
    get file(): AudioFileBoxAdapter {return this.#fileAdapter.unwrap("Cannot access file.")}
    get observableOptPlayMode(): ObservableOption<AudioPlayMode> {return this.#playMode}
    get hasCollection() {return !this.optCollection.isEmpty()}
    get optCollection(): Option<never> {return Option.None}
    get timeBase(): TimeBase {return asEnumValue(this.#box.timeBase.getValue(), TimeBase)}
    get waveformOffset(): MutableObservableValue<number> {return this.#box.waveformOffset}
    get isPlayModeNoStretch(): boolean {return this.#box.playMode.isEmpty()}
    get asPlayModePitchStretch(): Option<AudioPitchStretchBoxAdapter> {
        return this.observableOptPlayMode.map(mode => isInstanceOf(mode, AudioPitchStretchBoxAdapter) ? mode : null)
    }
    get asPlayModeTimeStretch(): Option<AudioTimeStretchBoxAdapter> {
        return this.observableOptPlayMode.map(mode => isInstanceOf(mode, AudioTimeStretchBoxAdapter) ? mode : null)
    }
    get optWarpMarkers(): Option<EventCollection<WarpMarkerBoxAdapter>> {
        return this.observableOptPlayMode.map(mode => AudioPlayMode.isAudioPlayMode(mode) ? mode.warpMarkers : null)
    }
    get label(): string {
        if (this.#fileAdapter.isEmpty()) {return "No Audio File"}
        const state = this.#fileAdapter.unwrap().getOrCreateLoader().state
        if (state.type === "progress") {return `${Math.round(state.progress * 100)}%`}
        if (state.type === "error") {return String(state.reason)}
        return this.#box.label.getValue()
    }
    get trackBoxAdapter(): Option<TrackBoxAdapter> {
        if (this.#isConstructing) {return Option.None}
        return this.#box.clips.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TrackBoxAdapter))
    }
    get isMirrowed(): boolean {return false}
    get canMirror(): boolean {return false}
    get canResize(): boolean {return this.#playMode.nonEmpty()}

    terminate(): void {
        this.#fileSubscription.ifSome(subscription => subscription.terminate())
        this.#fileSubscription = Option.None
        this.#playModeSubscription.terminate()
        this.#playModeSubscription = Terminable.Empty
        this.#terminator.terminate()
    }

    toString(): string {return `{AudioClipBoxAdapter ${UUID.toString(this.#box.address.uuid)} d: ${PPQN.toString(this.duration)}}`}

    #dispatchChange(): void {
        this.#changeNotifier.notify()
        this.trackBoxAdapter.unwrapOrNull()?.clips?.dispatchChange()
    }
}