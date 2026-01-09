import css from "./ShortcutManagerView.sass?inline"
import {Events, Html, Shortcut, ShortcutDefinition, ShortcutDefinitions} from "@opendaw/lib-dom"
import {
    DefaultObservableValue,
    isAbsent,
    isDefined,
    Lifecycle,
    Notifier,
    Objects,
    Strings,
    Terminator
} from "@opendaw/lib-std"
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

let lastOpenIndex = 0

export const ShortcutManagerView = ({lifecycle, contexts, updateNotifier}: Construct) => {
    return (
        <div className={className} onInit={element => {
            const update = () => replaceChildren(element, Objects.entries(contexts).map(([key, shortcuts], index) => (
                <details className="context"
                         open={lastOpenIndex === index}
                         onInit={element => element.ontoggle = () => {
                             if (element.open) {
                                 lastOpenIndex = index
                                 element.scrollIntoView()
                             }
                         }}>
                    <summary>
                        <h3>{Strings.hyphenToCamelCase(key)}</h3>
                    </summary>
                    <div className="shortcuts">
                        {Objects.entries(shortcuts).map(([key, entry]) => (
                            <div className="shortcut" onclick={async () => {
                                const keys = await editShortcut(shortcuts, entry)
                                shortcuts[key].shortcut.overrideWith(keys)
                                update()
                            }}><span>{entry.description}</span>
                                <hr/>
                                <div className="shortcut-keys">{
                                    entry.shortcut.format().map(symbol => <span>{symbol}</span>)
                                }</div>
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

const editShortcut = async (definitions: ShortcutDefinitions,
                            original: ShortcutDefinition): Promise<Shortcut> => {
    const lifecycle = new Terminator()
    const abortController = new AbortController()
    const shortcut = lifecycle.own(new DefaultObservableValue(original.shortcut))
    return Dialogs.show({
        headline: "Edit Shortcut",
        content: (
            <div style={{display: "flex", flexDirection: "column", rowGap: "0.75em"}}>
                <h3 style={{color: Colors.orange.toString()}}>Shortcut for "{original.description}"</h3>
                <div style={{color: Colors.blue.toString(), height: "1.25em", display: "flex", columnGap: "1px"}}
                     onConnect={element => {
                         lifecycle.own(Events.subscribe(Surface.get(element).owner, "keydown", event => {
                             Shortcut.fromEvent(event).ifSome(newShortcut => {
                                 shortcut.setValue(newShortcut)
                                 replaceChildren(element, newShortcut.format().map(symbol => <span>{symbol}</span>))
                             })
                             event.preventDefault()
                             event.stopImmediatePropagation()
                         }, {capture: true}))
                     }}>{original.shortcut.format().map(symbol => <span>{symbol}</span>)}</div>
                <div style={{display: "flex", columnGap: "1px"}}
                     onInit={element => shortcut.catchupAndSubscribe(owner => {
                         const shortcut = owner.getValue()
                         const conflicts = Object.values(definitions)
                             .find((other) => !other.shortcut.equals(original.shortcut) && other.shortcut.equals(shortcut))
                         if (isAbsent(conflicts)) {
                             element.textContent = "No conflict."
                             element.style.color = Colors.dark.toString()
                         } else {
                             element.textContent = `Conflicts with "${conflicts.description}".`
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
    }).then(() => {
        const newShortcut = shortcut.getValue()
        const conflicts = Objects.entries(definitions)
            .find(([_, other]) => !other.shortcut.equals(original.shortcut) && other.shortcut.equals(newShortcut))
        return isDefined(conflicts) ? original.shortcut : shortcut.getValue()
    }, () => original.shortcut).finally(() => lifecycle.terminate())
}