import {Procedure} from "@opendaw/lib-std"
import {Inject} from "./inject"

export type DomElement = HTMLElement | SVGElement
export type JsxValue = null | undefined | boolean | string | number | DomElement | Array<JsxValue>
export type CSSVars = Record<`--${string}`, string>

// These are all utility type to let jsx understand usual HTML and SVG elements.
//
type AttributeMap = {
    className?: string | Inject.ClassList
    style?: Partial<CSSStyleDeclaration> | CSSVars
}

// Some elements (e.g. HTMLFormElement, HTMLSelectElement) carry index signatures
// ([index: number]: Element, [name: string]: any). Left in, those leak into the JSX props type and
// make TS collapse the element's children to `string`, so `<form>{someElement}</form>` fails to
// type-check. Dropping the index signatures before mapping lets such tags accept element children
// like any other; arbitrary attributes stay allowed via the `& Record<string, unknown>` below.
type RemoveIndexSignature<T> = {
    [K in keyof T as
        string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K]
}

type ExtractProperties<T extends Element> = Partial<{
    [K in keyof RemoveIndexSignature<T>]:
    K extends keyof AttributeMap ? AttributeMap[K] :
        K extends keyof GlobalEventHandlers ? GlobalEventHandlers[K] :
            T[K] extends Function ? never :
                (T[K] extends SVGAnimatedBoolean ? boolean | string :
                    T[K] extends SVGAnimatedAngle ? number | string :
                        T[K] extends SVGAnimatedLength ? number | string :
                            T[K] extends number ? number | string :
                                T[K] extends boolean ? boolean | string :
                                    string) | Inject.Attribute
}> & {
    ref?: Inject.Ref<T>
    onInit?: Procedure<T> // runs immediately after the element is created
    onConnect?: Procedure<T> // runs immediately after the element is connected to the DOM (caution, it waits forever!)
} & Record<string, unknown>

declare global {
    namespace JSX {
        // @ts-ignore
        // noinspection JSUnusedGlobalSymbols
        type IntrinsicElements =
            & { [K in keyof Omit<SVGElementTagNameMap, "a">]: ExtractProperties<Omit<SVGElementTagNameMap, "a">[K]> }
            & { [K in keyof Omit<HTMLElementTagNameMap, "a">]: ExtractProperties<Omit<HTMLElementTagNameMap, "a">[K]> }
            // TODO This guy is really fuzzy. For some reason I cannot type it properly
            & { a: any } // ExtractProperties<HTMLAnchorElement & HTMLElement & HTMLHyperlinkElementUtils>
    }
}