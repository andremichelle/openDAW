import css from "./ShortcutManagerView.sass?inline"
import {Events, Html, Shortcut, ShortcutDefinition, ShortcutDefinitions} from "@opendaw/lib-dom"
import {DefaultObservableValue, isAbsent, Lifecycle, Notifier, Objects, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Dialogs} from "@/ui/components/dialogs"
import {Surface} from "@/ui/surface/Surface"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "ShortcutManagerView")

type Construct = {
    lifecycle: Lifecycle
    contexts: Record<string, ShortcutDefinitions>
    updateNotifier: Notifier<void>
}

const editShortcut = async (definitions: ShortcutDefinitions,
                            original: ShortcutDefinition): Promise<Shortcut> => {
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
                        Shortcut.fromEvent(event).ifSome(newShortcut => {
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

let lastOpenIndex = 0

export const ShortcutManagerView = ({lifecycle, contexts, updateNotifier}: Construct) => {
    return (
        <div className={className} onInit={element => {
            const update = () => replaceChildren(element, Objects.entries(contexts).map(([name, shortcuts], index) => (
                <details className="context"
                         open={lastOpenIndex === index}
                         onInit={element => element.ontoggle = () => {
                             if (element.open) {lastOpenIndex = index}
                         }}>
                    <summary><h3>{name}</h3></summary>
                    <div className="shortcuts">
                        {Objects.entries(shortcuts).map(([key, entry]) => (
                            <div className="shortcut" onclick={async () => {
                                const keys = await editShortcut(shortcuts, entry)
                                shortcuts[key].keys.overrideWith(keys)
                                update()
                            }}><span>{entry.description}</span>
                                <hr/>
                                <span>{entry.keys.format()}</span>
                            </div>
                        ))}
                    </div>
                </details>
            )))
            lifecycle.own(updateNotifier.subscribe(update))
            update()
        }}>
        </div>
    )
}