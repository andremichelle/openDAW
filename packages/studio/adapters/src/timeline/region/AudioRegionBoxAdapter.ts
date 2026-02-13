import {
    Arrays,
    asEnumValue,
    int,
    isInstanceOf,
    Maybe,
    mod,
    MutableObservableOption,
    MutableObservableValue,
    Notifier,
    ObservableOption,
    Observer,
    Option,
    safeExecute,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {EventCollection, ppqn, TimeBase, TimeBaseConverter} from "@opendaw/lib-dsp"
import {Address, Field, PointerField, Propagation, Update} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioRegionBox} from "@opendaw/studio-boxes"
import {LoopableRegionBoxAdapter, RegionBoxAdapter, RegionBoxAdapterVisitor} from "../RegionBoxAdapter"
import {TrackBoxAdapter} from "../TrackBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {AudioFileBoxAdapter} from "../../audio/AudioFileBoxAdapter"
import {MutableRegion} from "./MutableRegion"
import {ValueEventCollectionBoxAdapter} from "../collection/ValueEventCollectionBoxAdapter"
import {AudioContentBoxAdapter} from "../AudioContentBoxAdapter"
import {AudioPlayMode} from "../../audio/AudioPlayMode"
import {AudioPitchStretchBoxAdapter} from "../../audio/AudioPitchStretchBoxAdapter"
import {AudioTimeStretchBoxAdapter} from "../../audio/AudioTimeStretchBoxAdapter"
import {WarpMarkerBoxAdapter} from "../../audio/WarpMarkerBoxAdapter"
import {FadingAdapter} from "./FadingAdapter"

type CopyToParams = {
    target?: Field<Pointers.RegionCollection>
    position?: ppqn
    duration?: ppqn
    loopOffset?: ppqn
    loopDuration?: ppqn
    consolidate?: boolean
}

export class AudioRegionBoxAdapter implements AudioContentBoxAdapter, LoopableRegionBoxAdapter<ValueEventCollectionBoxAdapter>, MutableRegion {
    readonly type = "audio-region"

    readonly #terminator: Terminator

    readonly #context: BoxAdaptersContext
    readonly #box: AudioRegionBox

    readonly #durationConverter: TimeBaseConverter
    readonly #loopDurationConverter: TimeBaseConverter
    readonly #playMode: MutableObservableOption<AudioPlayMode>
    readonly #changeNotifier: Notifier<void>
    readonly #fadingAdapter: FadingAdapter
    readonly #constructing: boolean

    #fileAdapter: Option<AudioFileBoxAdapter> = Option.None
    #fileSubscription: Terminable = Terminable.Empty
    #playModeSubscription: Terminable = Terminable.Empty
    #tempoSubscription: Terminable = Terminable.Empty
    #eventCollectionSubscription: Subscription = Terminable.Empty

    #isSelected: boolean

