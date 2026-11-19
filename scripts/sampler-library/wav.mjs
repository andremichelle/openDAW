// WAV reading shared by the sampler library scripts: PCM 16 and 24 bit, float 32 bit
export const readWav = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4))
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {throw new Error("Not a WAV file")}
    let offset = 12
    let format = null
    while (offset + 8 <= bytes.length) {
        const id = tag(offset)
        const size = view.getUint32(offset + 4, true)
        const body = offset + 8
        if (id === "fmt ") {
            format = {
                tag: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
                sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true)
            }
            // WAVE_FORMAT_EXTENSIBLE names the real format in its sub format
            if (format.tag === 0xfffe && size >= 26) {format.tag = view.getUint16(body + 24, true)}
        } else if (id === "data") {
            if (format === null) {throw new Error("data before fmt")}
            return {format, data: bytes.subarray(body, body + size)}
        }
        offset = body + size + (size % 2)
    }
    throw new Error("Missing data chunk")
}

export const sampleReader = ({bits, tag}) => {
    if (tag === 1 && bits === 16) {return {bytes: 2, read: (view, at) => view.getInt16(at, true) / 32768, write: (view, at, value) => view.setInt16(at, Math.round(value * 32768), true)}}
    if (tag === 1 && bits === 24) {
        return {
            bytes: 3,
            read: (view, at) => ((view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getInt8(at + 2) << 16)) / 8388608,
            write: (view, at, value) => {
                const int = Math.round(value * 8388608)
                view.setUint8(at, int & 0xff)
                view.setUint8(at + 1, (int >> 8) & 0xff)
                view.setInt8(at + 2, int >> 16)
            }
        }
    }
    if (tag === 3 && bits === 32) {return {bytes: 4, read: (view, at) => view.getFloat32(at, true), write: (view, at, value) => view.setFloat32(at, value, true)}}
    throw new Error(`Unsupported format ${tag}/${bits}`)
}
