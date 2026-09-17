import {isDefined, isNull, Lifecycle} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import type * as MonacoEditor from "monaco-editor"

type Monaco = typeof MonacoEditor

export namespace MonacoFactory {
    type Options = {
        monaco: Monaco
        language: string
        uri: string
        initialCode: string
        lifecycle: Lifecycle
        // An existing model for this uri keeps its content and undo history instead of being reset to initialCode
        keepExisting?: boolean
    }

    export const create = ({monaco, language, uri, initialCode, lifecycle, keepExisting = false}: Options) => {
        const container = document.createElement("div")
        container.className = "monaco-host"
        const modelUri = monaco.Uri.parse(uri)
        let model = monaco.editor.getModel(modelUri)
        if (isNull(model)) {
            model = monaco.editor.createModel(initialCode, language, modelUri)
        } else if (!keepExisting) {
            model.setValue(initialCode)
        }
        const editor = monaco.editor.create(container, {
            language,
            quickSuggestions: {other: true, comments: false, strings: false},
            occurrencesHighlight: "off",
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnCommitCharacter: true,
            acceptSuggestionOnEnter: "on",
            wordBasedSuggestions: "off",
            model,
            theme: "vs-dark",
            automaticLayout: true,
            stickyScroll: {enabled: false},
            editContext: false,
            dropIntoEditor: {enabled: false}
        })
        const allowed = ["c", "v", "x", "a", "z", "y"]
        lifecycle.ownAll(
            Events.subscribe(container, "keydown", event => {
                if ((event.ctrlKey || event.metaKey) && isDefined(event.key) && allowed.includes(event.key.toLowerCase())) {
                    return
                }
                event.stopPropagation()
            }),
            Events.subscribe(container, "keyup", event => {
                if ((event.ctrlKey || event.metaKey) && isDefined(event.key) && allowed.includes(event.key.toLowerCase())) {
                    return
                }
                event.stopPropagation()
            }),
            Events.subscribe(container, "keypress", event => event.stopPropagation()),
            Events.subscribe(container, "dragover", event => event.stopPropagation())
        )
        requestAnimationFrame(() => editor.focus())
        return {editor, model, container}
    }
}