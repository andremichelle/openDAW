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
    const freezeRecords = records => Object.freeze(records.map(record => Object.freeze({...record})))
    const dataValues = new Map(config.collections.map(({name}) => [name, freezeRecords(config.data[name] ?? [])]))
    const checkValues = values => {
        if (typeof values !== "object" || values === null) {throw new TypeError("expects an object of field values")}
        for (const [field, value] of Object.entries(values)) {
            if (typeof value !== "number" || !Number.isFinite(value)) {throw new TypeError(`'${field}' expects a finite number`)}
        }
        return {...values}
    }
    const checkIndex = (name, index, length) => {
        if (!Number.isInteger(index) || index < 0 || index >= length) {throw new RangeError(`'${name}' has no record ${index}`)}
    }
    const data = Object.create(null)
    for (const {name, length} of config.buffers) {
        dataValues.set(name, Float32Array.from(config.data[name] ?? new Float32Array(length)))
        data[name] = Object.freeze({
            length,
            get(index) {return dataValues.get(name)[index]},
            toArray() {return dataValues.get(name).slice()},
            set(values, offset = 0) {
                if (!Number.isInteger(offset)) {throw new TypeError(`'${name}' expects an integer offset`)}
                const numbers = Array.from(values, value => {
                    if (typeof value !== "number" || !Number.isFinite(value)) {throw new TypeError(`'${name}' expects finite numbers`)}
                    return value
                })
                const current = dataValues.get(name)
                numbers.forEach((value, index) => {
                    const position = offset + index
                    if (position >= 0 && position < length) {current[position] = value}
                })
                write({type: "buffer-set", buffer: name, offset, values: numbers})
            },
            subscribe: observer => subscribe(`data:${name}`, observer)
        })
    }
    for (const {name, fields} of config.collections) {
        const defaults = Object.fromEntries(fields.map(({label, defaultValue}) => [label, defaultValue]))
        const replace = records => dataValues.set(name, freezeRecords(records))
        data[name] = Object.freeze({
            get length() {return dataValues.get(name).length},
            get(index) {return dataValues.get(name)[index]},
            toArray() {return dataValues.get(name)},
            set(index, values) {
                const records = dataValues.get(name)
                checkIndex(name, index, records.length)
                const checked = checkValues(values)
                replace(records.map((record, position) => position === index ? {...record, ...checked} : record))
                write({type: "record-set", collection: name, index, values: checked})
            },
            insert(index, values = {}) {
                const records = dataValues.get(name)
                const position = Math.max(0, Math.min(records.length, Math.round(index)))
                const checked = checkValues(values)
                replace([...records.slice(0, position), {...defaults, ...checked}, ...records.slice(position)])
                write({type: "record-insert", collection: name, index: position, values: checked})
            },
            remove(index) {
                const records = dataValues.get(name)
                checkIndex(name, index, records.length)
                replace(records.filter((record, position) => position !== index))
                write({type: "record-remove", collection: name, index})
            },
            subscribe: observer => subscribe(`data:${name}`, observer)
        })
    }
    const fft = (real, imag) => {
        const size = real.length
        for (let index = 1, swap = 0; index < size; index++) {
            let bit = size >> 1
            for (; swap & bit; bit >>= 1) {swap ^= bit}
            swap ^= bit
            if (index < swap) {
                [real[index], real[swap]] = [real[swap], real[index]];
                [imag[index], imag[swap]] = [imag[swap], imag[index]]
            }
        }
        for (let length = 2; length <= size; length <<= 1) {
            const angle = -2 * Math.PI / length
            for (let start = 0; start < size; start += length) {
                for (let offset = 0; offset < length >> 1; offset++) {
                    const cos = Math.cos(angle * offset), sin = Math.sin(angle * offset)
                    const even = start + offset, odd = even + (length >> 1)
                    const re = real[odd] * cos - imag[odd] * sin
                    const im = real[odd] * sin + imag[odd] * cos
                    real[odd] = real[even] - re
                    imag[odd] = imag[even] - im
                    real[even] += re
                    imag[even] += im
                }
            }
        }
    }
    const spectrumOf = (state, samples) => {
        const {real, imag, magnitudes} = state
        const size = real.length
        for (let index = 0; index < size; index++) {
            real[index] = (samples[index] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1)))
            imag[index] = 0
        }
        fft(real, imag)
        for (let bin = 0; bin < magnitudes.length; bin++) {magnitudes[bin] = Math.hypot(real[bin], imag[bin]) * 4 / size}
        return magnitudes
    }
    const streamStates = new Map()
    const streams = Object.create(null)
    for (const {name, length, kind} of config.streams) {
        const key = `stream:${name}`
        const isPowerOfTwo = length > 0 && (length & (length - 1)) === 0
        if (kind === "fft" && !isPowerOfTwo) {reportError(new Error(`@stream ${name}: fft needs a power of two, got ${length}`))}
        streamStates.set(name, kind === "fft"
            ? {kind, real: new Float32Array(length * 2), imag: new Float32Array(length * 2), magnitudes: new Float32Array(length)}
            : {kind})
        streams[name] = Object.freeze({
            length, kind,
            subscribe(observer) {
                const subscription = subscribe(key, observer)
                if (observers.get(key).size === 1) {post({type: "stream", action: "subscribe", name})}
                return Object.freeze({
                    terminate() {
                        subscription.terminate()
                        if (observers.get(key).size === 0) {post({type: "stream", action: "unsubscribe", name})}
                    }
                })
            }
        })
    }
    const preview = Object.freeze({
        noteOn(pitch, velocity = 0.8) {post({type: "preview", on: true, pitch, velocity})},
        noteOff(pitch) {post({type: "preview", on: false, pitch})}
    })
    const host = Object.freeze({
        root: document.body,
        mode: config.mode,
        params: Object.freeze(params),
        data: Object.freeze(data),
        streams: Object.freeze(streams),
        preview,
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
        send(message) {post({type: "send", message})},
        openWindow(name) {post({type: "window", action: "open", name: name ?? "View"})},
        closeWindow(name) {post({type: "window", action: "close", name: name ?? "View"})},
        color(name, opacity = 1) {
            const color = config.colors[name] ?? ""
            return opacity >= 1 ? color : color.replace(/^hsl\((.*)\)$/, (match, inner) => `hsla(${inner}, ${Math.max(0, opacity)})`)
        }
    })
    globalThis.addEventListener("contextmenu", event => {
        event.preventDefault()
        event.stopImmediatePropagation()
    }, {capture: true})
    for (const kind of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick"]) {
        globalThis.addEventListener(kind, event => {
            if (event.button === 2) {event.stopImmediatePropagation()}
        }, {capture: true})
    }
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
        } else if (message.type === "data") {
            for (const [name, values] of Object.entries(message.data)) {
                if (!dataValues.has(name)) {continue}
                dataValues.set(name, values instanceof Float32Array ? values : freezeRecords(values))
                notify(`data:${name}`, dataValues.get(name))
            }
        } else if (message.type === "stream") {
            const state = streamStates.get(message.name)
            if (state === undefined) {return}
            notify(`stream:${message.name}`, state.kind === "fft" ? spectrumOf(state, message.values) : message.values)
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
