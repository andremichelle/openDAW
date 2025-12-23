import css from "./ShortcutManagerView.sass?inline"
import {Events, Html, ShortcutKeys} from "@opendaw/lib-dom"
import {DefaultObservableValue, isAbsent, Lifecycle, Objects, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioShortcuts} from "@/service/StudioShortcuts"
import {Dialogs} from "@/ui/components/dialogs"
import {Surface} from "@/ui/surface/Surface"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "ShortcutManagerView")

type Construct = {
    lifecycle: Lifecycle
}

const editShortcut = async (definitions: StudioShortcuts.Definitions, original: ShortcutKeys): Promise<ShortcutKeys> => {
    const lifecycle = new Terminator()
    const abortController = new AbortController()
    const newShortcut = lifecycle.own(new DefaultObservableValue(original))
    return Dialogs.show({
        headline: "Edit Shortcut",
        content: (
            <div style={{display: "flex", flexDirection: "column"}}>
                <div style={{color: Colors.blue.toString()}} onConnect={element => {
                    lifecycle.own(Events.subscribe(Surface.get(element).owner, "keydown", event => {
                        newShortcut.setValue(ShortcutKeys.fromEvent(event))
                        element.textContent = newShortcut.getValue().format()
                        event.preventDefault()
                        event.stopImmediatePropagation()
                    }, {capture: true}))
                }}>{original.format()}</div>
                <div onInit={element => newShortcut.catchupAndSubscribe(owner => {
                    const keys = owner.getValue()
                    const conflicts = Objects.entries(definitions)
                        .find(([_, other]) => !other.keys.equals(original) && other.keys.equals(keys))
                    element.textContent = isAbsent(conflicts)
                        ? "No conflict"
                        : `Conflict with ${conflicts[1].description} ${conflicts[1].keys.format()}`
                })}/>
            </div>
        ),
        abortSignal: abortController.signal,
        buttons: [{
            text: "Cancel",
            primary: false,
            onClick: () => abortController.abort()
        }]
    }).then(() => newShortcut.getValue(), () => original).finally(() => lifecycle.terminate())
}

export const ShortcutManagerView = ({}: Construct) => {
    return (
        <div className={className}>
            <div className="shortcuts">
                {Objects.entries(StudioShortcuts.Actions).map(([_key, entry]) => (
                    <div className="shortcut" onclick={async () => {
                        console.debug(await editShortcut(StudioShortcuts.Actions, entry.keys))
                    }}><span>{entry.description}</span>
                        <hr/>
                        <span>{entry.keys.format()}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}