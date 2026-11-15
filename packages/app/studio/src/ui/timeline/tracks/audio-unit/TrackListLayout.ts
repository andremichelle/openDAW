import {AudioUnitLayout} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Arrays, isDefined, Optional} from "@opendaw/lib-std"

export class TrackListLayout<CONTENT> {
    readonly rows: ReadonlyArray<TrackListLayout.Row<CONTENT>>
    readonly units: ReadonlyArray<TrackListLayout.Unit>
    readonly boundaries: ReadonlyArray<AudioUnitLayout.Boundary>

    constructor(channels: AudioUnitLayout,
                contents: ReadonlyMap<AudioUnitBox, TrackListLayout.Channel<CONTENT>>,
                tail: ReadonlyArray<CONTENT> = Arrays.empty()) {
        const rows: Array<TrackListLayout.Row<CONTENT>> = []
        const units: Array<TrackListLayout.Unit> = []
        const offsets: Array<number> = []
        channels.visibleRows.forEach(channel => {
            offsets.push(rows.length)
            const content = contents.get(channel.unit)
            const start = rows.length
            content?.lanes.forEach(lane => {
                if (lane.automation && (content.automationCollapsed || channel.isGroup && channel.collapsed)) {return}
                rows.push({content: lane.content, index: rows.length, unit: channel.unit, depth: channel.depth, indent: channel.indent})
            })
            if (rows.length > start) {
                units.push({unit: channel.unit, start, end: rows.length, depth: channel.depth, indent: channel.indent})
            }
        })
        offsets.push(rows.length)
        this.boundaries = channels.boundaries.flatMap(boundary => {
            const start = offsets[boundary.start]
            const end = offsets[boundary.end]
            return isDefined(start) && isDefined(end) && end > start ? [{...boundary, start, end}] : []
        })
        tail.forEach(content => rows.push({content, index: rows.length, unit: undefined, depth: 0, indent: 0}))
        this.rows = rows
        this.units = units
    }
}

export namespace TrackListLayout {
    export type Lane<CONTENT> = {readonly content: CONTENT, readonly automation: boolean}
    export type Channel<CONTENT> = {
        readonly unit: AudioUnitBox
        readonly automationCollapsed: boolean
        readonly lanes: ReadonlyArray<Lane<CONTENT>>
    }
    export type Row<CONTENT> = {
        readonly content: CONTENT
        readonly index: number
        readonly unit: Optional<AudioUnitBox>
        readonly depth: number
        readonly indent: number
    }
    export type Unit = AudioUnitLayout.Boundary
}
