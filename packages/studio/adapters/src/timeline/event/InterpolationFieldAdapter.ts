import {Pointers} from "@opendaw/studio-enums"
import {Int32Field, PrimitiveType} from "@opendaw/lib-box"
import {Interpolation} from "@opendaw/lib-dsp"
import {ValueEventCurveBox} from "@opendaw/studio-boxes"
import {assertInstanceOf, isDefined, panic, UUID} from "@opendaw/lib-std"

export namespace InterpolationFieldAdapter {
    export type Plain = typeof Interpolation.None | typeof Interpolation.Linear

    export const map = (type: PrimitiveType): Plain =>
        type === PrimitiveType.Int32 || type === PrimitiveType.Boolean ? Interpolation.None : Interpolation.Linear

    export const write = (field: Int32Field<Pointers.ValueInterpolation>, value: Interpolation): void => {
        if (value.type === "none") {
            field.disconnect()
            field.setValue(0)
        } else if (value.type === "linear") {
            field.disconnect()
            field.setValue(1)
        } else if (value.type === "curve") {
            field.setValue(0)
            const curveBox = field.pointerHub.filter(Pointers.ValueInterpolation).at(0)?.box
            if (isDefined(curveBox)) {
                assertInstanceOf(curveBox, ValueEventCurveBox)
                curveBox.slope.setValue(value.slope)
            } else {
                ValueEventCurveBox.create(field.box.graph, UUID.generate(), box => {
                    box.slope.setValue(value.slope)
                    box.event.refer(field)
                })
            }
        }
    }

    export const read = (field: Int32Field<Pointers.ValueInterpolation>): Interpolation => {
        const curveBox = field.pointerHub.incoming().at(0)?.box
        if (isDefined(curveBox)) {
            assertInstanceOf(curveBox, ValueEventCurveBox)
            return {type: "curve", slope: curveBox.slope.getValue()}
        }
        if (field.getValue() === 0) {
            return Interpolation.None
        } else if (field.getValue() === 1) {
            return Interpolation.Linear
        } else {
            return panic("Unknown Interpolation value")
        }
    }
}