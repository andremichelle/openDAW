import {GrooveShuffleBox} from "@opendaw/studio-boxes"
import {ppqn} from "@opendaw/lib-dsp"
import {unitValue} from "@opendaw/lib-std"
import {GrooveShuffle} from "../Api"
import {Context} from "./Context"
import {Facade} from "./Common"

export class GrooveShuffleImpl extends Facade<GrooveShuffleBox> implements GrooveShuffle {
    static wrap(context: Context, box: GrooveShuffleBox): GrooveShuffleImpl {
        return context.facade(box, () => new GrooveShuffleImpl(context, box))
    }

    declare label: string
    declare amount: unitValue
    declare duration: ppqn

    private constructor(context: Context, box: GrooveShuffleBox) {
        super(context, box)
        this.bind({label: box.label, amount: box.amount, duration: box.duration})
    }
}
