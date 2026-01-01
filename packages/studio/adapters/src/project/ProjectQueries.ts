import {asInstanceOf} from "@opendaw/lib-std"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {StringField} from "@opendaw/lib-box"

export namespace ProjectQueries {
    export const existingInstrumentNames = (rootBox: RootBox) => rootBox.audioUnits.pointerHub.incoming().map(({box}) => {
        const incoming = asInstanceOf(box, AudioUnitBox).input.pointerHub.incoming().at(0)
        if (incoming === undefined) {return "N/A"}
        const inputBox = incoming.box
        return "label" in inputBox && inputBox.label instanceof StringField ? inputBox.label.getValue() : "N/A"
    })
}