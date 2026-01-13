import {EmptyExec, Func, Nullable, Point, Procedure, Selection, Terminable} from "@moises-ai/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Events} from "@moises-ai/lib-dom"

export type Construct<T> = {
    element: Element
    selection: Selection<T>
    getter: Func<T, string>
    setter: Procedure<string>
}

export const installValueInput = <T>({element, selection, getter, setter}: Construct<T>): Terminable => {
    let lastSelected: Nullable<T> = null
    return Terminable.many(
        selection.subscribe({
            onSelected: (adapter: T) => lastSelected = adapter,
            onDeselected: (adapter: T) => {if (lastSelected === adapter) {lastSelected = null}}
        }),
        Events.subscribe(element, "keydown", event => {
            if (lastSelected === null) {return}
            if (event.key === "Enter") {
                const resolvers = Promise.withResolvers<string>()
                const surface = Surface.get(element)
                surface.flyout.appendChild(FloatingTextInput({
                    numeric: true,
                    position: Point.add(surface.pointer, {x: 0, y: 16}),
                    value: getter(lastSelected),
                    resolvers
                }))
                resolvers.promise.then(text => setter(text), EmptyExec)
            }
        }),
        {terminate: () => lastSelected = null}
    )
}