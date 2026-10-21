import runtimeSource from "./view-runtime.js?raw"
import {Editing, isDefined, Lifecycle, Nullable, Optional, Procedure, Terminable, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, Pointers} from "@opendaw/studio-enums"
import {Field} from "@opendaw/lib-box"
import {
    AutomatableParameterFieldAdapter,
    CollectionDeclaration,
    ScriptCompiler,
    ScriptRecords,
    ScriptRecordValues
} from "@opendaw/studio-adapters"
import {Fonts} from "@/ui/Fonts"

export type ScriptViewMode = "inline" | "window"

export type ScriptViewParam = {
    readonly name: string
    readonly parameter: AutomatableParameterFieldAdapter<number>
}

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    userCode: string
    className: string
    mode: ScriptViewMode
    sampleRate: number
    params: ReadonlyArray<ScriptViewParam>
    records: Optional<Field<Pointers.ScriptRecord>>
    collections: ReadonlyArray<CollectionDeclaration>
    onError: Procedure<string>
    onWindow: (action: "open" | "close", className: string) => void
}

type Message = { readonly [key: string]: unknown }

const MAX_OPS = 1024
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:"

const isRecord = (value: unknown): value is Message => typeof value === "object" && value !== null

type FontBytes = ReadonlyArray<{ weight: number, bytes: ArrayBuffer }>

const fonts: { bytes: Nullable<Promise<FontBytes>> } = {bytes: null}

const loadFonts = (): Promise<FontBytes> => fonts.bytes ??= Promise.all(
    [Fonts.Rubik, Fonts.RubikBold].map(font => fetch(String(font.src))
        .then(response => response.arrayBuffer())
        .then(bytes => ({weight: Number(font["font-weight"]), bytes}))))

const cssVariables = (): string => Object.entries(Colors)
    .map(([name, color]) => `--color-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}: ${color};`)
    .join(" ")

const colorMap = (): { [name: string]: string } =>
    Object.fromEntries(Object.entries(Colors).map(([name, color]) => [name, String(color)]))

const inlineScript = (source: string): string => source.replace(/<\/(script)/gi, "<\\/$1")

const buildSrcdoc = (config: object, userScript: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>:root { color-scheme: dark; ${cssVariables()} }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent }
body { font-family: Rubik, sans-serif; font-size: 11px; color: var(--color-gray) }</style></head>
<body><script>globalThis.__openDAWConfig = ${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
<script>${inlineScript(runtimeSource)}</script>
<script>${inlineScript(userScript)}</script></body></html>`

export const ScriptViewFrame = ({
                                    lifecycle, editing, userCode, className, mode, sampleRate, params, records, collections,
                                    onError, onWindow
                                }: Construct): HTMLIFrameElement => {
    const paramsByName = new Map(params.map(({name, parameter}) => [name, parameter]))
    const collectionsByName = new Map(collections.map(collection => [collection.name, collection]))
    const readData = (): { [name: string]: ReadonlyArray<ScriptRecordValues> } => isDefined(records)
        ? Object.fromEntries(collections.map(collection => [collection.name, ScriptRecords.read(records, collection)]))
        : {}
    const config = {
        className, mode, sampleRate, colors: colorMap(),
        params: params.map(({name, parameter}) => ({name, label: parameter.name, value: parameter.getControlledValue()})),
        collections: collections.map(({name, fields}) => ({name, fields: fields.map(({label, defaultValue}) => ({label, defaultValue}))})),
        data: readData()
    }
    const iframe: HTMLIFrameElement = (<iframe className="script-view" sandbox="allow-scripts"/>)
    iframe.srcdoc = buildSrcdoc(config, ScriptCompiler.wrapView(userCode))
    const connection = lifecycle.own(new Terminator())
    const state: { port: Nullable<MessagePort>, gesture: boolean } = {port: null, gesture: false}
    const send = (message: object): void => state.port?.postMessage(message)
    const toValues = (value: unknown): ScriptRecordValues => isRecord(value)
        ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
        : {}
    const applyOp = (op: Message): void => {
        if (op.type === "param" && typeof op.name === "string") {
            const parameter = paramsByName.get(op.name)
            if (!isDefined(parameter) || typeof op.value !== "number" || !Number.isFinite(op.value)) {return}
            parameter.setUnitValue(parameter.valueMapping.x(op.value))
            return
        }
        if (!isDefined(records) || typeof op.collection !== "string") {return}
        const collection = collectionsByName.get(op.collection)
        const index = op.index
        if (!isDefined(collection) || typeof index !== "number" || !Number.isInteger(index)) {return}
        if (op.type === "record-set") {
            ScriptRecords.set(records, collection, index, toValues(op.values))
        } else if (op.type === "record-insert") {
            ScriptRecords.insert(records, collection, index, toValues(op.values))
        } else if (op.type === "record-remove") {
            ScriptRecords.remove(records, collection, index)
        }
    }
    const applyOps = (ops: ReadonlyArray<unknown>): void => {
        for (const op of ops.slice(0, MAX_OPS)) {
            if (isRecord(op)) {applyOp(op)}
        }
    }
    const endGesture = (): void => {
        if (!state.gesture) {return}
        state.gesture = false
        editing.mark()
    }
    const receive = (message: unknown): void => {
        if (!isRecord(message)) {return}
        if (message.type === "edit" && Array.isArray(message.ops)) {
            const ops: ReadonlyArray<unknown> = message.ops
            editing.modify(() => applyOps(ops))
        } else if (message.type === "gesture") {
            if (message.phase === "begin") {
                endGesture()
                editing.mark()
                state.gesture = true
            } else if (message.phase === "edit" && state.gesture && Array.isArray(message.ops)) {
                const ops: ReadonlyArray<unknown> = message.ops
                editing.modify(() => applyOps(ops), false)
            } else if (message.phase === "end") {
                endGesture()
            }
        } else if (message.type === "key" && (message.kind === "keydown" || message.kind === "keyup") && isRecord(message.init)) {
            const {key, code, metaKey, ctrlKey, shiftKey, altKey, repeat} = message.init
            globalThis.dispatchEvent(new KeyboardEvent(message.kind, {
                key: String(key), code: String(code), metaKey: metaKey === true, ctrlKey: ctrlKey === true,
                shiftKey: shiftKey === true, altKey: altKey === true, repeat: repeat === true
            }))
        } else if (message.type === "error" && typeof message.message === "string") {
            onError(message.message.slice(0, 4096))
        } else if (message.type === "window" && (message.action === "open" || message.action === "close")
            && typeof message.name === "string") {
            onWindow(message.action, message.name)
        }
    }
    const connect = (): void => {
        connection.terminate()
        endGesture()
        const target = iframe.contentWindow
        if (!isDefined(target)) {return}
        const channel = new MessageChannel()
        state.port = channel.port1
        channel.port1.onmessage = event => receive(event.data)
        connection.ownAll(
            ...params.map(({name, parameter}) =>
                parameter.subscribe(() => send({type: "param", name, value: parameter.getControlledValue()}))),
            isDefined(records) && collections.length > 0
                ? ScriptRecords.observe(records, () => send({type: "data", data: readData()}))
                : Terminable.Empty,
            Terminable.create(() => {
                send({type: "terminate"})
                channel.port1.close()
                state.port = null
            })
        )
        loadFonts()
            .then(fonts => target.postMessage({fonts}, "*", [channel.port2]))
            .catch(() => target.postMessage({fonts: []}, "*", [channel.port2]))
    }
    lifecycle.ownAll(
        Events.subscribe(iframe, "load", connect),
        Terminable.create(endGesture)
    )
    return iframe
}
