import {Browser, Html, ModfierKeys} from "@opendaw/lib-dom"
import css from "./Markdown.sass?inline"
import {Exec, isDefined} from "@opendaw/lib-std"
import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import markdownit from "markdown-it"
import {markdownItTable} from "markdown-it-table"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "Markdown")

type Construct = {
    text: string
    actions?: Record<string, Exec>
}

export const renderMarkdown = (element: HTMLElement, text: string, actions?: Record<string, Exec>) => {
    if (Browser.isWindows()) {
        Object.entries(ModfierKeys.Mac)
            .forEach(([key, value]) => text = text.replaceAll(value, (ModfierKeys.Win as any)[key]))
    }
    const md = markdownit()
    md.use(markdownItTable)
    element.innerHTML = md.render(text)
    element.querySelectorAll("img").forEach(img => {
        img.crossOrigin = "anonymous"
        img.style.maxWidth = "100%"
    })
    element.querySelectorAll("a").forEach(a => {
        if (a.href.startsWith("action://")) {
            const actionName = a.href.replace("action://", "")
            const action = actions?.[actionName]
            if (isDefined(action)) {
                a.onclick = (event: Event) => {
                    event.preventDefault()
                    action()
                }
            }
            return
        }
        const url = new URL(a.href)
        if (url.origin === location.origin) {
            a.onclick = (event: Event) => {
                event.preventDefault()
                RouteLocation.get().navigateTo(url.pathname)
            }
        } else {
            a.target = "_blank"
        }
    })
    element.querySelectorAll("code").forEach(code => {
        code.title = "Click to copy to clipboard"
        code.onclick = async () => {
            if (isDefined(code.textContent)) {
                await navigator.clipboard.writeText(code.textContent)
                alert("Copied to clipboard")
            }
        }
    })
    // Replace {icon:Name} with Icon components
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const iconPattern = /\{icon:(\w+)\}/g
    const nodesToReplace: Array<{ node: Text, matches: Array<{ match: string, name: string, index: number }> }> = []
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
        const matches: Array<{ match: string, name: string, index: number }> = []
        let match: RegExpExecArray | null
        while ((match = iconPattern.exec(node.textContent ?? "")) !== null) {
            matches.push({match: match[0], name: match[1], index: match.index})
        }
        if (matches.length > 0) {nodesToReplace.push({node, matches})}
    }
    for (const {node, matches} of nodesToReplace) {
        const parent = node.parentNode
        if (!parent) {continue}
        const text = node.textContent ?? ""
        let lastIndex = 0
        const fragment = document.createDocumentFragment()
        for (const {match, name, index} of matches) {
            if (index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)))
            }
            fragment.appendChild(<Icon symbol={IconSymbol.fromName(name)} className="icon"/>)
            lastIndex = index + match.length
        }
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
        }
        parent.replaceChild(fragment, node)
    }
}

export const Markdown = ({text, actions}: Construct) => {
    if (text.startsWith("<")) {return "Invalid Markdown"}
    const element: HTMLElement = <div className={Html.buildClassList(className, "markdown")}/>
    renderMarkdown(element, text, actions)
    return element
}