import {ByteArrayInput, ByteArrayOutput, clamp, Option} from "@opendaw/lib-std"
import {Clipboard} from "@opendaw/lib-dom"
import {ClipboardManager} from "@opendaw/studio-core"
import {CubedPatternData, CubedStep} from "@opendaw/studio-adapters"

export namespace CubedPatternClipboard {
    const encode = ({length, steps}: CubedPatternData): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeInt(length)
        output.writeInt(steps.length)
        steps.forEach(step => output.writeInt(CubedStep.pack(step)))
        return output.toArrayBuffer()
    }

    const decode = (buffer: ArrayBufferLike): Option<CubedPatternData> => Option.tryCatch(() => {
        const input = new ByteArrayInput(buffer)
        const length = input.readInt()
        const count = clamp(input.readInt(), 0, CubedPatternData.MaxSteps)
        const steps = Array.from({length: count}, () => CubedStep.unpack(input.readInt()))
        return {length, steps}
    }).flatMap(({length, steps}) => steps.length === 0
        ? Option.None
        : Option.wrap({length: clamp(length, 1, steps.length), steps}))

    export const write = (data: CubedPatternData): Promise<void> =>
        Clipboard.writeText(ClipboardManager.encode({type: CubedPatternData.Type, data: encode(data), count: 1}))

    export const read = async (): Promise<Option<CubedPatternData>> =>
        ClipboardManager.decode(await Clipboard.readText())
            .flatMap(entry => entry.type === CubedPatternData.Type ? decode(entry.data) : Option.None)
}
