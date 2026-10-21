// Runs inside the sandboxed view iframe (opaque origin, no eval, no network). Talks to the studio over ONE
// MessagePort and builds the `host` object a script's View class receives.
(() => {
    "use strict"
    const config = globalThis.__openDAWConfig
    globalThis.sampleRate = config.sampleRate
    let port = null
    let classes = null
    let instance = null
    let ops = null
    const queued = []
    const post = message => port === null ? queued.push(message) : port.postMessage(message)
    const reportError = error => post({type: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)})
    globalThis.addEventListener("error", event => reportError(event.error ?? event.message))
    globalThis.addEventListener("unhandledrejection", event => reportError(event.reason))
    globalThis.__openDAWViews = registry => {classes = registry}
    const observers = new Map()
    const subscribe = (key, observer) => {
        if (typeof observer !== "function") {throw new TypeError("subscribe expects a function")}
        const set = observers.get(key) ?? new Set()
        observers.set(key, set)
        set.add(observer)
        return Object.freeze({terminate: () => set.delete(observer)})
    }
    const notify = (key, value) => {
        const set = observers.get(key)
        if (set === undefined) {return}
        for (const observer of [...set]) {
            try {observer(value)} catch (error) {reportError(error)}
        }
    }
    const write = op => {
        if (ops !== null) {
            ops.push(op)
        } else {
            post({type: "edit", ops: [op]})
        }
    }
    const collect = procedure => {
        if (ops !== null) {
            procedure()
            return null
        }
        ops = []
        try {
            procedure()
        } catch (error) {
            ops = null
            throw error
        }
        const collected = ops
        ops = null
        return collected
    }
    const paramValues = new Map(config.params.map(({name, value}) => [name, value]))
    const params = Object.create(null)
    for (const {name, label} of config.params) {
        params[name] = Object.freeze({
            label,
            get value() {return paramValues.get(name)},
            set(value) {
                if (typeof value !== "number" || !Number.isFinite(value)) {throw new TypeError(`'${name}' expects a finite number`)}
                paramValues.set(name, value)
                write({type: "param", name, value})
            },
            subscribe: observer => subscribe(`param:${name}`, observer)
        })
    }
    const host = Object.freeze({
        root: document.body,
        mode: config.mode,
        params: Object.freeze(params),
        edit(procedure) {
            const collected = collect(procedure)
            if (collected !== null && collected.length > 0) {post({type: "edit", ops: collected})}
        },
        gesture() {
            let ended = false
            post({type: "gesture", phase: "begin"})
            return Object.freeze({
                edit(procedure) {
                    if (ended) {throw new Error("gesture has ended")}
                    const collected = collect(procedure)
                    if (collected !== null && collected.length > 0) {post({type: "gesture", phase: "edit", ops: collected})}
                },
                end() {
                    if (ended) {return}
                    ended = true
                    post({type: "gesture", phase: "end"})
                }
            })
        },
        openWindow(name) {post({type: "window", action: "open", name: name ?? "View"})},
        closeWindow(name) {post({type: "window", action: "close", name: name ?? "View"})},
        color(name) {return config.colors[name] ?? ""}
    })
    for (const kind of ["keydown", "keyup"]) {
        globalThis.addEventListener(kind, event => {
            const tag = typeof event.target?.tagName === "string" ? event.target.tagName : ""
            if (event.defaultPrevented || tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable === true) {return}
            if (event.metaKey || event.ctrlKey) {event.preventDefault()}
            post({
                type: "key", kind, init: {
                    key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey, altKey: event.altKey, repeat: event.repeat
                }
            })
        })
    }
    const receive = message => {
        if (message.type === "param") {
            paramValues.set(message.name, message.value)
            notify(`param:${message.name}`, message.value)
        } else if (message.type === "terminate") {
            try {instance?.terminate?.()} catch (error) {reportError(error)}
        }
    }
    const start = async ({fonts}) => {
        for (const {weight, bytes} of fonts) {
            const face = new FontFace("Rubik", bytes, {weight: String(weight)})
            try {document.fonts.add(await face.load())} catch (error) {reportError(error)}
        }
        const ViewClass = classes?.[config.className]
        if (typeof ViewClass !== "function") {
            reportError(new Error(`No class '${config.className}' for its @${config.mode === "window" ? "window" : "view"} line`))
            return
        }
        try {instance = new ViewClass(host)} catch (error) {reportError(error)}
    }
    globalThis.addEventListener("message", event => {
        if (port !== null || event.source !== parent || event.ports.length !== 1) {return}
        port = event.ports[0]
        port.onmessage = ({data}) => receive(data)
        queued.splice(0).forEach(message => port.postMessage(message))
        start(event.data).catch(reportError)
    })
})()
