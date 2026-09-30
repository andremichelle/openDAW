// A JS closure cannot be placed into a wasm funcref table directly. This builds a one-function module that
// imports the closure and re-exports it, yielding an exported function the plugin's table accepts.
export type WasmValType = "i32" | "i64" | "f32" | "f64"

const VAL_TYPE_CODES: Record<WasmValType, number> = {i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C}

const leb = (value: number): Array<number> => {
    const out: Array<number> = []
    do {
        const byte = value & 0x7F
        value >>>= 7
        out.push(value !== 0 ? byte | 0x80 : byte)
    } while (value !== 0)
    return out
}
const str = (text: string): Array<number> => [...leb(text.length), ...Array.from(text, char => char.charCodeAt(0))]
const section = (id: number, body: Array<number>): Array<number> => [id, ...leb(body.length), ...body]

export const trampoline = (params: ReadonlyArray<WasmValType>,
                           results: ReadonlyArray<WasmValType>,
                           fn: (...args: Array<never>) => unknown): Function => {
    const type = [0x60, ...leb(params.length), ...params.map(name => VAL_TYPE_CODES[name]),
        ...leb(results.length), ...results.map(name => VAL_TYPE_CODES[name])]
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
        ...section(1, [1, ...type]),
        ...section(2, [1, ...str("e"), ...str("f"), 0x00, 0x00]),
        ...section(7, [1, ...str("f"), 0x00, 0x00])])
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {f: fn}})
    return instance.exports.f as Function
}