    constructor(context: BoxAdaptersContext, box: AudioRegionBox) {
        this.#context = context
        this.#box = box

        this.#terminator = new Terminator()
        const {timeBase, duration, loopDuration} = box
        this.#durationConverter = TimeBaseConverter.aware(context.tempoMap, timeBase, duration)
        this.#loopDurationConverter = TimeBaseConverter.aware(context.tempoMap, timeBase, loopDuration)
        this.#playMode = new MutableObservableOption()
        this.#changeNotifier = new Notifier<void>()
        this.#fadingAdapter = new FadingAdapter(box.fading)

        this.#isSelected = false
        this.#constructing = true

        this.#terminator.ownAll(
            this.#box.pointerHub.subscribe({
                onAdded: () => this.#dispatchChange(),
                onRemoved: () => this.#dispatchChange()
            }),
            this.#box.file.catchupAndSubscribe((pointerField: PointerField<Pointers.AudioFile>) => {
                this.#fileAdapter = pointerField.targetVertex.map(vertex =>
                    this.#context.boxAdapters.adapterFor(vertex.box, AudioFileBoxAdapter))
                this.#fileSubscription.terminate()
                this.#fileSubscription = this.#fileAdapter.mapOr(adapter =>
                    adapter.getOrCreateLoader().subscribe(() => this.#dispatchChange()), Terminable.Empty)
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
            this.#box.timeBase.catchupAndSubscribe(owner => {
                this.#tempoSubscription.terminate()
                if (asEnumValue(owner.getValue(), TimeBase) === TimeBase.Seconds) {
                    this.#tempoSubscription = context.tempoMap.subscribe(() => this.#dispatchChange())
                }
            }),
            this.#box.subscribe(Propagation.Children, (update: Update) => {
                if (this.trackBoxAdapter.isEmpty()) {return}
                if (update.type === "primitive" || update.type === "pointer") {
                    const track = this.trackBoxAdapter.unwrap()
                    if (this.#box.position.address.equals(update.address)) {
                        track.regions.onIndexingChanged()
                        this.#dispatchChange()
                    } else {
                        this.#dispatchChange()
                    }
                }
            }),
            this.#box.events.catchupAndSubscribe(({targetVertex}) => {
                this.#eventCollectionSubscription.terminate()
                this.#eventCollectionSubscription = targetVertex.match({
                    none: () => Terminable.Empty,
                    some: ({box}) => this.#context.boxAdapters
                        .adapterFor(box, ValueEventCollectionBoxAdapter)
                        .subscribeChange(() => this.#dispatchChange())
                })
                this.#dispatchChange()
            })
        )
        this.#constructing = false
    }

    subscribeChange(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}

    accept<R>(visitor: RegionBoxAdapterVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitAudioRegionBoxAdapter, this)
    }

    onSelected(): void {
        this.#isSelected = true
        this.#dispatchChange()
    }

    onDeselected(): void {
        this.#isSelected = false
        this.#dispatchChange()
    }

    get isSelected(): boolean {return this.#isSelected}

    get box(): AudioRegionBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): ppqn {return this.#box.position.getValue()}
    get duration(): ppqn {return this.#durationConverter.toPPQN(this.position)}
    get complete(): ppqn {return this.position + this.duration}
    get loopOffset(): ppqn {return this.#box.loopOffset.getValue()}
    get loopDuration(): ppqn {return this.#loopDurationConverter.toPPQN(this.position)}

    resolveDuration(position: ppqn): ppqn {return this.#durationConverter.toPPQN(position)}
    resolveComplete(position: ppqn): ppqn {return position + this.resolveDuration(position)}
    resolveLoopDuration(position: ppqn): ppqn {return this.#loopDurationConverter.toPPQN(position)}
    get offset(): ppqn {return this.position - this.loopOffset}
    get mute(): boolean {return this.#box.mute.getValue()}
    get hue(): int {return this.#box.hue.getValue()}
    get gain(): MutableObservableValue<number> {return this.#box.gain}
    get fading(): FadingAdapter {return this.#fadingAdapter}
    get file(): AudioFileBoxAdapter {return this.#fileAdapter.unwrap("Cannot access file.")}
    get observableOptPlayMode(): ObservableOption<AudioPlayMode> {return this.#playMode}
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
    get isMirrowed(): boolean {return this.optCollection.mapOr(adapter => adapter.numOwners > 1, false)}
    get canMirror(): boolean {return true}
    get canResize(): boolean {return true}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {
        return this.#box.regions.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TrackBoxAdapter))
    }
    get hasCollection() {return this.optCollection.nonEmpty()}
    get optCollection(): Option<ValueEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, ValueEventCollectionBoxAdapter))
    }
    set position(value: ppqn) {this.#box.position.setValue(value)}
    set duration(value: ppqn) {
        this.#durationConverter.fromPPQN(value, this.position)
        const totalFading = this.#fadingAdapter.in + this.#fadingAdapter.out
        if (totalFading > value) {
            const scale = value / totalFading
            this.#fadingAdapter.inField.setValue(this.#fadingAdapter.in * scale)
            this.#fadingAdapter.outField.setValue(this.#fadingAdapter.out * scale)
        }
    }
    set loopOffset(value: ppqn) {this.#box.loopOffset.setValue(mod(value, this.loopDuration))}
    set loopDuration(value: ppqn) {this.#loopDurationConverter.fromPPQN(value, this.position)}

    moveContentStart(delta: ppqn): void {
        const oldPosition = this.position
        const newPosition = oldPosition + delta
        this.position = newPosition
        this.loopDuration = this.loopDuration - delta
        this.duration = this.duration - delta

        if (this.timeBase === TimeBase.Seconds) {
            const deltaSeconds = delta >= 0
                ? this.#context.tempoMap.intervalToSeconds(oldPosition, newPosition)
                : -this.#context.tempoMap.intervalToSeconds(newPosition, oldPosition)
            this.#box.waveformOffset.setValue(this.waveformOffset.getValue() + deltaSeconds)
        } else {
            this.optWarpMarkers.ifSome(warpMarkers => warpMarkers.asArray()
                .forEach(marker => marker.box.position.setValue(marker.position - delta)))
        }
    }

    copyTo(params?: CopyToParams): AudioRegionBoxAdapter {
        const eventCollection = this.optCollection.unwrap("Cannot make copy without event-collection")
        const eventTarget = params?.consolidate === true
            ? eventCollection.copy().box.owners
            : eventCollection.box.owners
        const clonedPlayMode = this.observableOptPlayMode.map(mode => mode.clone())
        const adapter = this.#context.boxAdapters.adapterFor(
            AudioRegionBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.timeBase.setValue(this.#box.timeBase.getValue())
                box.position.setValue(params?.position ?? this.#box.position.getValue())
                box.regions.refer(params?.target ?? this.#box.regions.targetVertex.unwrap())
                box.file.refer(this.#box.file.targetVertex.unwrap())
                box.events.refer(eventTarget)
                box.mute.setValue(this.mute)
                box.hue.setValue(this.hue)
                box.label.setValue(this.label)
                box.gain.setValue(this.gain.getValue())
                box.waveformOffset.setValue(this.waveformOffset.getValue())
                clonedPlayMode.ifSome(mode => box.playMode.refer(mode))
                this.#fadingAdapter.copyTo(box.fading)
            }), AudioRegionBoxAdapter)
        adapter.loopDuration = params?.loopDuration ?? this.resolveLoopDuration(adapter.position)
        adapter.loopOffset = params?.loopOffset ?? this.loopOffset
        adapter.duration = params?.duration ?? this.resolveDuration(adapter.position)
        return adapter
    }

    consolidate(): void {}
    canFlatten(regions: ReadonlyArray<RegionBoxAdapter<unknown>>): boolean {
        return regions.length > 0
            && Arrays.satisfy(regions, (a, b) => a.trackBoxAdapter.contains(b.trackBoxAdapter.unwrap()))
            && regions.every(region => region.isSelected && region instanceof AudioRegionBoxAdapter)
    }
    flatten(_regions: ReadonlyArray<RegionBoxAdapter<unknown>>): Option<AudioRegionBox> {
        // TODO This needs to done by creating a new audio file
        return Option.None
    }

    terminate(): void {
        this.#fileSubscription.terminate()
        this.#fileSubscription = Terminable.Empty
        this.#tempoSubscription.terminate()
        this.#tempoSubscription = Terminable.Empty
        this.#playModeSubscription.terminate()
        this.#playModeSubscription = Terminable.Empty
        this.#eventCollectionSubscription.terminate()
        this.#eventCollectionSubscription = Terminable.Empty
        this.#terminator.terminate()
    }

    toString(): string {return `{AudioRegionBoxAdapter ${UUID.toString(this.#box.address.uuid)}}`}

    #dispatchChange(): void {
        if (this.#constructing) {return}
        this.#changeNotifier.notify()
        this.trackBoxAdapter.unwrapOrNull()?.regions?.dispatchChange()
    }
}