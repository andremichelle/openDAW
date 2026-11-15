import {MenuItem} from "@opendaw/studio-core"
import {ColorCodes, TrackType} from "@opendaw/studio-adapters"
import {Optional, Procedure} from "@opendaw/lib-std"

export namespace ColorMenu {
    const Colors: ReadonlyArray<{ label: string, hue: number }> = [
        {label: "Blue", hue: ColorCodes.forTrackType(TrackType.Audio)},
        {label: "Orange", hue: ColorCodes.forTrackType(TrackType.Notes)},
        {label: "Green", hue: ColorCodes.forTrackType(TrackType.Value)},
        {label: "Red", hue: 8.0},
        {label: "Purple", hue: 322.0},
        {label: "Yellow", hue: 60.0}
    ].sort((a, b) => a.hue - b.hue)

    export const createPalette = (procedure: Procedure<number>, currentHue: Optional<number>) =>
        MenuItem.colorPalette({colors: Colors.map(({label, hue}) => ({
            label, color: `hsl(${hue}, 75%, 55%)`, checked: currentHue === hue,
            select: () => procedure(hue)
        }))})
}