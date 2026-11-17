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
import {TopLevelReturn} from "./code-editor/TopLevelReturn"
import {Errors, isDefined, isNull, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ScriptPreamble} from "@opendaw/studio-scripting"
import {MenuButton} from "@/ui/components/MenuButton"
import {FilePickerAcceptTypes, MenuItem, ScriptMeta, ScriptStorage} from "@opendaw/studio-core"
import {dynamicImportWithRetry} from "@/ui/components/dynamicImportWithRetry"
import {Dialogs} from "@/ui/components/dialogs"
import {ScriptDialogs} from "@/script/ScriptDialogs"
import {ScriptSession} from "./code-editor/ScriptSession"
import {ScriptTemplates} from "./code-editor/StockScripts"
import {StudioScriptHost} from "@/script/StudioScriptHost"

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
    const host = StudioScriptHost.create(service)
    const storage = ScriptStorage.get()
    return (
        <div className={className}>
            <Await
                factory={() => loadMonacoSetup().then(({monaco}) => monaco)}
                failure={(props) => EditorLoadFailure(props)}
                loading={() => ThreeDots()}
                success={monaco => {
                    const {editor, model, container} = MonacoFactory.create({
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
                                .filter(diagnostic => diagnostic.code !== TopLevelReturn)
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
                    const editMeta = (): Promise<void> => ScriptSession.current.match({
                        none: () => saveAs(),
                        some: async ({uuid, meta}) => {
                            const {status, value} = await Promises.tryCatch(
                                ScriptDialogs.showMetaDialog({headline: "Edit Script", meta, buttonText: "Apply"}))
                            if (status === "rejected") {return}
                            const next = Object.assign(ScriptMeta.copy(meta), value, {modified: new Date().toISOString()})
                            const saved = await Promises.tryCatch(storage.saveMeta(uuid, next))
                            if (saved.status === "rejected") {
                                console.warn(saved.error)
                                RuntimeNotifier.notify({message: "Could not update script.", icon: "Warning"})
                                return
                            }
                            ScriptSession.current.wrap({uuid, meta: next})
                        }
                    })
                    const title: HTMLElement = <span className="script-name" title="Double-click to rename" ondblclick={() => editMeta().finally()}/>
                    const scriptName = () => ScriptSession.current
                        .mapOr(({meta}) => meta.name, ScriptSession.suggestedName.getValue())
                    const isDirty = () => model.getValue() !== ScriptSession.savedSource.getValue()
                    const updateTitle = () => title.textContent = `${scriptName()}${isDirty() ? " *" : ""}`
                    const contentListener = model.onDidChangeContent(updateTitle)
                    const pasteListener = editor.onDidPaste(() => {
                        const source = model.getValue()
                        const stripped = ScriptPreamble.strip(source)
                        if (stripped === source || stripped.length === 0) {return}
                        editor.executeEdits("strip-preamble", [{range: model.getFullModelRange(), text: stripped}])
                    })
                    lifecycle.ownAll(
                        Terminable.create(() => contentListener.dispose()),
                        Terminable.create(() => pasteListener.dispose()),
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
                    const openCommunity = async (): Promise<void> => {
                        const {status, value} = await Promises.tryCatch(ScriptDialogs.showCommunityDialog({target: "project"}))
                        if (status === "rejected") {return}
                        await newScript(value.source, value.name)
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
                            .setTriggerProcedure(exportScript),
                        MenuItem.default({label: "Manual", icon: IconSymbol.Help, separatorBefore: true})
                            .setTriggerProcedure(() => window.open("/docs/scripting/", "_blank"))
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
                                        appearance={{tooltip: "Browse your scripts"}}>
                                    <span>My Scripts</span> <Icon symbol={IconSymbol.Code}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={() => openCommunity().finally()}
                                        appearance={{color: Colors.dark, cursor: "pointer", tooltip: "Browse scripts shared by the community"}}>
                                    <span>Community Scripts</span>
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
