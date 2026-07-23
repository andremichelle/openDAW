import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EffectFactories} from "./EffectFactories"

describe("EffectFactories.keyOfBox", () => {
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.beginTransaction()
    const make = (name: keyof BoxIO.TypeMap) => BoxIO.create(name, graph, UUID.generate())
    it("resolves regular <Key>DeviceBox effects to their factory key", () => {
        expect(EffectFactories.keyOfBox(make("DelayDeviceBox"))).toBe("Delay")
        expect(EffectFactories.keyOfBox(make("ArpeggioDeviceBox"))).toBe("Arpeggio")
        expect(EffectFactories.keyOfBox(make("AutotuneDeviceBox"))).toBe("Autotune")
    })
    it("resolves composite <Key>Box effects to their factory key", () => {
        expect(EffectFactories.keyOfBox(make("AudioEffectCompositeBox"))).toBe("AudioEffectComposite")
        expect(EffectFactories.keyOfBox(make("StereoCompositeBox"))).toBe("StereoComposite")
    })
    it("returns undefined for a box that is not a registered effect", () => {
        expect(EffectFactories.keyOfBox(make("AudioBusBox"))).toBeUndefined()
    })
})
