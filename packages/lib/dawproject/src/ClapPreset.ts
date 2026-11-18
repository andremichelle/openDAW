import {Option} from "@opendaw/lib-std"

// Bitwig's .clap-preset: the ASCII magic "clap", the plugin id (big-endian uint32 length + UTF-8), the raw clap_plugin_state
export namespace ClapPreset {
    export interface Content {
        readonly pluginId: string
        readonly state: Uint8Array
    }

    const Magic = [0x63, 0x6C, 0x61, 0x70]

    export const encode = ({pluginId, state}: Content): ArrayBuffer => {
        const id = new TextEncoder().encode(pluginId)
        const bytes = new Uint8Array(8 + id.byteLength + state.byteLength)
        bytes.set(Magic, 0)
        new DataView(bytes.buffer).setUint32(4, id.byteLength, false)
        bytes.set(id, 8)
        bytes.set(state, 8 + id.byteLength)
        return bytes.buffer
    }

    export const decode = (buffer: ArrayBufferLike): Option<Content> => {
        const bytes = new Uint8Array(buffer)
        if (bytes.byteLength < 8 || Magic.some((value, index) => bytes[index] !== value)) {return Option.None}
        const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, false)
        if (8 + length > bytes.byteLength) {return Option.None}
        const pluginId = new TextDecoder().decode(bytes.subarray(8, 8 + length))
        return Option.wrap({pluginId, state: bytes.slice(8 + length)})
    }
}
