import {MarkerBox, MarkerTrack} from "@opendaw/studio-boxes"
import {ppqn} from "@opendaw/lib-dsp"
import {asInstanceOf, int, UUID} from "@opendaw/lib-std"
import {Marker, MarkerProps} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"

export class MarkerImpl extends Facade<MarkerBox> implements Marker {
    static wrap(context: Context, box: MarkerBox): MarkerImpl {
        return context.facade(box, () => new MarkerImpl(context, box))
    }

    declare position: ppqn
    declare label: string
    declare hue: int
    declare plays: int

    private constructor(context: Context, box: MarkerBox) {
        super(context, box)
        this.bind({position: box.position, label: box.label, hue: box.hue, plays: box.plays})
    }
}

export namespace Markers {
    export const list = (context: Context, track: MarkerTrack): ReadonlyArray<MarkerImpl> =>
        track.markers.pointerHub.incoming()
            .map(({box}) => MarkerImpl.wrap(context, asInstanceOf(box, MarkerBox)))
            .sort((a, b) => a.position - b.position)

    export const create = (context: Context, track: MarkerTrack, props?: MarkerProps): MarkerImpl =>
        context.edit(() => {
            const count = track.markers.pointerHub.incoming().length
            const box = MarkerBox.create(context.boxGraph, UUID.generate(), box => {
                box.label.setValue(`Marker ${count + 1}`)
                box.hue.setValue(190)
                box.track.refer(track.markers)
            })
            return Props.apply(MarkerImpl.wrap(context, box), props)
        })
}
