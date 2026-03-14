import css from "./WerkstattEditorPanel.sass?inline"
import defaultCode from "../devices/audio-effects/werkstatt-default.txt?raw"
import {isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard, Shortcut} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {CodeEditorHandler} from "./CodeEditorHandler"

const className = Html.adoptStyleSheet(css, "WerkstattEditorPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const WerkstattEditorPanel = ({lifecycle, service}: Construct) => {
    const statusLabel: HTMLDivElement = (<div className="status idle">Idle</div>)
    const state = service.activeCodeEditor.unwrapOrNull()
    const handler: Nullable<CodeEditorHandler> = isDefined(state) ? state.handler : null
    const initialCode = isDefined(state) ? state.initialCode : defaultCode
    const setStatus = (text: string, type: "idle" | "success" | "error") => {
        statusLabel.textContent = text
        statusLabel.className = `status ${type}`
    }
    const nameSpan: HTMLSpanElement = (<span className="name">Code Editor</span>)
    if (isDefined(handler)) {
        lifecycle.own(handler.name.catchupAndSubscribe(owner => nameSpan.textContent = owner.getValue()))
    }
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
                    const compileCode = async () => {
                        if (!isDefined(handler)) {
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
                    if (isDefined(handler)) {
                        lifecycle.own(handler.subscribeErrors(message => setStatus(message, "error")))
                    }
                    const allowed = ["c", "v", "x", "a", "z", "y"]
                    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => compileCode().finally())
                    lifecycle.ownAll(
                        Events.subscribe(container, "keydown", event => {
                            if (Keyboard.isControlKey(event) && event.code === "KeyS") {
                                compileCode()
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
                    const close = () => service.closeCodeEditor()
                    return (
                        <div className="content">
                            <header>
                                {nameSpan}
                                <Button lifecycle={lifecycle}
                                        onClick={compileCode}
                                        appearance={{tooltip: `Compile (${Shortcut.of("Enter", {alt: true}).format()})`}}>
                                    <span>Compile</span> <Icon symbol={IconSymbol.Play}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={close}
                                        appearance={{tooltip: "Close editor"}}>
                                    <span>Close Editor</span> <Icon symbol={IconSymbol.Exit}/>
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
