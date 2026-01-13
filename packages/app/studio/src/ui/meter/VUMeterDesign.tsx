import {ObservableValue, Point} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {GainMapping} from "@/ui/meter/mapping.ts"
import {gainToDb} from "@moises-ai/lib-dsp"
import {VUMeter} from "./VUMeter"

export namespace VUMeterDesign {
    export const Default = ({model}: { model: ObservableValue<number> }) => {
        const geometry = new VUMeter.Geometry(new GainMapping(3), 144, 240, 32)
        const anchor: Point = {x: 160, y: 64}
        const color = {black: "hsl(36,23%,28%)", red: "hsl(8,58%,46%)"}
        const needle: SVGLineElement = <line x1={0} x2={0}
                                             y1={0} y2={-geometry.needleRadius - 28}
                                             stroke="hsl(36,25%,30%)" stroke-width={2}/>
        const background: SVGGraphicsElement = (
            <g fill="none" stroke="none" transform={`translate(${anchor.x}, ${anchor.y})`}>
                {
                    geometry.buildStripe({fill: color.black})
                        .setSection(0.0, geometry.unitToU(0.0), 0.0, 8.0)
                        .addMarker(geometry.unitToU(Number.NEGATIVE_INFINITY), geometry.unitToU(-24), 4)
                        .addMarkerAt(-20, 4, 16)
                        .addMarkerAt(-10, 4, 16)
                        .addMarkerAt(-7, 4, 16)
                        .addMarkerAt(-6, 2, 10)
                        .addMarkerAt(-5, 4, 16)
                        .addMarkerAt(-4, 2, 10)
                        .addMarkerAt(-3, 4, 16)
                        .addMarkerAt(-2, 2, 10)
                        .addMarkerAt(-1, 2, 10)
                        .addMarkerAt(0, 4, 16)
                        .build()
                }
                {
                    geometry.buildStripe({fill: color.black})
                        .setSection(0.0, geometry.unitToU(0.0), -8.0, -6.0)
                        .addMarkerAt(gainToDb(1.00), 2, -4)
                        .addMarkerAt(gainToDb(0.75), 2, -4)
                        .addMarkerAt(gainToDb(0.50), 2, -4)
                        .addMarkerAt(gainToDb(0.25), 2, -4)
                        .addMarkerAt(gainToDb(0.00), 2, -4)
                        .build()
                }
                {
                    geometry.buildStripe({fill: color.red})
                        .setSection(geometry.unitToU(0.0, 6.0), geometry.unitToU(3.0), 0.0, 12.0)
                        .addMarkerAt(1, 2, 6)
                        .addMarkerAt(2, 2, 6)
                        .addMarkerAt(3, 4, 12)
                        .build()
                }
                {
                    ...[-20, -10, -7, -5, -3, 0, 3]
                        .map(db => geometry.buildLabel(geometry.unitToU(db), Math.abs(db).toString(), 32, 12,
                            geometry.degAt(geometry.unitToU(db)), {fill: db > 0 ? color.red : color.black}))
                }
                {
                    ...[0, 25, 50, 75, 100]
                        .map(percentage => geometry.buildLabel(geometry.unitToU(gainToDb(percentage / 100.0)),
                            `${percentage}%`, -22, 7, 0.0, {fill: color.black}))
                }
                {
                    geometry.buildLabel(0.5, "VU", -56, 20, 0.0, {fill: color.black})
                }
            </g>
        )

        return (
            <VUMeter.Element design={{
                anchor,
                geometry,
                width: 320,
                height: 176,
                fontFamily: "Open Sans",
                fontWeight: 400,
                backgroundColor: "rgb(227, 208, 156)",
                needle,
                background
            }} model={model}/>
        )
    }

    export const Modern = ({model}: { model: ObservableValue<number> }) => {
        const geometry = new VUMeter.Geometry(new GainMapping(6, 1.5), 144, 256, 24)
        const anchor: Point = {x: 160, y: 64}
        const color = {yellow: "hsl(33,63%,48%)", red: "hsl(6,71%,43%)"}
        const needle: SVGLineElement = <line x1={0} x2={0}
                                             y1={0} y2={-geometry.needleRadius - 32}
                                             stroke="hsl(0,75%,50%)" stroke-width={2}/>
        const background: SVGGraphicsElement = (
            <g fill="none" stroke="none" transform={`translate(${anchor.x}, ${anchor.y})`}>
                {
                    geometry.buildStripe({fill: color.yellow})
                        .setSection(0.0, geometry.unitToU(-0.5), 0.0, 8.0)
                        .addMarker(geometry.unitToU(Number.NEGATIVE_INFINITY), geometry.unitToU(-36), 6)
                        .addMarkerAt(-20, 4, 24)
                        .addMarkerAt(-10, 4, 24)
                        .addMarkerAt(-7, 4, 24)
                        .addMarkerAt(-5, 4, 24)
                        .addMarkerAt(-3, 4, 24)
                        .addMarkerAt(-2, 4, 24)
                        .addMarkerAt(-1, 4, 24)
                        .addMarkerAt(-0.25, 4, 24)
                        .build()
                }
                {
                    geometry.buildStripe({fill: color.red})
                        .setSection(geometry.unitToU(0.25), geometry.unitToU(2.75), 0.0, 8.0)
                        .addMarkerAt(0.25, 4, 24, "start")
                        .build()
                }
                {
                    geometry.buildStripe({fill: color.red})
                        .setSection(geometry.unitToU(3.0), 1.0, 0.0, 8.0)
                        .build()
                }
                {
                    geometry.buildStripe({fill: color.yellow})
                        .setSection(0.0, 1.0, -16.0, -8.0)
                        .build()
                }
                {
                    ...[-20, -10, -7, -5, -3, -2, -1, 0, 3]
                        .map(db => geometry.buildLabel(geometry.unitToU(db), Math.abs(db).toString(),
                            40, 12, 0.0, {fill: db >= 0 ? color.red : color.yellow}))
                }
                {
                    ...[0, 30, 50, 70, 100]
                        .map(percentage => geometry.buildLabel(geometry.unitToU(gainToDb(percentage / 100.0)),
                            percentage === 100 ? "100%" : `${percentage}`, -28, 10, 0.0,
                            {fill: color.yellow}))
                }
                {
                    geometry.buildLabel(0.5, "VU", -64, 24, 0.0, {fill: color.yellow})
                }
            </g>
        )
        return <VUMeter.Element design={{
            anchor,
            geometry,
            width: 320,
            height: 176,
            fontFamily: "Lilita One",
            fontWeight: 400,
            backgroundColor: "rgb(26, 27, 29)",
            needle,
            background
        }} model={model}/>
    }
}