import {isDefined, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {Box, Vertex} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBox, BoxVisitor, InstrumentCompositeCellBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {
    AudioEffectCompositeCellBoxAdapter, BoxAdapters, DeviceHost, InstrumentCompositeCellBoxAdapter,
    PlayfieldSampleBoxAdapter, UserEditing
} from "@opendaw/studio-adapters"

export class NestedHostExit implements Terminable {
    static targetsOf(host: DeviceHost): ReadonlyArray<Vertex<Pointers>> {
        return host.deviceHost().asCompositeCell().match<ReadonlyArray<Vertex<Pointers>>>({
            none: () => [host.audioUnitBoxAdapter().box.editing],
            some: parent => [parent.box, ...NestedHostExit.targetsOf(parent)]
        })
    }

    readonly #terminator: Terminator
    readonly #watching: Terminator

    constructor(boxAdapters: BoxAdapters, userEditing: UserEditing) {
        this.#terminator = new Terminator()
        this.#watching = this.#terminator.own(new Terminator())
        this.#terminator.own(userEditing.catchupAndSubscribe(option => {
            this.#watching.terminate()
            option.flatMap(vertex => this.#nestedHost(boxAdapters, vertex.box)).ifSome(host => {
                const targets = NestedHostExit.targetsOf(host)
                // a remote delete or an undo takes the box away mid-transaction, the pointer is rewritten after it
                this.#watching.own(host.box.subscribeDeletion(() => queueMicrotask(() => {
                    if (userEditing.get().nonEmpty()) {return}
                    const survivor = targets.find(target => target.box.isAttached())
                    if (isDefined(survivor)) {userEditing.edit(survivor)}
                })))
            })
        }))
    }

    terminate(): void {this.#terminator.terminate()}

    #nestedHost(boxAdapters: BoxAdapters, box: Box): Option<DeviceHost> {
        return Option.wrap(box.accept<BoxVisitor<DeviceHost>>({
            visitInstrumentCompositeCellBox: (box: InstrumentCompositeCellBox) =>
                boxAdapters.adapterFor(box, InstrumentCompositeCellBoxAdapter),
            visitAudioEffectCompositeCellBox: (box: AudioEffectCompositeCellBox) =>
                boxAdapters.adapterFor(box, AudioEffectCompositeCellBoxAdapter),
            visitPlayfieldSampleBox: (box: PlayfieldSampleBox) =>
                boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter)
        }))
    }
}
