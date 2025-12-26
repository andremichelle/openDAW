import {Arrays, Circle, clamp, Geom, isDefined, Lifecycle, ObservableValue, ValueMapping} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {AudioUnitTracks} from "@opendaw/studio-adapters"
import {deferNextFrame} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"

const tapeVelocity = 13.0 / PPQN.Bar // TapeDeviceEditor speed 4.76 cm/s converted into svg coordinates
const rEmpty = 15
const rFull = 40
const stroke = Colors.dark
const mapping = ValueMapping.linear(rEmpty, rFull)
const reels: ReadonlyArray<Circle> = [{x: 56, y: 44, r: 0}, {x: 152, y: 44, r: 0}]
const pins: ReadonlyArray<Readonly<Circle>> = [{x: 8, y: 104, r: 6}, {x: 200, y: 104, r: 6}]
const tapePath = [reels[0], pins[0], pins[1], reels[1]]
const tapeReelHub = (): SVGPathElement => (
    <g>
        <line x1={+mapping.y(0.4)} x2={+mapping.y(0.6)} stroke="rgba(255, 255, 255, 0.125)"
              stroke-width={4}
              stroke-linecap="round"/>
        <line x1={-mapping.y(0.4)} x2={-mapping.y(0.6)} stroke="rgba(255, 255, 255, 0.125)"
              stroke-width={4}
              stroke-linecap="round"/>
        <path fill="none" stroke={Colors.green} transform="translate(-10.4 -11.979)"
              d="M4.75,17.657C2.414,18.046 0.202,18.32 0.017,18C-0.167,17.68 1.168,15.91 2.669,14.086C2.486,13.415 2.388,12.708 2.388,11.979C2.388,8.263 4.922,5.135 8.355,4.23C9.182,2.028 10.042,0 10.409,0C10.778,0 11.64,2.031 12.467,4.236C15.889,5.148 18.413,8.271 18.413,11.979C18.413,12.702 18.317,13.404 18.136,14.07C19.642,15.9 20.986,17.68 20.802,18C20.616,18.321 18.395,18.046 16.053,17.655C14.604,19.098 12.605,19.991 10.4,19.991C8.196,19.991 6.199,19.099 4.75,17.657Z"/>
    </g>
)

export type Construct = {
    lifecycle: Lifecycle
    position: ObservableValue<ppqn>
    durationInPulses: ObservableValue<ppqn>
    tracks: AudioUnitTracks
}

export const Tape = ({lifecycle, position, durationInPulses, tracks}: Construct) => {
    const reelHubs: ReadonlyArray<SVGGraphicsElement> = [tapeReelHub(), tapeReelHub()]
    const reelElements: ReadonlyArray<SVGCircleElement> = reels.map(reel =>
        (<circle cx={reel.x} cy={reel.y} r={0} fill="rgba(0,0,0,0.08)" stroke={stroke}/>))
    const head: SVGElement = (
        <rect x={100} y={106} width={8} height={2} stroke="none"/>
    )
    const tape: ReadonlyArray<SVGLineElement> = Arrays.create(() => <line stroke={stroke}/>, 3)
    const headerUpdater = deferNextFrame(() => {
        const ppqn = position.getValue()
        const playingRegion = tracks.collection.adapters().some(track => {
            const region = track.regions.collection.lowerEqual(ppqn)
            return isDefined(region) && region.hasCollection && region.complete > ppqn
        })
        head.setAttribute("fill", playingRegion ? Colors.bright.toString() : Colors.dark.toString())
    })

    const angles = [0.0, 0.0]

    let lastTime = 0.0
    let delta = 0.0
    const observer = (owner: ObservableValue<number>) => {
        const position = owner.getValue()
        const total = durationInPulses.getValue()
        const elapsed = position - lastTime
        delta += elapsed
        const ratio = clamp(delta / total, 0.0, 1.0)
        const ratios = [1.0 - ratio, ratio]
        for (let i = 0; i < 2; i++) {
            const reel = reels[i]
            const radius = mapping.y(ratios[i])
            angles[i] += (elapsed * 360) * (tapeVelocity / radius)
            reelHubs[i].setAttribute("transform", `translate(${reel.x}, ${reel.y}) rotate(${-angles[i] + i * 60.0})`)
            reelElements[i].r.baseVal.value = reel.r = radius
        }
        for (let i = 0; i < tapePath.length - 1; i++) {
            const [a, b] = Geom.outerTangentPoints(tapePath[i], tapePath[i + 1])
            const {x1, y1, x2, y2} = tape[i]
            x1.baseVal.value = a.x
            y1.baseVal.value = a.y
            x2.baseVal.value = b.x
            y2.baseVal.value = b.y
        }
        headerUpdater.immediate()
        lastTime = position
    }
    lifecycle.own(position.catchupAndSubscribe(observer))
    lifecycle.own(tracks.subscribeAnyChange(headerUpdater.request))
    return (
        <svg classList="tape" viewBox="0 0 208 112"
             width={208}
             height={112}>
            {reels.map(reel => (
                <Frag>
                    <circle cx={reel.x} cy={reel.y} r={(rEmpty + rFull) >> 1}
                            fill="none"
                            stroke="hsl(200, 9%, 20%)"
                            stroke-width={rFull - rEmpty}/>
                    <circle cx={reel.x} cy={reel.y} r={rEmpty - 1} fill="none" stroke={Colors.blue}/>
                </Frag>
            ))}
            {reelElements}
            {reelHubs}
            {pins.map(({x, y, r}) => (<circle cx={x} cy={y} r={r} fill="none" stroke={stroke}/>))}
            {head}
            {tape}
        </svg>
    )
}