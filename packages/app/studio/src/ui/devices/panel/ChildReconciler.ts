import {isInstanceOf, Nullable} from "@opendaw/lib-std"
import {JsxValue} from "@opendaw/lib-jsx"

type MovableParent = Element & { moveBefore(node: Node, child: Nullable<Node>): void }

export namespace ChildReconciler {
    const canMoveBefore = (element: Element): element is MovableParent => typeof Reflect.get(element, "moveBefore") === "function"

    const flattenElements = (values: ReadonlyArray<JsxValue>): ReadonlyArray<Element> =>
        values.flatMap(value => Array.isArray(value) ? flattenElements(value) : isInstanceOf(value, Element) ? [value] : [])

    // Detaching an editor reloads its iframes (script views), so surviving editors stay attached and only move if needed.
    export const reconcile = (container: Element, ...values: ReadonlyArray<JsxValue>): void => {
        const children = flattenElements(values)
        const keep = new Set<Element>(children)
        Array.from(container.children).forEach(child => {if (!keep.has(child)) {child.remove()}})
        children.forEach((child, index) => {
            const current = container.children.item(index)
            if (current === child) {return}
            if (child.isConnected && container.isConnected && canMoveBefore(container)) {
                container.moveBefore(child, current)
            } else {
                container.insertBefore(child, current)
            }
        })
    }
}
