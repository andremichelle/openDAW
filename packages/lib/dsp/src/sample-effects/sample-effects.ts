import {Option} from "@opendaw/lib-std"
import {SampleEffect} from "./sample-effect"
import {Amplify} from "./amplify"
import {Normalize} from "./normalize"
import {FadeIn} from "./fade-in"
import {FadeOut} from "./fade-out"
import {Reverse} from "./reverse"
import {ConvertToMono} from "./convert-to-mono"
import {LowPass} from "./low-pass"
import {HighPass} from "./high-pass"
import {Echo} from "./echo"
import {Reverb} from "./reverb"
import {Distortion} from "./distortion"

export namespace SampleEffects {
    export const Basics: ReadonlyArray<SampleEffect> = [Amplify, Normalize, FadeIn, FadeOut, Reverse, ConvertToMono]
    export const Processors: ReadonlyArray<SampleEffect> = [LowPass, HighPass, Echo, Reverb, Distortion]
    export const All: ReadonlyArray<SampleEffect> = [...Basics, ...Processors]

    export const byId = (id: string): Option<SampleEffect> => Option.wrap(All.find(effect => effect.id === id))
}
