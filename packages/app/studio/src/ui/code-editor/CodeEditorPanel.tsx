import css from "./CodeEditorPanel.sass?inline"
import defaultCode from "../devices/audio-effects/werkstatt-default.js?raw"
import {isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Clipboard, Events, Html, Keyboard, Shortcut} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {Dialogs} from "@/ui/components/dialogs"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {CodeEditorExample} from "./CodeEditorState"

const className = Html.adoptStyleSheet(css, "CodeEditorPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const CodeEditorPanel = ({lifecycle, service}: Construct) => {
    const statusLabel: HTMLDivElement = (<div className="status idle">Idle</div>)
    const state = service.activeCodeEditor.unwrapOrNull()
    const handler: Nullable<CodeEditorHandler> = isDefined(state) ? state.handler : null
    const initialCode = isDefined(state) ? state.initialCode : defaultCode
    const examples: ReadonlyArray<CodeEditorExample> = isDefined(state) ? state.examples : []
    const starterPrompt = isDefined(state) ? state.starterPrompt : ""
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
                    const container: HTMLDivElement = (<div className="monaco-editor"/>)
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
                        automaticLayout: true,
                        stickyScroll: {enabled: false}
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
                        lifecycle.own(handler.subscribeCode(code => {
                            if (editor.getValue() !== code) {editor.setValue(code)}
                        }))
                    }
                    const allowed = ["c", "v", "x", "a", "z", "y"]
                    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => compileCode().finally())
                    editor.onDidBlurEditorText(() => {
                        const restore = () => {
                            container.removeEventListener("pointerdown", restore, true)
                            if (document.activeElement instanceof HTMLElement) {
                                document.activeElement.blur()
                            }
                            editor.focus()
                        }
                        container.addEventListener("pointerdown", restore, true)
                    })
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
                                <Button lifecycle={lifecycle}
                                        onClick={close}
                                        appearance={{
                                            tooltip: "Close editor",
                                            color: Colors.red,
                                            framed: true,
                                            cursor: "pointer"
                                        }}>
                                    <Icon symbol={IconSymbol.Close}/>
                                </Button>
                                {nameSpan}
                                <Button lifecycle={lifecycle}
                                        onClick={compileCode}
                                        appearance={{
                                            tooltip: `Run (${Shortcut.of("Enter", {alt: true}).format()})`,
                                            color: Colors.green,
                                            cursor: "pointer"
                                        }}>
                                    <span>Run</span> <Icon symbol={IconSymbol.Play}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={async () => {
                                            const approved = await Dialogs.approve({
                                                headline: "Run Clipboard",
                                                message: "This will replace all code in the editor with the clipboard content and run it.",
                                                approveText: "Replace & Run",
                                                reverse: true
                                            })
                                            if (!approved) {return}
                                            const text = await Clipboard.readText()
                                            editor.executeEdits("clipboard", [{
                                                range: model.getFullModelRange(),
                                                text
                                            }])
                                            await compileCode()
                                        }}
                                        appearance={{tooltip: "Paste from clipboard and run", cursor: "pointer"}}>
                                    <span>Run Clipboard</span> <Icon symbol={IconSymbol.Paste}/>
                                </Button>
                                {starterPrompt.length > 0 && (
                                    <Button lifecycle={lifecycle}
                                            onClick={() => Clipboard.writeText(starterPrompt)
                                                .then(() => Dialogs.info({
                                                    headline: "AI Prompt Copied",
                                                    message: "The starter prompt has been copied to your clipboard.\n\nPaste it into an AI assistant (e.g. ChatGPT, Claude) to get help writing code for this device.\n\nThen copy the generated code and use 'From Clipboard' to load it."
                                                }))
                                                .catch(reason => setStatus(String(reason), "error"))}
                                            appearance={{
                                                tooltip: "Copy AI starter prompt to clipboard",
                                                cursor: "pointer"
                                            }}>
                                        <span>Get Prompt</span> <Icon symbol={IconSymbol.Copy}/>
                                    </Button>
                                )}
                                {examples.length > 0 && (
                                    <MenuButton root={MenuItem.root()
                                        .setRuntimeChildrenProcedure(parent => parent
                                            .addMenuItem(...examples
                                                .map(example => MenuItem.default({label: example.name})
                                                    .setTriggerProcedure(() => {
                                                        editor.setValue(example.code)
                                                        compileCode().finally()
                                                    }))))}
                                                appearance={{tinyTriangle: true, color: Colors.dark}}>
                                        <span>Examples</span>
                                    </MenuButton>
                                )}
                            </header>
                            {container}
                            {statusLabel}
                        </div>
                    )
                }}/>
        </div>
    )
}
