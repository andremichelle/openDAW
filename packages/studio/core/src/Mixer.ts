import {Arrays, asDefined, EmptyExec, panic, SortedSet, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {AudioUnitBox, AuxSendBox, BoxVisitor} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, IndexedBoxAdapterCollection} from "@opendaw/studio-adapters"
import {DeferExec, deferNextFrame} from "@opendaw/lib-dom"
import {Box} from "@opendaw/lib-box"

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
    readonly #audioUnits: IndexedBoxAdapterCollection<AudioUnitBoxAdapter, Pointers.AudioUnits>
    readonly #states: SortedSet<UUID.Bytes, ChannelStripState>
    readonly #solo: Set<AudioUnitBoxAdapter>
    readonly #virtualSolo: Set<AudioUnitBoxAdapter>
    readonly #deferUpdate: DeferExec

    constructor(audioUnits: IndexedBoxAdapterCollection<AudioUnitBoxAdapter, Pointers.AudioUnits>) {
        this.#audioUnits = audioUnits
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
                if (adapter.isOutput) {
                    console.warn(`[Mixer] OUTPUT unit ${UUID.toString(adapter.uuid)} removed from rootBox.audioUnits`,
                        new Error().stack)
                }
                this.#solo.delete(adapter)
                this.#states.removeByKey(adapter.uuid).subscription.terminate()
                this.#deferUpdate.request()
            },
            onReorder: EmptyExec
        }))
    }

    registerChannelStrip(adapter: AudioUnitBoxAdapter, view: ChannelStripView): Terminable {
        const {uuid} = adapter
        // Diagnostic for the recurring "Unknown key" panic (#924/925/926/984/985): a ChannelStrip was
        // requested for a unit that core Mixer never registered in #states. Capture which unit + state
        // (the bare SortedSet.get only reported "Unknown key: <bytes>"). Strips come from two sites:
        // the mixer panel (rootBox.audioUnits catchup) and DevicePanel (deviceHost.audioUnitBoxAdapter()).
        const optState = this.#states.opt(uuid)
        if (optState.isEmpty()) {
            const inCollection = this.#audioUnits.getAdapterById(uuid).nonEmpty()
            const collectionEdge = adapter.box.collection.targetVertex.mapOr(vertex => vertex.address.toString(), "EMPTY")
            return panic(`Mixer has no channel-strip state for audio-unit ${UUID.toString(uuid)} `
                + `(type=${adapter.type}, attached=${adapter.box.isAttached()}, states=${this.#states.size()}, `
                + `inCollection=${inCollection}, collectionEdge=${collectionEdge}); `
                + `requested for a unit absent from rootBox.audioUnits`)
        }
        const {views} = optState.unwrap("mixer-state")
        views.push(view)
        this.#deferUpdate.request()
        return Terminable.create(() => {
            Arrays.remove(views, view)
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
                this.#states.get(uuid, "channel-strip state").adapter,
            visitAuxSendBox: ({audioUnit: {targetVertex}}: AuxSendBox) =>
                this.#states.get(targetVertex.unwrap("auxSend.target").address.uuid, "channel-strip state").adapter
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