import {ModelDescriptor} from "../Task"

// Pinned community format conversion of Kyutai/Mirelo MuScriptor Medium.
// Weights: CC BY-NC 4.0; vocabulary and mappings retain original attribution.
export const MUSCRIPTOR_ASSETS: Readonly<Record<string, ModelDescriptor>> = {
    "conditioner.onnx": {
        "url": "https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx/resolve/18b368334ddaeafed4446377eb7d0b63d14ccc1f/conditioner.onnx",
        "sha256": "223f00272b0721a46f09a901d44557e43b8db199c6ecfc8484d9fb40cb22e20a",
        "bytes": 1591,
        "version": "18b368334ddaeafed4446377eb7d0b63d14ccc1f"
    },
    "conditioner.onnx.data": {
        "url": "https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx/resolve/18b368334ddaeafed4446377eb7d0b63d14ccc1f/conditioner.onnx.data",
        "sha256": "f4c980a55579dacef4d6eeded1aef36fa9af508e68b2493314af4b0dc93503ab",
        "bytes": 6221824,
        "version": "18b368334ddaeafed4446377eb7d0b63d14ccc1f"
    },
    "model.onnx": {
        "url": "https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx/resolve/18b368334ddaeafed4446377eb7d0b63d14ccc1f/model.onnx",
        "sha256": "058c07d7284c4ec685c128f85ddbda76b8121f00f359dd726824c42805044c83",
        "bytes": 154663,
        "version": "18b368334ddaeafed4446377eb7d0b63d14ccc1f"
    },
    "model.onnx.data": {
        "url": "https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx/resolve/18b368334ddaeafed4446377eb7d0b63d14ccc1f/model.onnx.data",
        "sha256": "1141677a407c13b48fc4d25d5209202bdda8e6ca5a0caec3e542a28cbe07654a",
        "bytes": 609896448,
        "version": "18b368334ddaeafed4446377eb7d0b63d14ccc1f"
    }
}

export const MUSCRIPTOR_GROUPS: Readonly<Record<number, string>> = {
    "0": "Acoustic Piano",
    "2": "Electric Piano",
    "8": "Chromatic Percussion",
    "16": "Organ",
    "24": "Acoustic Guitar",
    "26": "Clean Electric Guitar",
    "29": "Distorted Electric Guitar",
    "32": "Acoustic Bass",
    "33": "Electric Bass",
    "40": "Violin",
    "41": "Viola",
    "42": "Cello",
    "43": "Contrabass",
    "46": "Orchestral Harp",
    "47": "Timpani",
    "48": "String Ensemble",
    "50": "Synth Strings",
    "52": "Voice",
    "55": "Orchestra Hit",
    "56": "Trumpet",
    "57": "Trombone",
    "58": "Tuba",
    "60": "French Horn",
    "61": "Brass Section",
    "64": "Soprano And Alto Sax",
    "66": "Tenor Sax",
    "67": "Baritone Sax",
    "68": "Oboe",
    "69": "English Horn",
    "70": "Bassoon",
    "71": "Clarinet",
    "72": "Flutes",
    "80": "Synth Lead",
    "88": "Synth Pad"
}

// Event layout verified against the pinned export's vocab.json (1393 entries).
export const MUSCRIPTOR_VOCAB: ReadonlyArray<{type: string, value: number}> = [
    {type: "PAD", value: 0}, {type: "EOS", value: 0}, {type: "UNK", value: 0},
    ...Array.from({length: 1001}, (_, value) => ({type: "shift", value})),
    ...Array.from({length: 128}, (_, value) => ({type: "pitch", value})),
    {type: "velocity", value: 0}, {type: "velocity", value: 1}, {type: "tie", value: 0},
    ...Array.from({length: 130}, (_, value) => ({type: "program", value})),
    ...Array.from({length: 128}, (_, value) => ({type: "drum", value}))
]
