import {Svg} from "@moises-ai/lib-dom"
import {gainToDb} from "@moises-ai/lib-dsp"
import {clamp, int, ObservableValue, Point, unitValue, ValueMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"

export namespace VUMeter {
    export interface Design {
        width: int
        height: int
        fontFamily: string
        fontWeight: int
        backgroundColor: string
        needle: SVGElement
        background: SVGElement
        anchor: Point
        geometry: Geometry
    }

    type Construct = { design: Design, model: ObservableValue<unitValue> }

    const getGoogleFontUrl = (fontFamily: string, fontWeight: number) =>
        `url("https://fonts.googleapis.com/css?family=${fontFamily.replace(" ", "+")}:${fontWeight}")`

    export const Element = ({
                                design:
                                    {
                                        width,
                                        height,
                                        backgroundColor,
                                        background,
                                        needle,
                                        geometry,
                                        anchor,
                                        fontFamily,
                                        fontWeight
                                    },
                                model
                            }: Construct) => {
        const updateNeedle = (gain: number) => needle.setAttribute("transform",
            `translate(${anchor.x}, ${anchor.y + geometry.needleRadius
            }) rotate(${geometry.unitToNeedleDegree(gainToDb(gain))})`)
        model.subscribe(owner => updateNeedle(owner.getValue()))
        updateNeedle(model.getValue())
        return (
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width={width} height={height}
                style={{backgroundColor}}
                text-anchor="middle"
                alignment-baseline="central"
                font-family={fontFamily}>
                <style>{`@import ${(getGoogleFontUrl(fontFamily, fontWeight))};`}</style>
                {background}
                <g style={{filter: "drop-shadow(0px 8px 3px rgba(0, 0, 0, 0.3))"}}>{needle}</g>
            </svg>
        )
    }

    type PaintStyle = { fill?: string, stroke?: string }

    export class Geometry {
        readonly #mapping: ValueMapping<number>
        readonly #needleAnchor: Readonly<Point>
        readonly #needleRadius: number

        readonly #scaleRadius: number
        readonly #scaleRadian: number

        constructor(mapping: ValueMapping<number>, needleRadius: number, width: number, height: number) {
            this.#mapping = mapping
            this.#needleRadius = needleRadius
            this.#scaleRadius = ((width / 2.0) ** 2 + height ** 2) / (2.0 * height)
            this.#scaleRadian = Math.asin(width / (2.0 * this.#scaleRadius))
            this.#needleAnchor = Point.create(0.0, needleRadius)
        }

        get needleRadius(): number {return this.#needleRadius}
        get scaleRadius(): number {return this.#scaleRadius}
        get scaleRadian(): number {return this.#scaleRadian}

        positionToU(position: number, offset: number): number {
            return position + offset / (this.#scaleRadius * this.#scaleRadian * 2.0)
        }

        unitToU(unit: number, offset: number = 0.0): number {return this.positionToU(this.#mapping.x(unit), offset)}

        unitToNeedleDegree(unit: number): number {
            const p = Point.subtract(this.localToGlobal(clamp(this.#mapping.x(unit), 0.0, 1.0), 0.0), this.#needleAnchor)
            return Math.atan2(p.x, -p.y) * 180.0 / Math.PI
        }

        localToGlobal(u: number, v: number): Point {
            const a = this.radianAt(u)
            const p: Point = {
                x: this.#scaleRadius * Math.sin(a),
                y: this.#scaleRadius * (1.0 - Math.cos(a))
            }
            return v === 0.0 ? p : Point.add(p, Point.scaleTo(Point.subtract(p, this.#needleAnchor), v))
        }

        radianAt(x: number): number {return x * this.#scaleRadian * 2.0 - this.#scaleRadian}

        degAt(x: number): number {return this.radianAt(x) * 180.0 / Math.PI}

        buildStripe(style: PaintStyle): StripeBuilder {return new StripeBuilder(this, style)}

        buildLabel(u: number,
                   text: string,
                   distance: number,
                   size: number,
                   angle: number,
                   {fill, stroke}: PaintStyle = {}): SVGTextElement {
            const p0 = this.localToGlobal(u, 0.0)
            const p1 = Point.add(p0, Point.scaleTo(Point.subtract(p0, this.#needleAnchor), distance))
            return (
                <text font-size={`${size}px`} fill={fill ?? "none"} stroke={stroke ?? "none"}
                      transform={`translate(${p1.x}, ${p1.y}) rotate(${angle})`}>{text}</text>
            )
        }
    }

    type Marker = {
        readonly u0: number
        readonly u1: number
        readonly length: number
    }

    class StripeBuilder {
        readonly #geometry: Geometry
        readonly #style: PaintStyle
        readonly #pathBuilder: Svg.PathBuilder = Svg.pathBuilder()
        readonly #markers: Marker[] = []

        #u0: number = 0.0
        #u1: number = 1.0
        #v0: number = 0.0
        #v1: number = 1.0
        #pen: number = 0.0

        constructor(geometry: Geometry, style: PaintStyle) {
            this.#geometry = geometry
            this.#style = style
        }

        setSection(u0: number, u1: number, v0: number, v1: number): this {
            this.#u0 = u0
            this.#u1 = u1
            this.#v0 = v0
            this.#v1 = v1
            return this
        }

        addMarker(u0: number, u1: number, length: number): this {
            this.#markers.push({u0, u1, length})
            return this
        }

        addMarkerAt(unit: number, width: number, length: number, align: "start" | "center" | "end" = "center"): this {
            if (align === "start") {
                this.addMarker(this.#geometry.unitToU(unit, 0.0), this.#geometry.unitToU(unit, width), length)
            } else if (align === "center") {
                this.addMarker(this.#geometry.unitToU(unit, -width / 2.0), this.#geometry.unitToU(unit, width / 2.0), length)
            } else if (align === "end") {
                this.addMarker(this.#geometry.unitToU(unit, -width), this.#geometry.unitToU(unit, 0.0), length)
            }
            return this
        }

        build(): SVGPathElement {
            const markers = this.#markers
            const u0 = markers?.reduce((x, marker) => Math.min(x, marker.u0), this.#u0) ?? this.#u0
            const u1 = markers?.reduce((x, marker) => Math.max(x, marker.u1), this.#u1) ?? this.#u1
            this.#moveTo(u0, this.#v1)
            if (markers === undefined || markers.length === 0) {
                this.#bendTo(u1, this.#v1, true)
                this.#lineTo(u1, this.#v0)
                this.#bendTo(u0, this.#v0, false)
                const {fill, stroke} = this.#style
                return <path d={this.#pathBuilder.close().get()} fill={fill ?? "none"} stroke={stroke ?? "none"}/>
            }
            for (const marker of markers.filter(marker => marker.length > 0.0).sort((a, b) => a.u0 - b.u0)) {
                if (this.#pen < marker.u0) {
                    this.#bendTo(marker.u0, this.#v1, true)
                }
                this.#lineTo(marker.u0, this.#v1 + marker.length)
                this.#bendTo(marker.u1, this.#v1 + marker.length, true)
                this.#lineTo(marker.u1, this.#v1)
            }
            if (this.#pen < u1) {this.#bendTo(u1, this.#v1, true)}
            this.#lineTo(u1, this.#v0)
            for (const marker of markers.filter(marker => marker.length < 0.0).sort((a, b) => b.u0 - a.u0)) {
                if (this.#pen > marker.u1) {
                    this.#bendTo(marker.u1, this.#v0, false)
                }
                this.#lineTo(marker.u1, this.#v0 + marker.length)
                this.#bendTo(marker.u0, this.#v0 + marker.length, false)
                this.#lineTo(marker.u0, this.#v0)
            }
            if (this.#pen > u0) {this.#bendTo(u0, this.#v0, false)}
            const {fill, stroke} = this.#style
            return <path d={this.#pathBuilder.close().get()} fill={fill ?? "none"} stroke={stroke ?? "none"}/>
        }

        #moveTo(u: number, v: number): void {
            const {x, y} = this.#geometry.localToGlobal(u, v)
            this.#pathBuilder.moveTo(x, y)
            this.#pen = u
        }

        #lineTo(u: number, v: number): void {
            const {x, y} = this.#geometry.localToGlobal(u, v)
            this.#pathBuilder.lineTo(x, y)
            this.#pen = u
        }

        #bendTo(u: number, v: number, sweep: boolean): void {
            const {x, y} = this.#geometry.localToGlobal(u, v)
            const r = this.#geometry.scaleRadius + v
            this.#pathBuilder.arc(r, r, 0.0, false, sweep, x, y)
            this.#pen = u
        }
    }
}