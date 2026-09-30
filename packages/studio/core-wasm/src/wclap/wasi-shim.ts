// Minimal WASI preview1 for a CLAP plugin module: stdout/stderr to the console, a clock, random bytes, no
// filesystem (every fd/path call answers EBADF/ENOENT). Unknown imports answer ENOSYS instead of trapping.
import {decodeUtf8} from "../utf8"

const ERRNO_SUCCESS = 0
const ERRNO_BADF = 8
const ERRNO_NOENT = 44
const ERRNO_NOSYS = 52
const FILETYPE_CHARACTER_DEVICE = 2

export type WasiImports = Record<string, Record<string, Function>>

export const createWasiImports = (module: WebAssembly.Module, memoryProvider: () => WebAssembly.Memory, label: string): WasiImports => {
    const view = () => new DataView(memoryProvider().buffer)
    const bytes = () => new Uint8Array(memoryProvider().buffer)
    const lines: Array<string> = ["", "", ""]
    const shim: Record<string, Function> = {
        args_get: () => ERRNO_SUCCESS,
        args_sizes_get: (countPtr: number, sizePtr: number) => {
            view().setUint32(countPtr, 0, true)
            view().setUint32(sizePtr, 0, true)
            return ERRNO_SUCCESS
        },
        environ_get: () => ERRNO_SUCCESS,
        environ_sizes_get: (countPtr: number, sizePtr: number) => {
            view().setUint32(countPtr, 0, true)
            view().setUint32(sizePtr, 0, true)
            return ERRNO_SUCCESS
        },
        clock_time_get: (_id: number, _precision: bigint, timePtr: number) => {
            view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true)
            return ERRNO_SUCCESS
        },
        fd_close: () => ERRNO_BADF,
        fd_fdstat_get: (fd: number, statPtr: number) => {
            if (fd > 2) {return ERRNO_BADF}
            bytes().fill(0, statPtr, statPtr + 24)
            view().setUint8(statPtr, FILETYPE_CHARACTER_DEVICE)
            return ERRNO_SUCCESS
        },
        fd_fdstat_set_flags: () => ERRNO_BADF,
        fd_prestat_get: () => ERRNO_BADF,
        fd_prestat_dir_name: () => ERRNO_BADF,
        fd_read: () => ERRNO_BADF,
        fd_seek: () => ERRNO_BADF,
        fd_write: (fd: number, iovsPtr: number, iovsCount: number, writtenPtr: number) => {
            const memory = bytes()
            const dataView = view()
            const chunks: Array<number> = []
            for (let index = 0; index < iovsCount; index++) {
                const bufferPtr = dataView.getUint32(iovsPtr + index * 8, true)
                const length = dataView.getUint32(iovsPtr + index * 8 + 4, true)
                for (let offset = 0; offset < length; offset++) {chunks.push(memory[bufferPtr + offset])}
            }
            dataView.setUint32(writtenPtr, chunks.length, true)
            if (fd === 1 || fd === 2) {
                const text = lines[fd] + decodeUtf8(new Uint8Array(chunks))
                const parts = text.split("\n")
                lines[fd] = parts.pop() ?? ""
                parts.forEach(line => console.log(`[wclap ${label}] ${line}`))
            }
            return ERRNO_SUCCESS
        },
        path_open: () => ERRNO_NOENT,
        poll_oneoff: () => ERRNO_NOSYS,
        proc_exit: (code: number) => {throw new Error(`wclap ${label} exited with ${code}`)},
        random_get: (bufferPtr: number, length: number) => {
            const memory = bytes()
            for (let offset = 0; offset < length; offset++) {memory[bufferPtr + offset] = (Math.random() * 256) | 0}
            return ERRNO_SUCCESS
        },
        sched_yield: () => ERRNO_SUCCESS
    }
    const imports: WasiImports = {}
    for (const entry of WebAssembly.Module.imports(module)) {
        if (entry.kind !== "function" || entry.module === "env") {continue}
        const namespace = imports[entry.module] ?? (imports[entry.module] = {})
        namespace[entry.name] = shim[entry.name] ?? (() => {
            console.warn(`[wclap ${label}] unsupported import ${entry.module}.${entry.name}`)
            return ERRNO_NOSYS
        })
    }
    return imports
}

// The declared limits of the module's memory import (none = the module exports its own memory).
export const readMemoryImportLimits = (bytes: Uint8Array): { initial: number, maximum: number, shared: boolean } | undefined => {
    const position = {index: 8}
    const readLeb = (): number => {
        let result = 0
        let shift = 0
        while (true) {
            const byte = bytes[position.index++]
            result |= (byte & 0x7F) << shift
            if ((byte & 0x80) === 0) {return result >>> 0}
            shift += 7
        }
    }
    const skipName = (): void => {
        const length = readLeb()
        position.index += length
    }
    while (position.index < bytes.length) {
        const id = bytes[position.index++]
        const size = readLeb()
        const end = position.index + size
        if (id === 2) {
            const count = readLeb()
            for (let entry = 0; entry < count; entry++) {
                skipName()
                skipName()
                const kind = bytes[position.index++]
                if (kind === 0) {
                    readLeb()
                } else if (kind === 1) {
                    position.index++
                    const flags = bytes[position.index++]
                    readLeb()
                    if ((flags & 1) !== 0) {readLeb()}
                } else if (kind === 2) {
                    const flags = bytes[position.index++]
                    const initial = readLeb()
                    const maximum = (flags & 1) !== 0 ? readLeb() : 32768
                    return {initial, maximum, shared: (flags & 2) !== 0}
                } else if (kind === 3) {
                    position.index += 2
                }
            }
        }
        position.index = end
    }
    return undefined
}
