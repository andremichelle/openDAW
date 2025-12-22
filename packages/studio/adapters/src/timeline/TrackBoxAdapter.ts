import {
    asInstanceOf,
    DefaultObservableValue,
    int,
    isInstanceOf,
    Observer,
    Option,
    panic,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {ppqn, UpdateClockRate} from "@opendaw/lib-dsp"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {TrackClips} from "./TrackClips"
import {TrackRegions} from "./TrackRegions"
import {AudioUnitBoxAdapter} from "../audio-unit/AudioUnitBoxAdapter"
import {TrackType} from "./TrackType"
import {AnyClipBoxAdapter, AnyRegionBoxAdapter} from "../UnionAdapterTypes"
import {ValueClipBoxAdapter} from "./clip/ValueClipBoxAdapter"
import {ValueRegionBoxAdapter} from "./region/ValueRegionBoxAdapter"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"

export class TrackBoxAdapter implements BoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: TrackBox

    readonly #terminator: Terminator

    readonly #clips: TrackClips
    readonly #regions: TrackRegions

    readonly #listIndex: DefaultObservableValue<int>

    constructor(context: BoxAdaptersContext, box: TrackBox) {
        this.#context = context
        this.#box = box

        this.#terminator = new Terminator()
        this.#clips = this.#terminator.own(new TrackClips(this, context.boxAdapters))
        this.#regions = this.#terminator.own(new TrackRegions(this, context.boxAdapters))
        this.#listIndex = this.#terminator.own(new DefaultObservableValue(-1))
    }

    catchupAndSubscribePath(observer: Observer<Option<[string, string]>>): Subscription {
        const path: [Option<string>, Option<string>] = [Option.None, Option.None]
        const updater = () => {
            if (path.every(option => option.nonEmpty())) {
                observer(Option.wrap(path.map(option => option.unwrap()) as [string, string]))
            } else {
                observer(Option.None)
            }
        }
        return Terminable.many(
            this.#catchupAndSubscribeTargetDeviceName(option => {
                if (path[0].equals(option)) {return}
                path[0] = option
                updater()
            }),
            this.#catchupAndSubscribeTargetControlName(option => {
                if (path[1].equals(option)) {return}
                path[1] = option
                updater()
            })
        )
    }

    get context(): BoxAdaptersContext {return this.#context}

    set targetDeviceName(value: string) {
        this.#box.target.targetVertex.ifSome(targetVertex => {
            const vertex = targetVertex.box
            if (vertex instanceof AudioUnitBox) {
                const adapter = this.#context.boxAdapters.adapterFor(vertex, AudioUnitBoxAdapter)
                return adapter.input.getValue().ifSome(({labelField}) => labelField.setValue(value))
            } else if ("label" in vertex && vertex.label instanceof StringField) {
                return vertex.label.setValue(value)
            }
        })
    }

    get targetDeviceName(): Option<string> {
        return this.#box.target.targetVertex.flatMap(targetVertex => {
            const vertex = targetVertex.box
            if (vertex instanceof AudioUnitBox) {
                const adapter = this.#context.boxAdapters.adapterFor(vertex, AudioUnitBoxAdapter)
                return adapter.input.label
            } else if ("label" in vertex && vertex.label instanceof StringField) {
                return Option.wrap(vertex.label.getValue())
            } else {
                return Option.wrap(vertex.name)
            }
        })
    }

    #catchupAndSubscribeTargetDeviceName(observer: Observer<Option<string>>): Subscription {
        const targetVertex = this.#box.target.targetVertex
        if (targetVertex.nonEmpty()) {
            const vertex = targetVertex.unwrap().box
            if (vertex instanceof AudioUnitBox) {
                const adapter = this.#context.boxAdapters.adapterFor(vertex, AudioUnitBoxAdapter)
                return adapter.input.catchupAndSubscribeLabelChange(option => observer(option))
            } else if ("label" in vertex && vertex.label instanceof StringField) {
                return vertex.label.catchupAndSubscribe(owner => observer(Option.wrap(owner.getValue())))
            } else {
                // This will probably not happen. It is just a fallback.
                observer(Option.wrap(vertex.name))
                return Terminable.Empty
            }
        }
        observer(Option.None)
        return Terminable.Empty
    }

    #catchupAndSubscribeTargetControlName(observer: Observer<Option<string>>): Subscription {
        const type = this.type
        switch (type) {
            case TrackType.Audio:
            case TrackType.Notes: {
                observer(Option.wrap(TrackType[type]))
                return Terminable.Empty
            }
            case TrackType.Value: {
                const target = this.#box.target.targetVertex.unwrap()
                if (target.isField()) {
                    observer(this.#context.parameterFieldAdapters.opt(target.address).map(vertex => vertex.name))
                } else if (target.isBox()) {
                    // I cannot think of a scenario where target is a box, but at least the UI shows the box's name
                    observer(Option.wrap(target.name))
                } else {
                    return panic("Illegal State. Vertex is not a field nor box.")
                }
                return Terminable.Empty
            }
            case TrackType.Undefined: {
                observer(Option.wrap(""))
                return Terminable.Empty
            }
            default: {
                observer(Option.None)
                return Terminable.Empty
            }
        }
    }

    terminate() {this.#terminator.terminate()}

    get audioUnit(): AudioUnitBox {return asInstanceOf(this.#box.tracks.targetVertex.unwrap().box, AudioUnitBox)}
    get target(): PointerField<Pointers.Automation> {return this.#box.target}
    get clips(): TrackClips {return this.#clips}
    get regions(): TrackRegions {return this.#regions}
    get enabled(): BooleanField {return this.#box.enabled}
    get indexField(): Int32Field {return this.#box.index}
    get type(): TrackType {return this.#box.type.getValue()}
    get box(): TrackBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}

    get listIndex(): int {return this.#listIndex.getValue()}
    set listIndex(value: int) {this.#listIndex.setValue(value)}

    accepts(subject: AnyClipBoxAdapter | AnyRegionBoxAdapter): boolean {
        switch (subject.type) {
            case "audio-clip":
                return this.type === TrackType.Audio
            case "note-clip":
                return this.type === TrackType.Notes
            case "value-clip":
                return this.type === TrackType.Value
            case "audio-region":
                return this.type === TrackType.Audio
            case "note-region":
                return this.type === TrackType.Notes
            case "value-region":
                return this.type === TrackType.Value
        }
    }

    valueAt(position: ppqn, fallback: unitValue): unitValue {
        if (!this.enabled.getValue()) {return fallback}
        let value = fallback
        const intervals = this.#context.clipSequencing.iterate(this.uuid, position, position + UpdateClockRate)
        for (const {optClip, sectionFrom} of intervals) {
            value = optClip.match({
                none: () => {
                    const region = this.regions.collection.lowerEqual(position, region => !region.mute)
                    if (region === null) {
                        const firstRegion = this.regions.collection.optAt(0)
                        return isInstanceOf(firstRegion, ValueRegionBoxAdapter) ? firstRegion.incomingValue(fallback) : fallback
                    } else if (isInstanceOf(region, ValueRegionBoxAdapter)) {
                        if (position < region.complete) {
                            return region.valueAt(position, fallback)
                        } else {
                            return region.outgoingValue(fallback)
                        }
                    }
                    return fallback
                },
                some: clip => {
                    if (sectionFrom === position) {
                        if (isInstanceOf(clip, ValueClipBoxAdapter)) {
                            return clip.valueAt(position, fallback)
                        }
                    }
                    return fallback
                }
            })
        }
        return value
    }
}