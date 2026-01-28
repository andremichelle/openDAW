import {Arrays, asDefined, EmptyExec, SortedSet, Subscription, Terminable, Terminator, UUID} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioUnitBox, AuxSendBox, BoxVisitor} from "@moises-ai/studio-boxes"
import {AudioUnitBoxAdapter, IndexedBoxAdapterCollection} from "@moises-ai/studio-adapters"
import {DeferExec, deferNextFrame} from "@moises-ai/lib-dom"
import {Box} from "@moises-ai/lib-box"

export interface ChannelStripView {
    silent(value: boolean): void
}

interface ChannelStripState {
    adapter: AudioUnitBoxAdapter
    views: Array<ChannelStripView>
    subscription: Subscription
}

export class Mixer implements Terminable {
    readonly #terminator: Terminator = new Terminator()
    readonly #states: SortedSet<UUID.Bytes, ChannelStripState>
    readonly #solo: Set<AudioUnitBoxAdapter>
    readonly #virtualSolo: Set<AudioUnitBoxAdapter>
    readonly #deferUpdate: DeferExec

    constructor(audioUnits: IndexedBoxAdapterCollection<AudioUnitBoxAdapter, Pointers.AudioUnits>) {
        this.#states = UUID.newSet(({adapter: {uuid}}) => uuid)
        this.#solo = new Set()
        this.#virtualSolo = new Set()
        this.#deferUpdate = this.#terminator.own(deferNextFrame(() => this.#updateStates()))
        this.#terminator.own(audioUnits.catchupAndSubscribe({
            onAdd: (adapter: AudioUnitBoxAdapter) => {
                const {mute, solo} = adapter.namedParameter
                const views: Array<ChannelStripView> = []
                this.#states.add({
                    adapter,
                    views,
                    subscription: Terminable.many(
                        mute.catchupAndSubscribe(owner => {
                            if (owner.getControlledValue()) {
                                views.forEach(view => view.silent(true))
                            } else {
                                this.#deferUpdate.request()
                            }
                        }),
                        solo.catchupAndSubscribe(owner => {
                            if (owner.getControlledValue()) {
                                this.#solo.add(adapter)
                            } else {
                                this.#solo.delete(adapter)
                            }
                            this.#deferUpdate.request()
                        }))
                })
            },
            onRemove: (adapter: AudioUnitBoxAdapter) => {
                this.#solo.delete(adapter)
                this.#states.removeByKey(adapter.uuid).subscription.terminate()
                this.#deferUpdate.request()
            },
            onReorder: EmptyExec
        }))
    }

    registerChannelStrip({uuid}: AudioUnitBoxAdapter, view: ChannelStripView): Terminable {
        this.#states.get(uuid).views.push(view)
        this.#deferUpdate.request()
        return Terminable.create(() => {
            this.#states.opt(uuid).ifSome(({views}) => Arrays.remove(views, view))
            this.#deferUpdate.request()
        })
    }

    terminate(): void {this.#terminator.terminate()}

    #updateStates(): void {
        this.#virtualSolo.clear()
        this.#processChannelStrips()
        this.#updateChannelStripViews()
    }

    #processChannelStrips(): void {
        const touched = new Set<AudioUnitBoxAdapter>()
        const processUpstreamChannels = (adapter: AudioUnitBoxAdapter) => {
            if (touched.has(adapter)) {return}
            touched.add(adapter)
            adapter.input.adapter().ifSome(input => {
                if (input.type === "bus") {
                    input.box.input.pointerHub
                        .filter(Pointers.AudioOutput)
                        .map(pointer => this.#resolveAdapter(pointer.box))
                        .forEach((adapter) => {
                            const {namedParameter: {solo}} = adapter
                            if (!solo.getControlledValue()) {this.#virtualSolo.add(adapter)}
                            processUpstreamChannels(adapter)
                        })
                }
            })
        }
        this.#states.forEach(({adapter}) => {
            const {namedParameter: {solo}} = adapter
            if (solo.getControlledValue()) {processUpstreamChannels(adapter)}
        })
    }

    #resolveAdapter(box: Box): AudioUnitBoxAdapter {
        return asDefined(box.accept<BoxVisitor<AudioUnitBoxAdapter>>({
            visitAudioUnitBox: ({address: {uuid}}: AudioUnitBox) =>
                this.#states.get(uuid).adapter,
            visitAuxSendBox: ({audioUnit: {targetVertex}}: AuxSendBox) =>
                this.#states.get(targetVertex.unwrap().address.uuid).adapter
        }), "Could not resolve entry")
    }

    #updateChannelStripViews(): void {
        this.#states.forEach(({adapter, views}) => {
            const {mute, solo} = adapter.namedParameter
            if (mute.getControlledValue()) {
                views.forEach(view => view.silent(true))
            } else {
                const isSolo = solo.getControlledValue() || this.#virtualSolo.has(adapter)
                const value = this.#solo.size > 0 && !isSolo && !adapter.isOutput
                views.forEach(view => view.silent(value))
            }
        })
    }
}