// A JS closure cannot enter a wasm funcref table directly: a one-function module imports and re-exports it
export type WasmValType = "i32" | "i64" | "f32" | "f64"

const VAL_TYPE_CODES: Record<WasmValType, number> = {i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C}

const leb = (value: number): Array<number> => {
    const out: Array<number> = []
    const emit = (remaining: number): void => {
        const byte = remaining & 0x7F
        const rest = remaining >>> 7
        out.push(rest !== 0 ? byte | 0x80 : byte)
        if (rest !== 0) {emit(rest)}
    }
    emit(value)
    return out
}
const str = (text: string): Array<number> => [...leb(text.length), ...Array.from(text, char => char.charCodeAt(0))]
const section = (id: number, body: Array<number>): Array<number> => [id, ...leb(body.length), ...body]

const modules = new Map<string, WebAssembly.Module>()

const moduleFor = (params: ReadonlyArray<WasmValType>, results: ReadonlyArray<WasmValType>): WebAssembly.Module => {
    const key = `${params.join(",")}>${results.join(",")}`
    const cached = modules.get(key)
    if (cached !== undefined) {return cached}
    const type = [0x60, ...leb(params.length), ...params.map(name => VAL_TYPE_CODES[name]),
        ...leb(results.length), ...results.map(name => VAL_TYPE_CODES[name])]
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
        ...section(1, [1, ...type]),
        ...section(2, [1, ...str("e"), ...str("f"), 0x00, 0x00]),
        ...section(7, [1, ...str("f"), 0x00, 0x00])])
    const module = new WebAssembly.Module(bytes)
    modules.set(key, module)
    return module
}

export type TrampolineFn = (...args: Array<never>) => unknown

export const trampoline = (params: ReadonlyArray<WasmValType>,
                           results: ReadonlyArray<WasmValType>,
                           fn: TrampolineFn): TrampolineFn => {
    const instance = new WebAssembly.Instance(moduleFor(params, results), {e: {f: fn}})
    return instance.exports.f as TrampolineFn
}
