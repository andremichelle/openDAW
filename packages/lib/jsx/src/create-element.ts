import {canWrite, isDefined, panic, Procedure, safeWrite} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {SupportedSvgTags} from "./supported-svg-tags"
import {Inject} from "./inject"
import {DomElement, JsxValue} from "./types"

type Factory = (attributes: Readonly<Record<string, any>>, children?: ReadonlyArray<JsxValue>) => JsxValue
type TagOrFactoryOrElement = string | Factory | DomElement

const EmptyAttributes = Object.freeze({})
const EmptyChildren: ReadonlyArray<JsxValue> = Object.freeze([])

/**
 * This method must be exposed as the "createElement" method
 * to be passively called on each element defined in jsx files.
 * This is secured by injection defined in vite.config
 * Most magic happens here, but we try to keep it civil.
 */
export function createElement(tagOrFactoryOrElement: TagOrFactoryOrElement,
                              attributes: Readonly<Record<string, any>> | null,
                              ...children: ReadonlyArray<JsxValue>): JsxValue {
    if (tagOrFactoryOrElement instanceof HTMLElement || tagOrFactoryOrElement instanceof SVGElement) {
        // already an element > early out
        return tagOrFactoryOrElement
    }
    let element
    if (typeof tagOrFactoryOrElement === "function") {
        // this is the usual component factory case
        element = tagOrFactoryOrElement(attributes ?? EmptyAttributes, children)
        if (tagOrFactoryOrElement.length === 2) {
            // we expect the children to be consumed by the function, since it accepted a second parameter
            children = EmptyChildren
        }
        if (element === false
            || element === true
            || element === null
            || element === undefined
            || typeof element === "string"
            || typeof element === "number"
            || Array.isArray(element)) {
            // primitives and arrays are ready to be returned immediately and handled as children for the parent
            return element
        }
        // we expect the attributes to be consumed by the factory
        attributes = null
    } else {
        // strings are supposed to be valid html or svg elements
        element = SupportedSvgTags.has(tagOrFactoryOrElement)
            ? document.createElementNS("http://www.w3.org/2000/svg", tagOrFactoryOrElement)
            : document.createElement(tagOrFactoryOrElement)
    }
    if (children.length > 0) {
        appendChildren(element, ...children)
    }
    if (attributes !== null) {
        transferAttributes(element, attributes)
    }
    return element
}

export const replaceChildren = (element: DomElement, ...children: ReadonlyArray<JsxValue>) => {
    Html.empty(element)
    appendChildren(element, ...children)
}

export const appendChildren = (element: DomElement, ...children: ReadonlyArray<JsxValue>) => {
    children.forEach((value: JsxValue | Inject.Value) => {
        if (value === null || value === undefined || value === false) {return}
        if (Array.isArray(value)) {
            appendChildren(element, ...value)
        } else if (value instanceof Inject.Value) {
            const text: Text = document.createTextNode(String(value.value))
            value.addTarget(text)
            element.append(text)
        } else if (typeof value === "string") {
            element.append(document.createTextNode(value))
        } else if (typeof value === "number") {
            element.append(document.createTextNode(String(value)))
        } else if (value instanceof Node) {
            element.append(value)
        }
    })
}

const transferAttributes = (element: DomElement, attributes: Readonly<Record<string, any>>) => {
    Object.entries(attributes).forEach(([key, value]: [string, unknown]) => {
        if (value === undefined) {return}
        if (key === "class" || key === "className") {
            if (value instanceof Inject.ClassList) {
                value.addTarget(element)
            } else {
                element.classList.add(...(<string>value).split(" ").filter(x => x !== ""))
            }
        } else if (key === "style") {
            if (typeof value === "string") {
                element.setAttribute(key, value)
            } else if (isDefined(value)) {
                Object.entries(value).forEach(([key, value]) => {
                    if (key.startsWith("--")) {
                        element.style.setProperty(key, value) // special treatment for css variables
                    } else {
                        safeWrite(element.style, key, value)
                    }
                })
            }
        } else if (key === "ref") {
            if (value instanceof Inject.Ref) {
                value.addTarget(element)
            } else {
                return panic("value of 'ref' must be of type '_Ref'")
            }
        } else if (key === "onInit") {
            if (value instanceof Function && value.length === 1) {
                value(element)
            } else {
                return panic("value of 'onLoad' must be a Function with a single argument")
            }
        } else if (key === "onConnect") {
            if (value instanceof Function && value.length === 1) {
                const check = () => {
                    if (element.isConnected) {
                        (value as Procedure<DomElement>)(element)
                    } else {
                        requestAnimationFrame(check)
                    }
                }
                requestAnimationFrame(check)
            } else {
                return panic("value of 'onLoad' must be a Function with a single argument")
            }
        } else if (value instanceof Inject.Attribute) {
            value.addTarget(element, key)
        } else {
            if (canWrite(element, key)) {
                element[key] = value
            } else {
                element.setAttribute(key, String(value))
            }
        }
    })
}