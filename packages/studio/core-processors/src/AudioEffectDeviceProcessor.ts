import {AudioDeviceProcessor} from "./AudioDeviceProcessor"
import {AudioInput} from "./processing"
import {int} from "@moises-ai/lib-std"
import {AudioEffectDeviceAdapter} from "@moises-ai/studio-adapters"

export interface AudioEffectDeviceProcessor extends AudioDeviceProcessor, AudioInput {
    index(): int
    adapter(): AudioEffectDeviceAdapter
}