import {Errors, isInstanceOf, Notifier, Observer, Option, RuntimeNotifier, Subscription, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {
    AudioUnitBoxAdapter,
    CompressorDeviceBoxAdapter,
    ExportStemsConfiguration,
    GateDeviceBoxAdapter,
    RootBoxAdapter
} from "@opendaw/studio-adapters"
import {OfflineEngineRenderer} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Address} from "@opendaw/lib-box"

const frozenAudioUnits: Map<string, AudioData> = new Map()
const notifier = new Notifier<UUID.Bytes>()

export namespace AudioUnitFreeze {
    export const isFrozen = (audioUnitBoxAdapter: AudioUnitBoxAdapter): boolean =>
        frozenAudioUnits.has(UUID.toString(audioUnitBoxAdapter.uuid))

    export const subscribe = (observer: Observer<UUID.Bytes>): Subscription => notifier.subscribe(observer)

    export const hasSidechainDependents = (rootBoxAdapter: RootBoxAdapter,
                                           audioUnitBoxAdapter: AudioUnitBoxAdapter): boolean => {
        const targetAddresses: Array<Address> = []
        for (const output of audioUnitBoxAdapter.labeledAudioOutputs()) {
            targetAddresses.push(output.address)
        }
        for (const otherUnit of rootBoxAdapter.audioUnits.adapters()) {
            if (UUID.equals(otherUnit.uuid, audioUnitBoxAdapter.uuid)) {continue}
            for (const effect of otherUnit.audioEffects.adapters()) {
                if (isInstanceOf(effect, CompressorDeviceBoxAdapter) || isInstanceOf(effect, GateDeviceBoxAdapter)) {
                    const sideChainTarget = effect.sideChain.targetAddress
                    if (sideChainTarget.nonEmpty()) {
                        const address = sideChainTarget.unwrap()
                        if (targetAddresses.some(targetAddr => targetAddr.equals(address))) {
                            return true
                        }
                    }
                }
            }
        }
        return false
    }

    export const freeze = async (service: StudioService,
                                 audioUnitBoxAdapter: AudioUnitBoxAdapter): Promise<void> => {
        const {project, engine} = service
        if (hasSidechainDependents(project.rootBoxAdapter, audioUnitBoxAdapter)) {
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
        const copiedProject = project.copy()
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
                service.sampleRate
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
        frozenAudioUnits.set(audioUnitUuid, audioData)
        notifier.notify(audioUnitBoxAdapter.uuid)
    }

    export const unfreeze = (service: StudioService,
                             audioUnitBoxAdapter: AudioUnitBoxAdapter): void => {
        const audioUnitUuid = UUID.toString(audioUnitBoxAdapter.uuid)
        service.engine.setFrozenAudio(audioUnitBoxAdapter.uuid, null)
        frozenAudioUnits.delete(audioUnitUuid)
        notifier.notify(audioUnitBoxAdapter.uuid)
    }
}
