import {EmptyExec, isDefined} from "@moises-ai/lib-std"
import {Html} from "@moises-ai/lib-dom"
import sanitize = Html.sanitize

export type HTMLSource = string | URL | Promise<Response>

export const HTML = ({src, className}: { src: HTMLSource, className?: string }) => {
    const placeholder = document.createElement("span")
    ;(async () => {
        let markup: string
        if (typeof src === "string") {
            markup = src
        } else if (src instanceof URL) {
            const response = await fetch(src.toString(), {credentials: "same-origin"})
            markup = await response.text()
        } else {
            markup = await src.then(x => x.text())
        }
        const frag = document.createElement("div")
        frag.innerHTML = markup
        sanitize(frag)
        if (isDefined(className)) {
            for (const node of frag.childNodes) {
                if (node instanceof Element) {
                    node.classList.add(...className.split(/\s+/))
                }
            }
        }
        placeholder.replaceWith(...Array.from(frag.childNodes))
    })().catch(EmptyExec)
    return placeholder
}