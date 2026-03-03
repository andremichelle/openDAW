import {Errors, Notifier, Observer, Option, RuntimeNotifier, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBoxAdapter, ExportStemsConfiguration} from "@opendaw/studio-adapters"
import {OfflineEngineRenderer} from "./OfflineEngineRenderer"
import {Address} from "@opendaw/lib-box"

import type {Project} from "./project"

type FrozenEntry = { audioData: AudioData, deletionSubscription: Terminable }

export class AudioUnitFreeze implements Terminable {
    readonly #project: Project
    readonly #terminator = new Terminator()
    readonly #frozenAudioUnits: Map<string, FrozenEntry> = new Map()
    readonly #notifier = new Notifier<UUID.Bytes>()

    constructor(project: Project) {
        this.#project = project

        const {timelineBoxAdapter} = project
        this.#terminator.ownAll(
            timelineBoxAdapter.box.bpm.subscribe(() => this.#unfreezeAll()),
            timelineBoxAdapter.catchupAndSubscribeTempoAutomation(() => this.#unfreezeAll())
        )
    }

    isFrozen(audioUnitBoxAdapter: AudioUnitBoxAdapter): boolean {
        return this.#frozenAudioUnits.has(UUID.toString(audioUnitBoxAdapter.uuid))
    }

    isFrozenUuid(uuid: UUID.Bytes): boolean {
        return this.#frozenAudioUnits.has(UUID.toString(uuid))
    }

    subscribe(observer: Observer<UUID.Bytes>): Subscription {return this.#notifier.subscribe(observer)}

    hasSidechainDependents(audioUnitBoxAdapter: AudioUnitBoxAdapter): boolean {
        const targetAddresses: Array<Address> = []
        for (const output of audioUnitBoxAdapter.labeledAudioOutputs()) {
            targetAddresses.push(output.address)
        }
        if (targetAddresses.length === 0) {return false}
        const edges = audioUnitBoxAdapter.box.graph.edges()
        for (const otherUnit of this.#project.rootBoxAdapter.audioUnits.adapters()) {
            if (UUID.equals(otherUnit.uuid, audioUnitBoxAdapter.uuid)) {continue}
            for (const effect of otherUnit.audioEffects.adapters()) {
                for (const [_, target] of edges.outgoingEdgesOf(effect.box)) {
                    if (targetAddresses.some(addr => addr.equals(target))) {
                        return true
                    }
                }
            }
        }
        return false
    }

    async freeze(audioUnitBoxAdapter: AudioUnitBoxAdapter): Promise<void> {
        const {engine} = this.#project
        if (this.hasSidechainDependents(audioUnitBoxAdapter)) {
            await RuntimeNotifier.info({
                headline: "Cannot Freeze",
                message: "This audio unit is used as a sidechain source by another device."
            })
            return
        }
        const audioUnitUuid = UUID.toString(audioUnitBoxAdapter.uuid)
        const exportConfiguration: ExportStemsConfiguration = {
            [audioUnitUuid]: {
                includeAudioEffects: true,
                includeSends: false,
                useInstrumentOutput: false,
                skipChannelStrip: true,
                fileName: "freeze"
            }
        }
        const copiedProject = this.#project.copy()
        const abortController = new AbortController()
        const dialog = RuntimeNotifier.progress({
            headline: "Freezing AudioUnit...",
            cancel: () => abortController.abort()
        })
        const renderResult = await Promises.tryCatch(
            OfflineEngineRenderer.start(
                copiedProject,
                Option.wrap(exportConfiguration),
                progress => dialog.message = `${Math.round(progress)}s rendered`,
                abortController.signal,
                engine.sampleRate
            ))
        if (renderResult.status === "rejected") {
            dialog.terminate()
            if (!Errors.isAbort(renderResult.error)) {
                await RuntimeNotifier.info({headline: "Freeze Failed", message: String(renderResult.error)})
            }
            return
        }
        dialog.terminate()
        const audioData = renderResult.value
        engine.setFrozenAudio(audioUnitBoxAdapter.uuid, audioData)
        const {regionSelection, userEditingManager} = this.#project
        const frozenRegions = regionSelection.selected()
            .filter(region => region.trackBoxAdapter
                .mapOr(track => UUID.equals(track.audioUnit.address.uuid, audioUnitBoxAdapter.uuid), false))
        if (frozenRegions.length > 0) {regionSelection.deselect(...frozenRegions)}
        userEditingManager.timeline.get().ifSome(vertex => {
            const regionUuid = vertex.box.address.uuid
            for (const track of audioUnitBoxAdapter.tracks.values()) {
                if (track.regions.collection.asArray().some(region => UUID.equals(region.uuid, regionUuid))) {
                    userEditingManager.timeline.clear()
                    break
                }
            }
        })
        this.#project.captureDevices.get(audioUnitBoxAdapter.uuid)
            .ifSome(capture => capture.armed.setValue(false))
        const deletionSubscription = audioUnitBoxAdapter.box.subscribeDeletion(() =>
            this.#removeFrozen(audioUnitBoxAdapter.uuid, audioUnitUuid))
        this.#frozenAudioUnits.set(audioUnitUuid, {audioData, deletionSubscription})
        this.#notifier.notify(audioUnitBoxAdapter.uuid)
    }

    unfreeze(audioUnitBoxAdapter: AudioUnitBoxAdapter): void {
        this.#removeFrozen(audioUnitBoxAdapter.uuid, UUID.toString(audioUnitBoxAdapter.uuid))
    }

    terminate(): void {
        this.#terminator.terminate()
        for (const [key, entry] of this.#frozenAudioUnits) {
            entry.deletionSubscription.terminate()
            this.#project.engine.setFrozenAudio(UUID.parse(key), null)
        }
        this.#frozenAudioUnits.clear()
    }

    #unfreezeAll(): void {
        const keys = Array.from(this.#frozenAudioUnits.keys())
        for (const key of keys) {
            this.#removeFrozen(UUID.parse(key), key)
        }
    }

    #removeFrozen(uuid: UUID.Bytes, key: string): void {
        const entry = this.#frozenAudioUnits.get(key)
        if (entry === undefined) {return}
        entry.deletionSubscription.terminate()
        this.#project.engine.setFrozenAudio(uuid, null)
        this.#frozenAudioUnits.delete(key)
        this.#notifier.notify(uuid)
    }
}