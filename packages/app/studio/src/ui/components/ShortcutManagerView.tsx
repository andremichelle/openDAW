import css from "./ShortcutManagerView.sass?inline"
import {Events, Html, ShortcutKeys} from "@opendaw/lib-dom"
import {DefaultObservableValue, isAbsent, Lifecycle, Objects, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {GlobalShortcuts} from "@/shortcuts/GlobalShortcuts"
import {ShortcutDefinition, ShortcutDefinitions} from "@/shortcuts/ShortcutValidator"
import {Dialogs} from "@/ui/components/dialogs"
import {Surface} from "@/ui/surface/Surface"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "ShortcutManagerView")

type Construct = {
    lifecycle: Lifecycle
}

const editShortcut = async (definitions: ShortcutDefinitions, original: ShortcutDefinition): Promise<ShortcutKeys> => {
    const lifecycle = new Terminator()
    const abortController = new AbortController()
    const shortcut = lifecycle.own(new DefaultObservableValue(original.keys))
    return Dialogs.show({
        headline: "Edit Shortcut",
        content: (
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.75em"}}>
                <h3 style={{color: Colors.orange.toString()}}>Shortcut for "{original.description}"</h3>
                <div style={{color: Colors.blue.toString(), height: "1.25em"}} onConnect={element => {
                    lifecycle.own(Events.subscribe(Surface.get(element).owner, "keydown", event => {
                        ShortcutKeys.fromEvent(event).ifSome(newShortcut => {
                            shortcut.setValue(newShortcut)
                            element.textContent = newShortcut.format()
                        })
                        event.preventDefault()
                        event.stopImmediatePropagation()
                    }, {capture: true}))
                }}>{original.keys.format()}</div>
                <div onInit={element => shortcut.catchupAndSubscribe(owner => {
                    const keys = owner.getValue()
                    const conflicts = Objects.entries(definitions)
                        .find(([_, other]) => !other.keys.equals(original.keys) && other.keys.equals(keys))
                    if (isAbsent(conflicts)) {
                        element.textContent = "No conflict."
                        element.style.color = Colors.dark.toString()
                    } else {
                        element.textContent = `Conflicts with "${conflicts[1].description} ${conflicts[1].keys.format()}".`
                        element.style.color = Colors.red.toString()
                    }
                })}/>
            </div>
        ),
        abortSignal: abortController.signal,
        buttons: [{
            text: "Cancel",
            primary: false,
            onClick: () => abortController.abort()
        }]
    }).then(() => shortcut.getValue(), () => original.keys).finally(() => lifecycle.terminate())
}

export const ShortcutManagerView = ({}: Construct) => {
    return (
        <div className={className}>
            <div className="shortcuts" onInit={element => {
                const update = () => replaceChildren(element, (
                    Objects.entries(GlobalShortcuts).map(([key, entry]) => (
                        <div className="shortcut" onclick={async () => {
                            const keys = await editShortcut(GlobalShortcuts, entry)
                            GlobalShortcuts[key].keys.overrideWith(keys)
                            update()
                        }}><span>{entry.description}</span>
                            <hr/>
                            <span>{entry.keys.format()}</span>
                        </div>
                    ))
                ))
                update()
            }}/>
        </div>
    )
}