import css from "./CodeEditorPage.sass?inline"
import {Events, Files, Html, Key, Keyboard, Shortcut} from "@opendaw/lib-dom"
import {MonacoFactory} from "@/monaco/factory"
import {Await, createElement, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {EditorLoadFailure} from "@/ui/components/EditorLoadFailure"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Arrays, Errors, isDefined, isNull, Option, panic, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ScriptHost} from "@opendaw/studio-scripting"
import {MenuButton} from "@/ui/components/MenuButton"
import {FilePickerAcceptTypes, MenuItem, Project, ScriptMeta, ScriptStorage} from "@opendaw/studio-core"
import {WavFile} from "@opendaw/lib-dsp"
import scriptWorkerUrl from "@opendaw/studio-scripting/ScriptWorker.js?worker&url"
import {dynamicImportWithRetry} from "@/ui/components/dynamicImportWithRetry"
import {ProjectSkeleton, Sample} from "@opendaw/studio-adapters"
import {applyUpdateTasks, BoxGraph, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {AudioData} from "@opendaw/lib-dsp"
import {Dialogs} from "@/ui/components/dialogs"
import {ScriptDialogs} from "@/script/ScriptDialogs"
import {ScriptSession} from "./code-editor/ScriptSession"
import {ScriptTemplates, StockScripts} from "./code-editor/StockScripts"

const ctrl = true
const shift = true
const Shortcuts = {
    open: Shortcut.of(Key.KeyO, {ctrl}),
    save: Shortcut.of(Key.KeyS, {ctrl}),
    saveAs: Shortcut.of(Key.KeyS, {ctrl, shift})
}

const className = Html.adoptStyleSheet(css, "CodeEditorPage")

const loadMonacoSetup = dynamicImportWithRetry(() => import("./code-editor/monaco-setup"))

export const CodeEditorPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const pendingSamples = UUID.newSet<UUID.Bytes>(uuid => uuid)
    const host = new ScriptHost({
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
        listSamples: async (): Promise<ReadonlyArray<Sample>> => service.sampleService.list()
    }, scriptWorkerUrl)
    const storage = ScriptStorage.get()
    const stockReady = storage.syncStock(StockScripts)
    return (
        <div className={className}>
            <Await
                factory={() => Promise.all([loadMonacoSetup().then(({monaco}) => monaco), stockReady])}
                failure={(props) => EditorLoadFailure(props)}
                loading={() => ThreeDots()}
                success={([monaco]) => {
                    const {model, container} = MonacoFactory.create({
                        monaco, lifecycle, language: "typescript",
                        uri: "file:///main.ts", initialCode: ScriptSession.savedSource.getValue(), keepExisting: true
                    })
                    const compileAndRun = async () => {
                        try {
                            const worker = await monaco.languages.typescript.getTypeScriptWorker()
                            const client = await worker(model.uri)
                            const semanticDiagnostics = await client.getSemanticDiagnostics(model.uri.toString())
                            const syntacticDiagnostics = await client.getSyntacticDiagnostics(model.uri.toString())
                            const allDiagnostics = [...semanticDiagnostics, ...syntacticDiagnostics]
                            if (allDiagnostics.length > 0) {
                                const errors = allDiagnostics.map(d => d.messageText).join("\n")
                                console.warn(errors)
                                RuntimeNotifier.notify({message: "Compilation error.", icon: "Warning"})
                                return
                            }
                            const emitOutput = await client.getEmitOutput(model.uri.toString())
                            if (emitOutput.outputFiles.length > 0) {
                                const jsCode = emitOutput.outputFiles[0].text
                                    .replace(/^["']use strict["'];?/, "")
                                await host.executeScript(jsCode, {
                                    sampleRate: service.audioContext.sampleRate,
                                    baseFrequency: service.optProject
                                        .map(project => project.rootBox.baseFrequency.getValue())
                                        .unwrapOrElse(440.0)
                                })
                            } else {
                                RuntimeNotifier.notify({message: "No output files generated.", icon: "Warning"})
                            }
                        } catch (error) {
                            console.warn(error)
                            RuntimeNotifier.notify({message: "Compilation error.", icon: "Warning"})
                        }
                    }
                    const title: HTMLElement = <span className="script-name"/>
                    const scriptName = () => ScriptSession.current
                        .mapOr(({meta}) => meta.name, ScriptSession.suggestedName.getValue())
                    const isDirty = () => model.getValue() !== ScriptSession.savedSource.getValue()
                    const updateTitle = () => title.textContent = `${scriptName()}${isDirty() ? " *" : ""}`
                    const contentListener = model.onDidChangeContent(updateTitle)
                    lifecycle.ownAll(
                        Terminable.create(() => contentListener.dispose()),
                        ScriptSession.current.subscribe(updateTitle),
                        ScriptSession.savedSource.subscribe(updateTitle),
                        ScriptSession.suggestedName.subscribe(updateTitle)
                    )
                    updateTitle()
                    const approveLosingChanges = async (): Promise<boolean> => !isDirty() || Dialogs.approve({
                        headline: "Unsaved Script",
                        message: "Discard the changes to the current script?",
                        approveText: "Discard",
                        cancelText: "Cancel"
                    })
                    const replaceContent = (source: string, suggestedName: string) => {
                        model.setValue(source)
                        ScriptSession.current.clear()
                        ScriptSession.suggestedName.setValue(suggestedName)
                        ScriptSession.savedSource.setValue(source)
                    }
                    const newScript = async (source: string, suggestedName: string) => {
                        if (!await approveLosingChanges()) {return}
                        replaceContent(source, suggestedName)
                    }
                    const store = async (uuid: UUID.Bytes, meta: ScriptMeta): Promise<boolean> => {
                        const source = model.getValue()
                        const {status, error} = await Promises.tryCatch(storage.save(uuid, meta, source))
                        if (status === "rejected") {
                            console.warn(error)
                            RuntimeNotifier.notify({message: "Could not save script.", icon: "Warning"})
                            return false
                        }
                        ScriptSession.current.wrap({uuid, meta})
                        ScriptSession.savedSource.setValue(source)
                        RuntimeNotifier.notify({message: `Script '${meta.name}' saved.`, icon: "Checkbox"})
                        return true
                    }
                    const saveAs = async (): Promise<void> => {
                        const suggested = ScriptSession.current
                            .mapOr(({meta}) => ({name: meta.name, description: meta.description}),
                                {name: ScriptSession.suggestedName.getValue(), description: ""})
                        const {status, value} = await Promises.tryCatch(
                            ScriptDialogs.showMetaDialog({headline: "Save Script As", meta: suggested}))
                        if (status === "rejected") {return}
                        await store(UUID.generate(), ScriptMeta.init(value.name, value.description))
                    }
                    const save = (): Promise<void> => ScriptSession.current.match({
                        none: () => saveAs(),
                        some: async ({uuid, meta}) => {
                            await store(uuid, Object.assign(meta, {modified: new Date().toISOString()}))
                        }
                    })
                    const open = async (): Promise<void> => {
                        if (!await approveLosingChanges()) {return}
                        const {status, value} = await Promises.tryCatch(ScriptDialogs.showBrowseDialog({
                            onMetaChanged: ([uuid, meta]) => {
                                if (ScriptSession.current.mapOr(current => UUID.equals(current.uuid, uuid), false)) {
                                    ScriptSession.current.wrap({uuid, meta})
                                }
                            },
                            onDeleted: uuid => {
                                if (ScriptSession.current.mapOr(current => UUID.equals(current.uuid, uuid), false)) {
                                    ScriptSession.current.clear(({meta}) => ScriptSession.suggestedName.setValue(meta.name))
                                }
                            }
                        }))
                        if (status === "rejected") {return}
                        const [uuid, meta] = value
                        const loaded = await Promises.tryCatch(storage.loadSource(uuid))
                        if (loaded.status === "rejected") {
                            console.warn(loaded.error)
                            RuntimeNotifier.notify({message: "Could not open script.", icon: "Warning"})
                            return
                        }
                        model.setValue(loaded.value)
                        ScriptSession.savedSource.setValue(loaded.value)
                        ScriptSession.current.wrap({uuid, meta})
                        RuntimeNotifier.notify({message: `Script '${meta.name}' opened.`, icon: "Checkbox"})
                    }
                    const importScript = async (): Promise<void> => {
                        const {status, value: files, error} = await Promises.tryCatch(
                            Files.open({types: [FilePickerAcceptTypes.ScriptFileType]}))
                        if (status === "rejected") {
                            if (!Errors.isAbort(error)) {console.warn(error)}
                            return
                        }
                        const file = files.at(0)
                        if (!isDefined(file)) {return}
                        const source = await file.text()
                        if (!await approveLosingChanges()) {return}
                        replaceContent(source, file.name.replace(/\.ts$/, ""))
                    }
                    const exportScript = async (): Promise<void> => {
                        const buffer = new TextEncoder().encode(model.getValue()).buffer as ArrayBuffer
                        const {status, error} = await Promises.tryCatch(Files.save(buffer, {
                            suggestedName: `${scriptName()}.ts`,
                            types: [FilePickerAcceptTypes.ScriptFileType]
                        }))
                        if (status === "rejected" && !Errors.isAbort(error)) {console.warn(error)}
                    }
                    const fileMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        MenuItem.default({label: "New Create Script"})
                            .setTriggerProcedure(() => newScript(ScriptTemplates.Create, "Create Script")),
                        MenuItem.default({label: "New Edit Script"})
                            .setTriggerProcedure(() => newScript(ScriptTemplates.Edit, "Edit Script")),
                        MenuItem.default({label: "Open...", shortcut: Shortcuts.open.format(), separatorBefore: true})
                            .setTriggerProcedure(open),
                        MenuItem.default({label: "Save", shortcut: Shortcuts.save.format()})
                            .setTriggerProcedure(save),
                        MenuItem.default({label: "Save As...", shortcut: Shortcuts.saveAs.format()})
                            .setTriggerProcedure(saveAs),
                        MenuItem.default({label: "Import Script...", separatorBefore: true})
                            .setTriggerProcedure(importScript),
                        MenuItem.default({label: "Export Script..."})
                            .setTriggerProcedure(exportScript)
                    ))
                    const onKeyDown = (event: KeyboardEvent) => {
                        if (!Keyboard.isControlKey(event)) {return}
                        const action = event.code === "KeyO" && !event.shiftKey ? open
                            : event.code === "KeyS" ? (event.shiftKey ? saveAs : save) : null
                        if (isNull(action)) {return}
                        event.preventDefault()
                        event.stopPropagation()
                        action().finally()
                    }
                    return (
                        <div className="content"
                             onInit={element => lifecycle.own(Events.subscribe(element, "keydown", onKeyDown, {capture: true}))}>
                            <header>
                                <Button lifecycle={lifecycle}
                                        onClick={() => RouteLocation.get().navigateTo(service.hasProfile ? "/create" : "/")}
                                        appearance={{tooltip: "Exit editor"}}>
                                    <span>Exit</span> <Icon symbol={IconSymbol.Exit}/>
                                </Button>
                                <MenuButton root={fileMenu} appearance={{tinyTriangle: true, color: Colors.dark}}>
                                    <span>File</span>
                                </MenuButton>
                                <Button lifecycle={lifecycle}
                                        onClick={compileAndRun}
                                        appearance={{tooltip: "Run script"}}>
                                    <span>Run</span> <Icon symbol={IconSymbol.Play}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={() => open().finally()}
                                        appearance={{tooltip: "Browse scripts"}}>
                                    <span>Scripts</span> <Icon symbol={IconSymbol.Code}/>
                                </Button>
                                {title}
                            </header>
                            {container}
                        </div>
                    )
                }}/>
        </div>
    )
}
