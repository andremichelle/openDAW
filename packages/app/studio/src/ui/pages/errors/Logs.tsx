import css from "./Logs.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {isDefined, TimeSpan} from "@moises-ai/lib-std"
import {createElement, Group} from "@moises-ai/lib-jsx"
import {LogBuffer} from "@/errors/LogBuffer.ts"

const className = Html.adoptStyleSheet(css, "Logs")

type Construct = {
    errorTime: number
    entries: ReadonlyArray<LogBuffer.Entry>
}

export const Logs = ({errorTime, entries}: Construct) => {
    return (
        <div className={className}>
            <Group>
                <h4>Level</h4>
                <h4>Since</h4>
                <h4>Message</h4>
            </Group>
            {entries.map(({time, level, args}) => {
                const elapsed = TimeSpan.millis(new Date(time).getTime() - errorTime)
                const {h, m, s} = elapsed.split()
                return (
                    <Group>
                        <div>[{level.toUpperCase()}]</div>
                        <div>
                            <span style={{opacity: "0.5"}}>
                                {h.toFixed(0).padStart(2, "0")}
                            </span>
                            <span> </span>
                            <span>
                                {m.toFixed(0).padStart(2, "0")}
                            </span>
                            <span>:</span>
                            <span>
                                {s.toFixed(0).padStart(2, "0")}
                            </span>
                            <span style={{opacity: "0.5"}}>
                                .{(Math.abs(elapsed.millis()) % 1000).toFixed(0).padStart(3, "0")}
                            </span>
                        </div>
                        {renderLogEntry(args)}
                    </Group>
                )
            })}
        </div>
    )
}

const renderLogEntry = (parameters: ReadonlyArray<string>): HTMLElement => {
    const format = parameters.at(0)
    const args = parameters.slice(1)
    const container = (<div style={{display: "inline"}}></div>)
    if (!isDefined(format)) {return container}
    let argIndex = 0
    let style: Partial<CSSStyleDeclaration> = {}
    const regex = /%[cdfiosO%]/g
    let lastIndex = 0
    const matches = [...format.matchAll(regex)]
    if (matches.length === 0) {
        container.appendChild(makeSpan([format, ...args].join(" "), {}))
        return container
    }
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i][0]
        const index = matches[i].index!
        const raw = format.slice(lastIndex, index)
        if (isDefined(raw) && raw.length > 0) {
            container.appendChild(makeSpan(raw, style))
        }
        if (match === "%%") {
            container.appendChild(makeSpan("%", style))
        } else if (match === "%c") {
            const cssText = args[argIndex++]
            if (isDefined(cssText)) {
                style = parseStyle(cssText)
            } else {
                style = {}
            }
        } else {
            const val = args[argIndex++]
            if (isDefined(val)) {
                container.appendChild(makeSpan(formatToken(match, val), style))
            }
        }
        lastIndex = index + match.length
    }
    const tail = format.slice(lastIndex)
    if (isDefined(tail) && tail.length > 0) {
        container.appendChild(makeSpan(tail, style))
    }
    return container
}

const makeSpan = (text: string, style: Partial<CSSStyleDeclaration>): HTMLSpanElement =>
    <span style={style}>{text}</span>

const formatToken = (token: string, val: any): string => {
    switch (token) {
        case "%d":
        case "%i":
            return parseInt(val).toString()
        case "%f":
            return parseFloat(val).toString()
        case "%s":
            return String(val)
        case "%o":
        case "%O":
            return typeof val === "object" ? JSON.stringify(val) : String(val)
        default:
            return String(val)
    }
}

const parseStyle = (input: string): Partial<CSSStyleDeclaration> => {
    const result: Partial<CSSStyleDeclaration> = {}
    for (const part of input.split(";")) {
        const [key, value] = part.split(":").map(s => s.trim())
        if (!isDefined(key) || !isDefined(value) || key.length === 0 || value.length === 0) {continue}
        const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        ;(result as any)[camel] = value
    }
    return result
}