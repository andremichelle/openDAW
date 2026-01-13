import {asDefined, byte, ByteArrayOutput, Func, Procedure, unitValue} from "@moises-ai/lib-std"

export namespace Fetch {
    export const ProgressArrayBuffer = (progress: Procedure<unitValue>): Func<Response, Promise<ArrayBufferLike>> =>
        async (response: Response): Promise<ArrayBufferLike> => {
            if (!response.headers.has("Content-Length")) {
                console.debug("No Content-Length")
                return response.arrayBuffer()
            }
            const length = parseInt(response.headers.get("Content-Length")!)
            console.debug(`Content-Length: ${length}b`)
            if (isNaN(length) || length < 4096) {return response.arrayBuffer()} // smaller sizes do not need progress
            progress(0.0)
            const output = ByteArrayOutput.create(length)
            const reader = asDefined(response.body, "response.body is empty").getReader()
            while (true) {
                const {done, value} = await reader.read()
                if (done) {break}
                value.forEach((value: byte) => output.writeByte(value))
                progress(output.position / length)
            }
            progress(1.0)
            return output.toArrayBuffer()
        }
}