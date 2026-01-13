import {asInstanceOf} from "@moises-ai/lib-std"
import {AudioUnitBox, RootBox} from "@moises-ai/studio-boxes"
import {StringField} from "@moises-ai/lib-box"

export namespace ProjectQueries {
    export const existingInstrumentNames = (rootBox: RootBox) => rootBox.audioUnits.pointerHub.incoming().map(({box}) => {
        const incoming = asInstanceOf(box, AudioUnitBox).input.pointerHub.incoming().at(0)
        if (incoming === undefined) {return "N/A"}
        const inputBox = incoming.box
        return "label" in inputBox && inputBox.label instanceof StringField ? inputBox.label.getValue() : "N/A"
    })
}