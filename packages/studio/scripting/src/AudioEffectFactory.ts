import {Box, BoxGraph} from "@moises-ai/lib-box"
import {AudioUnitBox, DelayDeviceBox} from "@moises-ai/studio-boxes"
import {Unhandled, UUID} from "@moises-ai/lib-std"
import {AudioEffects} from "./Api"

export class AudioEffectFactory {
    static write(boxGraph: BoxGraph,
                 audioUnitBox: AudioUnitBox,
                 effect: Required<AudioEffects[keyof AudioEffects]>): Box {
        switch (effect.key) {
            case "delay": {
                return DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.delayMusical.setValue(effect.delay)
                    box.feedback.setValue(effect.feedback)
                    box.cross.setValue(effect.cross)
                    box.filter.setValue(effect.filter)
                    box.dry.setValue(effect.dry)
                    box.wet.setValue(effect.wet)
                    box.enabled.setValue(effect.enabled)
                    box.label.setValue(effect.label) // TODO uniquify?
                    box.host.refer(audioUnitBox.audioEffects)
                })
            }
            default:
                return Unhandled(effect.key)
        }
    }
}