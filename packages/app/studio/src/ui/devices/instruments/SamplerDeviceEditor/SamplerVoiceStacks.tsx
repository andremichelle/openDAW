import {int, isDefined, Optional} from "@opendaw/lib-std"
import {AutomatableParameterFieldAdapter, SamplerDeviceBoxAdapter, SamplerModulation} from "@opendaw/studio-adapters"
import {ControlContext} from "../NanoDeviceEditor/ParameterControls"
import {SamplerStacks} from "./SamplerStacks"

// The parameters of the Sampler's voices as groups, shown in the device panel and in the sample zone window.
export namespace SamplerVoiceStacks {
    export type Result = {
        readonly stacks: ReadonlyArray<HTMLElement>
        // lights up what a modulation slot connects: the tab of its source, the name of its target
        highlight(source: int, target: int, enabled: boolean): void
    }

    export const create = (context: ControlContext, adapter: SamplerDeviceBoxAdapter): Result => {
        const {value, toggle, stack, tabbed} = SamplerStacks
        const {
            voices, glide, legato, octave, transpose, tune, filterType, cutoff, resonance, volume, panning, mono,
            ampEnvelope, modEnvelope, lfoA, lfoB
        } = adapter.namedParameter
        const highlights: SamplerStacks.Highlights = new Map()
        const envelope = ({delay, attack, hold, decay, sustain, release}: typeof ampEnvelope) =>
            [value(context, delay), value(context, attack), value(context, hold), value(context, decay),
                value(context, sustain), value(context, release)]
        const lfo = ({shape, rate, delay, fade, sync, restart}: typeof lfoA) =>
            [value(context, shape), value(context, rate), value(context, delay), value(context, fade),
                toggle(context, sync), toggle(context, restart)]
        const envelopes = tabbed("blue", 2,
            [{name: "Amp Envelope", cells: envelope(ampEnvelope)}, {name: "Mod Envelope", cells: envelope(modEnvelope)}], highlights)
        const oscillators = tabbed("purple", 2, [{name: "LFO 1", cells: lfo(lfoA)}, {name: "LFO 2", cells: lfo(lfoB)}], highlights)
        const sourceTabs: ReadonlyArray<Optional<HTMLElement>> = [...envelopes.tabs, ...oscillators.tabs]
        const targetParameters: Partial<Record<SamplerModulation.Target, AutomatableParameterFieldAdapter>> = {
            [SamplerModulation.Target.Pitch]: tune,
            [SamplerModulation.Target.Cutoff]: cutoff,
            [SamplerModulation.Target.Resonance]: resonance,
            [SamplerModulation.Target.Gain]: volume,
            [SamplerModulation.Target.Panning]: panning,
            [SamplerModulation.Target.LfoARate]: lfoA.rate,
            [SamplerModulation.Target.LfoBRate]: lfoB.rate
        }
        return {
            stacks: [
                stack("orange", "Play", 2, [
                    value(context, voices), value(context, octave), value(context, glide), value(context, transpose),
                    toggle(context, legato), value(context, tune)
                ], highlights),
                stack("yellow", "Filter", 1, [value(context, filterType), value(context, cutoff), value(context, resonance)], highlights),
                stack("green", "Mix", 1, [value(context, volume), value(context, panning), value(context, mono)], highlights),
                envelopes.element,
                oscillators.element
            ],
            highlight: (source: int, target: int, enabled: boolean): void => {
                sourceTabs[source]?.classList.toggle("highlight", enabled)
                const parameter = targetParameters[target as SamplerModulation.Target]
                if (isDefined(parameter)) {SamplerStacks.highlight(highlights, parameter, enabled)}
            }
        }
    }
}
