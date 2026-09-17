import {AudioBusBox, AudioUnitBox, AuxSendBox} from "@opendaw/studio-boxes"
import {Field, IndexedBox} from "@opendaw/lib-box"
import {AudioSendRouting} from "@opendaw/studio-enums"
import {asInstanceOf, bipolar, int, panic} from "@opendaw/lib-std"
import {AnyAudioUnit, AuxAudioUnit, GroupAudioUnit, Send} from "../Api"
import {Context} from "./Context"
import {Facade} from "./Common"
import {Guard} from "./Guard"
import {AudioUnitImpls} from "./AudioUnits"

export class SendImpl extends Facade<AuxSendBox> implements Send {
    static wrap(context: Context, box: AuxSendBox): SendImpl {
        return context.facade(box, () => new SendImpl(context, box))
    }

    declare amount: number
    declare pan: bipolar

    private constructor(context: Context, box: AuxSendBox) {
        super(context, box)
        this.bind({amount: box.sendGain, pan: box.sendPan})
    }

    get audioUnit(): AnyAudioUnit {
        const field = this.box.audioUnit.targetVertex.unwrap("send has no audio unit")
        return AudioUnitImpls.wrap(this.context, asInstanceOf(field.box, AudioUnitBox))
    }

    get target(): AuxAudioUnit | GroupAudioUnit {
        const busBox = asInstanceOf(this.box.targetBus.targetVertex.unwrap("send has no target").box, AudioBusBox)
        const unitField = busBox.output.targetVertex.unwrap("bus has no audio unit")
        return AudioUnitImpls.wrap(this.context, asInstanceOf(unitField.box, AudioUnitBox)) as AuxAudioUnit | GroupAudioUnit
    }

    get mode(): "pre" | "post" {return this.box.routing.getValue() === AudioSendRouting.Pre ? "pre" : "post"}
    set mode(value: "pre" | "post") {
        const validated = Guard.oneOf(value, ["pre", "post"], "mode")
        this.context.edit(() => this.box.routing.setValue(validated === "pre" ? AudioSendRouting.Pre : AudioSendRouting.Post))
    }

    get index(): int {return this.box.index.getValue()}

    remove(): void {
        this.context.edit(() => {
            const field = this.box.audioUnit.targetVertex.unwrap("send has no audio unit") as Field
            const index = this.index
            IndexedBox.removeOrder(field, index)
            this.box.delete()
        })
    }
}

export namespace Sends {
    export const validateTarget = (target: unknown): AudioBusBox => {
        if (!(target instanceof Facade) || !(target.box instanceof AudioUnitBox)) {
            return panic(new TypeError("Send target must be an auxiliary or group unit"))
        }
        const unitBox = target.box
        if (unitBox.type.getValue() !== "aux" && unitBox.type.getValue() !== "bus") {
            return panic(new TypeError(`Send target must be an auxiliary or group unit, got ${unitBox.type.getValue()}`))
        }
        return asInstanceOf(unitBox.input.pointerHub.incoming().map(({box}) => box).find(box => box instanceof AudioBusBox), AudioBusBox)
    }
}
