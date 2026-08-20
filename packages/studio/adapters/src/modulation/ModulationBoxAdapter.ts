import {Address} from "@opendaw/lib-box"
import {ModulationBox} from "@opendaw/studio-boxes"
import {Observer, Option, StringMapping, Subscription, Terminable, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {AudioUnitBoxAdapter} from "../audio-unit/AudioUnitBoxAdapter"
import {isModulatorBoxAdapter, ModulatorBoxAdapter} from "./ModulatorBoxAdapter"
import {ParameterOwner} from "../ParameterOwner"

export class ModulationBoxAdapter implements BoxAdapter {
    readonly #terminator: Terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #box: ModulationBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: ModulationBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = {
            depth: this.#parametric.createParameter(box.depth, ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 0}), "Depth", 0.5)
        } as const
        // The depth's automation lane lives on the modulator that drives it, so it shows up in that group.
        const registration = this.#terminator.own(new Terminator())
        this.#terminator.own(box.source.catchupAndSubscribe(() => {
            registration.terminate()
            box.source.targetVertex
                .flatMap(vertex => this.#context.boxAdapters.optAdapter(vertex.box))
                .ifSome(adapter => {
                    if (isModulatorBoxAdapter(adapter)) {
                        registration.own(this.namedParameter.depth.registerTracks(adapter.tracks))
                    }
                })
        }))
    }

    get box(): ModulationBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get enabled(): boolean {return this.#box.enabled.getValue()}
    get depth(): number {return this.#box.depth.getValue()}

    get source(): ModulatorBoxAdapter {
        return this.#context.boxAdapters.adapterFor(
            this.#box.source.targetVertex.unwrap("no modulator").box, isModulatorBoxAdapter)
    }

    /// `None` while the target field has no registered parameter adapter yet.
    get target(): Option<AutomatableParameterFieldAdapter> {
        return this.#box.target.targetVertex
            .flatMap(vertex => this.#context.parameterFieldAdapters.opt(vertex.address))
    }

    get targetAudioUnit(): Option<AudioUnitBoxAdapter> {
        return this.#box.target.targetVertex.flatMap(vertex => ParameterOwner.audioUnitOf(this.#context, vertex))
    }

    get targetOwner(): Option<string> {
        return this.#box.target.targetVertex.flatMap(vertex => ParameterOwner.nameOf(this.#context, vertex))
    }

    /// The owner's name, kept current: renaming the device the target belongs to notifies again.
    catchupAndSubscribeTargetOwner(observer: Observer<string>): Subscription {
        const vertex = this.#box.target.targetVertex
        if (vertex.isEmpty()) {
            observer("")
            return Terminable.Empty
        }
        return ParameterOwner.catchupAndSubscribeName(this.#context, vertex.unwrap(), observer)
    }

    terminate(): void {this.#terminator.terminate()}
}
