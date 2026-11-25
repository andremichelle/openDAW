import {Capture, CaptureAudio, ChannelMapping, MenuItem} from "@opendaw/studio-core"
import {Arrays, Editing, Func, isInstanceOf, Option, Procedure} from "@opendaw/lib-std"

export namespace MenuChannelMapping {
    export const createItem = (captureOption: Option<Capture>,
                               editing: Editing,
                               guarded: Func<Procedure<MenuItem>, Procedure<MenuItem>>) => {
        const optCapture: Option<CaptureAudio> = captureOption
            .flatMap(capture => isInstanceOf(capture, CaptureAudio) ? Option.wrap(capture) : Option.None)
        return MenuItem.default({
            label: "Channel Mapping",
            hidden: optCapture.isEmpty()
        }).setRuntimeChildrenProcedure(parent => {
            if (optCapture.isEmpty()) {return}
            const capture = optCapture.unwrap()
            const current = capture.channelMapping
            const delivered = capture.streamMediaTrack.mapOr(track => track.getSettings().channelCount ?? 2, 2)
            const inputs = Math.min(Math.max(2, delivered, ChannelMapping.inputCount(current)), ChannelMapping.MaxInputs)
            const createMappingItem = (label: string, mapping: ChannelMapping, separatorBefore: boolean = false) =>
                MenuItem.default({label, checked: ChannelMapping.equals(current, mapping), separatorBefore})
                    .setTriggerProcedure(guarded(() => editing.modify(() => capture.channelMapping = mapping)))
            parent.addMenuItem(
                ...Arrays.create(pair => createMappingItem(
                    `Stereo ${pair * 2 + 1}/${pair * 2 + 2}`, ChannelMapping.stereo(pair * 2)), Math.floor(inputs / 2)),
                createMappingItem("Mono 1+2 Mixed", ChannelMapping.MonoMixed, true),
                ...Arrays.create(index => createMappingItem(`Mono ${index + 1}`, ChannelMapping.mono(index)), inputs))
        })
    }
}
