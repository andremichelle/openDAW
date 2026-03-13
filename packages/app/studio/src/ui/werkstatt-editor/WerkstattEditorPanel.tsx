import css from "./WerkstattEditorPanel.sass?inline"
import defaultCode from "../devices/audio-effects/werkstatt-default.txt?raw"
import {Lifecycle, Nullable, Terminable} from "@opendaw/lib-std"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard, Shortcut} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {Workspace} from "@/ui/workspace/Workspace"

const className = Html.adoptStyleSheet(css, "WerkstattEditorPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const WerkstattEditorPanel = ({lifecycle, service}: Construct) => {
    const statusLabel: HTMLDivElement = (<div className="status idle">Idle</div>)
    const nameLabel: HTMLSpanElement = (<span className="name">Code Editor</span>)
    const state = service.optWerkstattEditorState
    let handler: Nullable<CodeEditorHandler> = state.map(entry => entry.handler).unwrapOrNull()
    let previousScreen: Nullable<Workspace.ScreenKeys> = state.map(entry => entry.previousScreen).unwrapOrNull()
    const initialCode = state.map(entry => entry.initialCode).unwrapOrElse(defaultCode)
    let errorSubscription: Terminable = Terminable.Empty
    const setStatus = (text: string, type: "idle" | "success" | "error") => {
        statusLabel.textContent = text
        statusLabel.className = `status ${type}`
    }
    const applyState = (newHandler: CodeEditorHandler, newPreviousScreen: Nullable<Workspace.ScreenKeys>) => {
        errorSubscription.terminate()
        handler = newHandler
        previousScreen = newPreviousScreen
        nameLabel.textContent = newHandler.name
        errorSubscription = newHandler.subscribeErrors(message => setStatus(message, "error"))
        setStatus("Idle", "idle")
    }
    if (handler !== null) {
        nameLabel.textContent = handler.name
        errorSubscription = handler.subscribeErrors(message => setStatus(message, "error"))
    }
    lifecycle.own({terminate: () => errorSubscription.terminate()})
    return (
        <div className={className}>
            <Await
                factory={() => Promise.all([
                    Promises.guardedRetry(() => import("./monaco-setup"), (_error, count) => count < 10)
                        .then(({monaco}) => monaco)
                ])}
                failure={({retry, reason}) => (<p onclick={retry}>{reason}</p>)}
                loading={() => ThreeDots()}
                success={([monaco]) => {
                    const container = (<div className="monaco-editor"/>)
                    const modelUri = monaco.Uri.parse("file:///werkstatt.js")
                    let model = monaco.editor.getModel(modelUri)
                    if (!model) {
                        model = monaco.editor.createModel(initialCode, "javascript", modelUri)
                    } else {
                        model.setValue(initialCode)
                    }
                    const editor = monaco.editor.create(container, {
                        language: "javascript",
                        quickSuggestions: {
                            other: true,
                            comments: false,
                            strings: false
                        },
                        occurrencesHighlight: "off",
                        suggestOnTriggerCharacters: true,
                        acceptSuggestionOnCommitCharacter: true,
                        acceptSuggestionOnEnter: "on",
                        wordBasedSuggestions: "off",
                        model: model,
                        theme: "vs-dark",
                        automaticLayout: true
                    })
                    const runCode = async () => {
                        if (handler === null) {
                            setStatus("No handler connected", "error")
                            return
                        }
                        try {
                            await handler.compile(editor.getValue())
                            setStatus("Successfully compiled", "success")
                        } catch (reason: unknown) {
                            setStatus(String(reason), "error")
                        }
                    }
                    const allowed = ["c", "v", "x", "a", "z", "y"]
                    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => runCode().finally())
                    lifecycle.ownAll(
                        service.subscribeSignal(signal => {
                            applyState(signal.state.handler, signal.state.previousScreen)
                            model.setValue(signal.state.initialCode)
                            requestAnimationFrame(() => editor.focus())
                        }, "werkstatt-editor-update"),
                        Events.subscribe(container, "keydown", event => {
                            if (Keyboard.isControlKey(event) && event.code === "KeyS") {
                                runCode()
                                    .then(() => service.projectProfileService.save().finally())
                                    .finally()
                                event.preventDefault()
                                event.stopPropagation()
                            }
                        }, {capture: true}),
                        Events.subscribe(container, "keydown", event => {
                            if ((event.ctrlKey || event.metaKey) && allowed.includes(event.key.toLowerCase())) {
                                return
                            }
                            event.stopPropagation()
                        }),
                        Events.subscribe(container, "keyup", event => {
                            if ((event.ctrlKey || event.metaKey) && allowed.includes(event.key.toLowerCase())) {
                                return
                            }
                            event.stopPropagation()
                        }),
                        Events.subscribe(container, "keypress", event => event.stopPropagation())
                    )
                    requestAnimationFrame(() => editor.focus())
                    const close = () => service.switchScreen(previousScreen ?? "default")
                    return (
                        <div className="content">
                            <header>
                                {nameLabel}
                                <Button lifecycle={lifecycle}
                                        onClick={runCode}
                                        appearance={{tooltip: `Compile and run (${Shortcut.of("Enter", {alt: true}).format()})`}}>
                                    <span>Run</span> <Icon symbol={IconSymbol.Play}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={close}
                                        appearance={{tooltip: "Close editor"}}>
                                    <span>Close</span> <Icon symbol={IconSymbol.Exit}/>
                                </Button>
                            </header>
                            {container}
                            {statusLabel}
                        </div>
                    )
                }}/>
        </div>
    )
}
