import {InferenceSession, Tensor} from "onnxruntime-web/webgpu"
import {CHUNK_SAMPLES, muScriptorLogMel, prepareMuScriptorAudio} from "./Features"
import {MuScriptorDecoder} from "./Decoder"
import {MuScriptorInput, MuScriptorNote, MuScriptorProgress} from "./types"

type Report = (value: MuScriptorProgress) => void
const emptyConditions = (): Tensor => new Tensor("float16", new Uint16Array(0), [1, 0, 1024])

/** Both sessions and the autoregressive KV caches stay inside one worker. */
export const runMuScriptor = async (input: MuScriptorInput, assets: Record<string, Uint8Array>,
                                   report: Report): Promise<ReadonlyArray<MuScriptorNote>> => {
    report({phase: "load", value: 0})
    const conditioner = await InferenceSession.create(assets["conditioner.onnx"], {
        executionProviders: ["webgpu"],
        externalData: [{path: "conditioner.onnx.data", data: assets["conditioner.onnx.data"]}],
        preferredOutputLocation: {condition_embeds: "gpu-buffer"}
    })
    let model: InferenceSession | undefined
    try {
        model = await InferenceSession.create(assets["model.onnx"], {
            executionProviders: ["webgpu"],
            externalData: [{path: "model.onnx.data", data: assets["model.onnx.data"]}],
            preferredOutputLocation: Object.fromEntries([
                ["logits", "cpu"],
                ...Array.from({length: 24}, (_, layer) => [
                    [`present.${layer}.key`, "gpu-buffer"], [`present.${layer}.value`, "gpu-buffer"]
                ]).flat()
            ]) as Record<string, "cpu" | "gpu-buffer">
        })
        // Release host references after ORT has loaded the external data.
        for (const key of Object.keys(assets)) {delete assets[key]}
        report({phase: "load", value: 1})
        const audio = prepareMuScriptorAudio(input), duration = input.end - input.start
        const chunks = Math.ceil(audio.length / CHUNK_SAMPLES), decoder = new MuScriptorDecoder()
        for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
            const offset = chunkIndex * 5
            const chunk = new Float32Array(CHUNK_SAMPLES)
            chunk.set(audio.subarray(chunkIndex * CHUNK_SAMPLES, (chunkIndex + 1) * CHUNK_SAMPLES))
            const mel = muScriptorLogMel(chunk)
            const conditionerFeeds = {
                log_mel: new Tensor("float32", mel.data, [1, mel.frames, 512]),
                // Null class tokens match ClassConditioner.tokenize(None) in the source model.
                instrument_ids: new Tensor("int64", BigInt64Array.of(0n), [1, 1]),
                dataset_ids: new Tensor("int64", BigInt64Array.of(0n), [1, 1])
            }
            const conditioned = await conditioner.run(conditionerFeeds)
            Object.values(conditionerFeeds).forEach(tensor => tensor.dispose())
            const conditions = conditioned.condition_embeds as Tensor
            let cache: Record<string, Tensor> = {}
            for (let layer = 0; layer < 24; layer++) {
                for (const kind of ["key", "value"]) {
                    cache[`past_key_values.${layer}.${kind}`] = new Tensor("float16", new Uint16Array(0), [1, 16, 0, 64])
                }
            }
            let tokens = decoder.beginChunk(offset, Math.min(offset + 5, duration))
            // Later chunks' forced ties also update the note state machine;
            // the first chunk's prologue arrives through generated tokens.
            tokens.slice(1).forEach(token => decoder.feed(token))
            let ended = false
            const noConditions = emptyConditions()
            try {
                for (let step = 0; step < 2000; step++) {
                    const ids = new Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length])
                    const output = await model.run({input_ids: ids,
                        condition_embeds: step === 0 ? conditions : noConditions, ...cache})
                    ids.dispose()
                    Object.values(cache).forEach(tensor => tensor.dispose())
                    cache = {}
                    for (let layer = 0; layer < 24; layer++) {
                        for (const kind of ["key", "value"]) {
                            cache[`past_key_values.${layer}.${kind}`] = output[`present.${layer}.${kind}`] as Tensor
                        }
                    }
                    const logitsTensor = output.logits as Tensor
                    const logits = await logitsTensor.getData() as Float32Array
                    const start = logits.length - 1395
                    let id = -1, best = -Infinity
                    // Only the 1393 defined event tokens are valid, not training padding tokens.
                    for (let i = 0; i < 1393; i++) {
                        if (Number.isFinite(logits[start + i]) && logits[start + i] > best) {
                            id = i; best = logits[start + i]
                        }
                    }
                    logitsTensor.dispose()
                    if (id < 0) {throw new Error("MuScriptor returned invalid predictions")}
                    if (id === 1) {ended = true; break}
                    decoder.feed(id)
                    tokens = [id]
                    if (step % 16 === 0) {report({phase: "transcribe", value: chunkIndex / chunks})}
                }
                if (!ended) {throw new Error("MuScriptor exceeded its decoding limit; try a shorter or simpler clip")}
            } finally {
                Object.values(cache).forEach(tensor => tensor.dispose())
                conditions.dispose()
                noConditions.dispose()
            }
            report({phase: "transcribe", value: (chunkIndex + 1) / chunks})
        }
        return decoder.finish(duration)
    } finally {
        await model?.release()
        await conditioner.release()
    }
}
