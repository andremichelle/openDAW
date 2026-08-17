import {Editing, EmptyExec, Option, RuntimeNotifier, tryCatch} from "@opendaw/lib-std"
import {Clipboard, Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AblPattern, CubedDeviceBoxAdapter, CubedPatternData} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {CubedPatternClipboard} from "./CubedPatternClipboard"

export namespace CubedPatternActions {
    type Context = {
        readonly editing: Editing
        readonly adapter: CubedDeviceBoxAdapter
        readonly origin?: Element
    }

    const notify = (message: string, icon: IconSymbol, origin?: Element): void =>
        RuntimeNotifier.notify({message, icon: IconSymbol.toName(icon), origin})

    const applyPattern = ({editing, adapter, origin}: Context,
                          data: Option<CubedPatternData>,
                          failure: string): void => {
        if (data.isEmpty()) {
            notify(failure, IconSymbol.Warning, origin)
            return
        }
        editing.modify(() => adapter.writeCurrentPattern(data.unwrap()))
        notify("Pattern pasted", IconSymbol.Paste, origin)
    }

    const loadAblPattern = async ({editing, adapter, origin}: Context): Promise<void> => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "AudioRealism ABL pattern", accept: {"text/plain": [".pat"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
        const parsed = tryCatch(() => AblPattern.parse(text))
        if (parsed.status === "failure" || parsed.value.steps.length === 0) {
            notify(`Not a readable ABL pattern: ${file.name}`, IconSymbol.Warning, origin)
            return
        }
        editing.modify(() => adapter.writeCurrentPattern(parsed.value))
        notify(`Loaded ${file.name}`, IconSymbol.Cube, origin)
    }

    export const clipboardItems = (context: Context): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Copy Pattern"})
            .setTriggerProcedure(() => CubedPatternClipboard.write(context.adapter.readCurrentPattern())
                .then(() => notify("Pattern copied", IconSymbol.Copy, context.origin), EmptyExec)),
        MenuItem.default({label: "Paste Pattern"})
            .setTriggerProcedure(() => CubedPatternClipboard.read()
                .then(data => applyPattern(context, data, "No pattern in clipboard"), EmptyExec)),
        MenuItem.default({label: "Copy Pattern to JSON", separatorBefore: true})
            .setTriggerProcedure(() =>
                Clipboard.writeText(CubedPatternData.toJSON(context.adapter.readCurrentPattern()))
                    .then(() => notify("Pattern copied as JSON", IconSymbol.Copy, context.origin), EmptyExec)),
        MenuItem.default({label: "Paste Pattern from JSON"})
            .setTriggerProcedure(() => Clipboard.readText()
                .then(text => applyPattern(context, CubedPatternData.fromJSON(text),
                    "No readable pattern JSON in clipboard"), EmptyExec))
    ]

    /** Loads into the CURRENT pattern, leaving the other 15 untouched. */
    export const loadAblItem = (context: Context): MenuItem =>
        MenuItem.default({label: "Load ABL .pat…", separatorBefore: true})
            .setTriggerProcedure(() => {loadAblPattern(context).catch(console.warn)})
}
