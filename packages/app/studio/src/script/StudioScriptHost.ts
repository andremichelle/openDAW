import {Files} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Arrays, DefaultObservableValue, Option, Optional, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {MixdownOptions, ScriptHost} from "@opendaw/studio-scripting"
import {AudioContexts, OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {ProjectSkeleton, Sample} from "@opendaw/studio-adapters"
import {applyUpdateTasks, BoxGraph, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import scriptWorkerUrl from "@opendaw/studio-scripting/ScriptWorker.js?worker&url"
import {StudioService} from "@/service/StudioService"
import {ScriptFormDialog} from "@/script/ScriptFormDialog"

export namespace StudioScriptHost {
    const isMimeType = (value: string): value is `${string}/${string}` => /^[^/]+\/[^/]+$/.test(value)
    const isExtension = (value: string): value is `.${string}` => value.length > 1 && value.startsWith(".")
    const acceptTypes = (fileName: string, mimeType: string): Optional<Array<FilePickerAcceptType>> => {
        const extension = fileName.substring(fileName.lastIndexOf("."))
        if (!isMimeType(mimeType) || !isExtension(extension)) {return undefined}
        return [{description: mimeType, accept: {[mimeType]: [extension]}}]
    }

    export const create = (service: StudioService): ScriptHost => {
        const pendingSamples = UUID.newSet<UUID.Bytes>(uuid => uuid)
        return new ScriptHost({
            openProject: async (buffer: ArrayBufferLike, name?: string): Promise<void> => {
                if (!await service.projectProfileService.approveLosingChanges()) {return}
                const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
                boxGraph.fromArrayBuffer(buffer, false)
                const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
                const project = Project.fromSkeleton(service, {boxGraph, mandatoryBoxes})
                pendingSamples.forEach(uuid => project.trackUserCreatedSample(uuid))
                pendingSamples.clear()
                service.projectProfileService.setProject(project, name ?? "Scripted Project")
            },
            applyUpdates: (updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void =>
                service.optProject.match({
                    none: () => RuntimeNotifier.notify({message: "No project to apply the script to.", icon: "Warning"}),
                    some: project => {
                        if (!Arrays.equals(project.boxGraph.checksum(), checksum)) {
                            RuntimeNotifier.notify({message: "The project changed while the script ran. Run it again.", icon: "Warning"})
                            return
                        }
                        project.editing.modify(() => applyUpdateTasks(project.boxGraph, updates))
                        RouteLocation.get().navigateTo("/create")
                    }
                }),
            hasProject: async (): Promise<boolean> => service.projectProfileService.getValue().nonEmpty(),
            showInfo: (headline: string, message: string): Promise<void> => RuntimeNotifier.info({headline, message}),
            showDialog: request => ScriptFormDialog.show(request),
            fetchProject: async (): Promise<{ buffer: ArrayBuffer; name: string }> => {
                return service.projectProfileService.getValue().match({
                    none: () => panic("No project available"),
                    some: ({project, meta}) => ({
                        buffer: ProjectSkeleton.encode(project.boxGraph) as ArrayBuffer,
                        name: meta.name
                    })
                })
            },
            addSample: async (data: AudioData, name: string): Promise<Sample> => {
                const sample = await service.sampleService.importFile({
                    name, arrayBuffer: WavFile.encodeFloats(data)
                })
                const uuid = UUID.parse(sample.uuid)
                service.optProject.match({
                    none: () => {pendingSamples.add(uuid)},
                    some: project => {project.trackUserCreatedSample(uuid)}
                })
                return sample
            },
            listSamples: async (): Promise<ReadonlyArray<Sample>> => service.sampleService.list(),
            renderMixdown: async (buffer: ArrayBufferLike, {sampleRate}: MixdownOptions): Promise<AudioData> => {
                const project = Project.load(service, buffer as ArrayBuffer)
                const abortController = new AbortController()
                const progress = new DefaultObservableValue(0.0)
                const dialog = RuntimeNotifier.progress({
                    headline: "Rendering mixdown...",
                    progress,
                    cancel: () => abortController.abort()
                })
                await service.audioContext.suspend()
                const result = await Promises.tryCatch(OfflineEngineRenderer
                    .start(project, Option.None, progress, abortController.signal, sampleRate))
                dialog.terminate()
                project.terminate()
                AudioContexts.resume(service.audioContext).then()
                if (result.status === "rejected") {return Promise.reject(result.error)}
                return result.value
            },
            saveFile: async (buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<void> =>
                Files.saveWithApproval({
                    buffer, headline: "Save File", suggestedName: fileName, types: acceptTypes(fileName, mimeType)
                })
        }, scriptWorkerUrl)
    }
}
