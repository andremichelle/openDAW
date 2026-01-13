import {
    AudioRegionBox,
    AudioUnitBox,
    BoxVisitor,
    DelayDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    TapeDeviceBox,
    TrackBox
} from "@moises-ai/studio-boxes"
import {Box, PointerField, PointerHub, PrimitiveField, PrimitiveValues, StringField} from "@moises-ai/lib-box"
import {
    Arrays,
    DefaultObservableValue,
    Func,
    isDefined,
    Lifecycle,
    Nullable,
    ObservableValue,
    Option,
    Terminator
} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"

// TODO Is this completely obsolete?
export namespace Extractors {
    export const findLabelField = (box: Box): Option<StringField> =>
        Option.wrap(box.accept<BoxVisitor<StringField>>({
            visitAudioRegionBox: (box: AudioRegionBox): StringField => box.label,
            visitDelayDeviceBox: (box: DelayDeviceBox): StringField => box.label,
            visitReverbDeviceBox: (box: ReverbDeviceBox): StringField => box.label,
            visitRevampDeviceBox: (box: RevampDeviceBox): StringField => box.label,
            visitTapeDeviceBox: (box: TapeDeviceBox): StringField => box.label
        }))

    export const findAudioUnitBox = (box: Box): Nullable<AudioUnitBox> =>
        box.accept<BoxVisitor<Nullable<AudioUnitBox>>>({
            visitAudioUnitBox: (box: AudioUnitBox): Nullable<AudioUnitBox> => box,
            visitAudioRegionBox: (box: AudioRegionBox): Nullable<AudioUnitBox> => {
                const track = box.regions.targetVertex.unwrapOrNull()?.box
                return isDefined(track) ? findAudioUnitBox(track) : null
            },
            visitTrackBox: (box: TrackBox): Nullable<AudioUnitBox> => {
                const audioUnit = box.tracks.targetVertex.unwrapOrNull()?.box
                return isDefined(audioUnit) ? findAudioUnitBox(audioUnit) : null
            }
        }) ?? null

    export const pointedObservable = <T extends PrimitiveValues>(lifecycle: Lifecycle,
                                                                 pointerHub: PointerHub,
                                                                 extractor: Func<Box, Option<PrimitiveField<T>>>,
                                                                 fallback: T): ObservableValue<T> => {
        let target: Option<PrimitiveField<T>> = Option.None

        const wrapper = lifecycle.own(new DefaultObservableValue<T>(fallback))
        const subscriptor = lifecycle.own(new Terminator())
        const watch = (box: Box): void => {
            subscriptor.terminate()
            target = extractor(box)
            target.match({
                none: () => wrapper.setValue(fallback),
                some: field => {
                    subscriptor.own(field.subscribe((owner: ObservableValue<T>) => wrapper.setValue(owner.getValue())))
                    wrapper.setValue(field.getValue())
                }
            })
        }
        const catchup = Arrays.peekFirst(pointerHub.filter(Pointers.InstrumentHost, Pointers.NotesConnection))
        if (isDefined(catchup)) {
            watch(catchup.box)
        }
        lifecycle.own(pointerHub.subscribe({
            onAdded: (pointer: PointerField) => watch(pointer.box),
            onRemoved: (_pointer: PointerField) => {
                subscriptor.terminate()
                target = Option.None
            }
        }, Pointers.InstrumentHost, Pointers.NotesConnection))
        lifecycle.own(wrapper.subscribe(owner => target
            .ifSome(field => field.setValue(owner.getValue()))))
        return wrapper
    }
}