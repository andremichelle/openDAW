import css from "./TapTempo.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "TapTempo")

const RING_K = 32
const PHASE_GAIN = 1.0
const BEND_MAX_RATIO = 0.03
const BEND_DECAY_BEATS = 0.5
const OUTLIER_FRAC = 0.35
const DEBOUNCE_MS = 80
const GAP_MAX_MS = 4000
const WRITE_EPS_BPM = 0.01
const START_TAPS_NEEDED = 5
const BOOTSTRAP_MIN_MS = 250
const BOOTSTRAP_MAX_MS = 2000
const BPM_MIN = 30
const BPM_MAX = 300
const NOTCH_BEND_BPM = 1.0
const BPM_NUDGE_STEP = 0.01
const BPM_NUDGE_STEP_SHIFT = 0.1

const TAP_RADIUS = 80
const SEG_INNER = 88
const SEG_OUTER = 106
const SEG_HALF_DEG = 30
const SEG_CORNER_R = 3

const buildSegmentPath = (centerDeg: number, halfDeg: number, rInner: number, rOuter: number, cornerR: number): string => {
    const toRad = (deg: number) => deg * Math.PI / 180
    const a1 = toRad(centerDeg - halfDeg)
    const a2 = toRad(centerDeg + halfDeg)
    const dInner = cornerR / rInner
    const dOuter = cornerR / rOuter
    const fmt = (value: number) => value.toFixed(3)
    const p = (radius: number, angle: number): string =>
        `${fmt(radius * Math.cos(angle))} ${fmt(radius * Math.sin(angle))}`
    return `M ${p(rOuter - cornerR, a1)} ` +
        `L ${p(rInner + cornerR, a1)} ` +
        `Q ${p(rInner, a1)} ${p(rInner, a1 + dInner)} ` +
        `A ${rInner} ${rInner} 0 0 1 ${p(rInner, a2 - dInner)} ` +
        `Q ${p(rInner, a2)} ${p(rInner + cornerR, a2)} ` +
        `L ${p(rOuter - cornerR, a2)} ` +
        `Q ${p(rOuter, a2)} ${p(rOuter, a2 - dOuter)} ` +
        `A ${rOuter} ${rOuter} 0 0 0 ${p(rOuter, a1 + dOuter)} ` +
        `Q ${p(rOuter, a1)} ${p(rOuter - cornerR, a1)} ` +
        `Z`
}

const SEG_UP = buildSegmentPath(-90, SEG_HALF_DEG, SEG_INNER, SEG_OUTER, SEG_CORNER_R)
const SEG_RIGHT = buildSegmentPath(0, SEG_HALF_DEG, SEG_INNER, SEG_OUTER, SEG_CORNER_R)
const SEG_DOWN = buildSegmentPath(90, SEG_HALF_DEG, SEG_INNER, SEG_OUTER, SEG_CORNER_R)
const SEG_LEFT = buildSegmentPath(180, SEG_HALF_DEG, SEG_INNER, SEG_OUTER, SEG_CORNER_R)

type TapEntry = {t: number, n: number}
type TapState = "idle" | "measuring" | "running"

class TapEstimator {
    readonly #buffer: Array<TapEntry> = []
    #period: number = 0
    #t0: number = 0

    get period(): number {return this.#period}
    get t0(): number {return this.#t0}
    get hasFit(): boolean {return this.#period > 0}
    get bpm(): number {return this.#period > 0 ? 60000 / this.#period : 0}

    addTap(tapTime: number): {residual: number, reAnchored: boolean} {
        if (this.#buffer.length === 0) {
            this.#anchor(tapTime)
            return {residual: 0, reAnchored: true}
        }
        if (this.#period <= 0) {
            const prev = this.#buffer[this.#buffer.length - 1]
            const interval = tapTime - prev.t
            if (interval < BOOTSTRAP_MIN_MS || interval > BOOTSTRAP_MAX_MS) {
                this.#anchor(tapTime)
                return {residual: 0, reAnchored: true}
            }
            this.#period = interval
            this.#t0 = prev.t
            this.#buffer.push({t: tapTime, n: 1})
            return {residual: 0, reAnchored: false}
        }
        const predicted = (tapTime - this.#t0) / this.#period
        const beatIndex = Math.round(predicted)
        const residual = predicted - beatIndex
        if (Math.abs(residual) > OUTLIER_FRAC) {
            this.#anchor(tapTime)
            return {residual, reAnchored: true}
        }
        this.#buffer.push({t: tapTime, n: beatIndex})
        if (this.#buffer.length > RING_K) {this.#buffer.shift()}
        this.#refit()
        return {residual, reAnchored: false}
    }

    reset(): void {
        this.#buffer.length = 0
        this.#period = 0
        this.#t0 = 0
    }

    anchorKeepingPeriod(tapTime: number): void {
        this.#buffer.length = 0
        this.#buffer.push({t: tapTime, n: 0})
        this.#t0 = tapTime
    }

    #anchor(tapTime: number): void {
        this.#buffer.length = 0
        this.#buffer.push({t: tapTime, n: 0})
        this.#t0 = tapTime
    }

    #refit(): void {
        const points = this.#buffer
        const count = points.length
        if (count < 2) {return}
        let sumT = 0
        let sumN = 0
        for (const {t, n} of points) {sumT += t; sumN += n}
        const meanT = sumT / count
        const meanN = sumN / count
        let num = 0
        let den = 0
        for (const {t, n} of points) {
            const dn = n - meanN
            num += dn * (t - meanT)
            den += dn * dn
        }
        if (den > 0) {
            this.#period = num / den
            this.#t0 = meanT - this.#period * meanN
        }
    }
}

const renderTapTempo = (lifecycle: Lifecycle, service: StudioService): HTMLElement => {
    const optProject = service.optProject
    if (optProject.isEmpty()) {
        return (
            <div className={className}>
                <p className="hint">Open a project first.</p>
            </div>
        )
    }
    const project = optProject.unwrap()
    const engine = service.engine
    const estimator = new TapEstimator()
    const state = new DefaultObservableValue<TapState>("idle")
    const tapCountObs = new DefaultObservableValue<number>(0)
    const displayBpm = new DefaultObservableValue<number>(project.timelineBox.bpm.getValue())
    let lastTapTime = 0
    let baseBpm = 0
    let bend = 0
    let notchBend = 0
    let lastWrittenBpm = -1
    let lastFrameTime = 0
    const writeBpm = (value: number) => {
        if (Math.abs(value - lastWrittenBpm) < WRITE_EPS_BPM) {return}
        project.editing.modify(() => project.timelineBox.bpm.setValue(value), false)
        lastWrittenBpm = value
    }
    const reset = () => {
        engine.stop()
        estimator.reset()
        lastTapTime = 0
        baseBpm = 0
        bend = 0
        notchBend = 0
        lastFrameTime = 0
        state.setValue("idle")
        tapCountObs.setValue(0)
        displayBpm.setValue(project.timelineBox.bpm.getValue())
    }
    const handleTap = (tapTime: number) => {
        if (lastTapTime !== 0 && tapTime - lastTapTime < DEBOUNCE_MS) {return}
        if (lastTapTime !== 0 && tapTime - lastTapTime > GAP_MAX_MS) {estimator.reset()}
        lastTapTime = tapTime
        estimator.addTap(tapTime)
        const newCount = tapCountObs.getValue() + 1
        tapCountObs.setValue(newCount)
        if (state.getValue() === "running") {
            if (!estimator.hasFit) {return}
            baseBpm = Math.max(BPM_MIN, Math.min(BPM_MAX, estimator.bpm))
            const actualBeats = engine.position.getValue() / PPQN.Quarter
            const beatLabel = Math.round(actualBeats)
            const phaseErrBeats = beatLabel - actualBeats
            const bendMax = BEND_MAX_RATIO * baseBpm
            bend = Math.max(-bendMax, Math.min(bendMax, PHASE_GAIN * phaseErrBeats * baseBpm))
            const effective = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + bend + notchBend))
            writeBpm(effective)
            displayBpm.setValue(effective)
            return
        }
        if (newCount < START_TAPS_NEEDED) {
            state.setValue("measuring")
            if (estimator.hasFit) {displayBpm.setValue(estimator.bpm)}
            return
        }
        const initialBpm = estimator.hasFit ? estimator.bpm : 120
        baseBpm = Math.max(BPM_MIN, Math.min(BPM_MAX, initialBpm))
        bend = 0
        lastFrameTime = 0
        estimator.anchorKeepingPeriod(tapTime)
        writeBpm(baseBpm)
        displayBpm.setValue(baseBpm)
        service.audioContext.resume().catch(() => {})
        engine.setPosition(0)
        engine.play()
        state.setValue("running")
    }
    const animationFrameSub = AnimationFrame.add(() => {
        if (state.getValue() !== "running" || baseBpm <= 0) {return}
        if (Math.abs(bend) < WRITE_EPS_BPM) {
            if (lastFrameTime !== 0) {lastFrameTime = 0}
            return
        }
        const now = performance.now()
        const dt = lastFrameTime === 0 ? 16 : (now - lastFrameTime)
        lastFrameTime = now
        const beatMs = 60000 / baseBpm
        const tauMs = BEND_DECAY_BEATS * beatMs
        bend *= Math.exp(-dt / tauMs)
        if (Math.abs(bend) < WRITE_EPS_BPM) {bend = 0}
        const effective = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + bend + notchBend))
        writeBpm(effective)
        displayBpm.setValue(effective)
    })
    const setNotch = (direction: number) => {
        if (state.getValue() !== "running" || baseBpm <= 0) {return}
        notchBend = direction * NOTCH_BEND_BPM
        const effective = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + bend + notchBend))
        writeBpm(effective)
        displayBpm.setValue(effective)
    }
    const clearNotch = () => {
        if (notchBend === 0) {return}
        notchBend = 0
        const effective = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + bend))
        writeBpm(effective)
        displayBpm.setValue(effective)
    }
    const nudgeBpm = (step: number) => {
        if (baseBpm <= 0) {return}
        baseBpm = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + step))
        const effective = Math.max(BPM_MIN, Math.min(BPM_MAX, baseBpm + bend + notchBend))
        writeBpm(effective)
        displayBpm.setValue(effective)
    }
    const hexElement: SVGCircleElement = (
        <circle classList="hex" cx="0" cy="0" r={TAP_RADIUS.toString()}
                onpointerdown={(event: PointerEvent) => {
                    event.preventDefault()
                    handleTap(event.timeStamp)
                }}/>
    )
    const upCircle: SVGPathElement = (
        <path classList="arrow up" d={SEG_UP}
              onpointerdown={(event: PointerEvent) => {
                  event.preventDefault()
                  nudgeBpm(event.shiftKey ? +BPM_NUDGE_STEP_SHIFT : +BPM_NUDGE_STEP)
              }}/>
    )
    const downCircle: SVGPathElement = (
        <path classList="arrow down" d={SEG_DOWN}
              onpointerdown={(event: PointerEvent) => {
                  event.preventDefault()
                  nudgeBpm(event.shiftKey ? -BPM_NUDGE_STEP_SHIFT : -BPM_NUDGE_STEP)
              }}/>
    )
    const leftCircle: SVGPathElement = (
        <path classList="arrow left" d={SEG_LEFT}
              onpointerdown={(event: PointerEvent) => {event.preventDefault(); setNotch(-1)}}/>
    )
    const rightCircle: SVGPathElement = (
        <path classList="arrow right" d={SEG_RIGHT}
              onpointerdown={(event: PointerEvent) => {event.preventDefault(); setNotch(+1)}}/>
    )
    const segMid = ((SEG_INNER + SEG_OUTER) / 2).toString()
    const segMidNeg = (-(SEG_INNER + SEG_OUTER) / 2).toString()
    const tapButton: SVGSVGElement = (
        <svg classList="tap-svg" viewBox="-125 -125 250 250" preserveAspectRatio="xMidYMid meet">
            <text classList="axis-label" x="0" y="-118">bpm</text>
            <text classList="axis-label axis-end" x="-118" y="0">notch</text>
            {hexElement}
            <text classList="hex-label" x="0" y="-6">TAP</text>
            <text classList="hex-shortcut" x="0" y="14">SPACE</text>
            {upCircle}
            <text classList="circle-sign" x="0" y={segMidNeg}>+</text>
            {downCircle}
            <text classList="circle-sign" x="0" y={segMid}>−</text>
            {leftCircle}
            <text classList="circle-sign" x={segMidNeg} y="0">−</text>
            {rightCircle}
            <text classList="circle-sign" x={segMid} y="0">+</text>
        </svg>
    )
    const bpmReadout: HTMLElement = <span className="bpm-value">--</span>
    const stateReadout: HTMLElement = <span className="state-value">tap to begin</span>
    const countReadout: HTMLElement = <span className="count-value">0 taps</span>
    const resetButton: HTMLElement = (
        <button className="reset" type="button"
                onclick={() => {reset(); root.focus()}}>
            RESET<span className="hotkey">ESC</span>
        </button>
    )
    const onKeyDown = (event: KeyboardEvent) => {
        const code = event.code
        if (code === "Space") {
            if (event.repeat) {return}
            event.preventDefault()
            event.stopPropagation()
            hexElement.classList.add("pressed")
            handleTap(event.timeStamp)
            return
        }
        if (code === "ArrowLeft") {
            event.preventDefault()
            event.stopPropagation()
            leftCircle.classList.add("pressed")
            setNotch(-1)
            return
        }
        if (code === "ArrowRight") {
            event.preventDefault()
            event.stopPropagation()
            rightCircle.classList.add("pressed")
            setNotch(+1)
            return
        }
        if (code === "ArrowUp") {
            event.preventDefault()
            event.stopPropagation()
            upCircle.classList.add("pressed")
            nudgeBpm(event.shiftKey ? +BPM_NUDGE_STEP_SHIFT : +BPM_NUDGE_STEP)
            return
        }
        if (code === "ArrowDown") {
            event.preventDefault()
            event.stopPropagation()
            downCircle.classList.add("pressed")
            nudgeBpm(event.shiftKey ? -BPM_NUDGE_STEP_SHIFT : -BPM_NUDGE_STEP)
            return
        }
        if (code === "Escape") {
            if (event.repeat) {return}
            event.preventDefault()
            event.stopPropagation()
            resetButton.classList.add("pressed")
            reset()
            return
        }
    }
    const root: HTMLElement = (
        <div className={className} tabIndex={0}>
            <p className="help">
                Tap the beat at least 5 times to lock onto the tempo and start playback.
                Keep tapping to stay in sync. Use the arrows to fine-tune. ESC to reset.
            </p>
            <div className="content">
                <div className="balancer"/>
                {tapButton}
                <div className="readout">
                    <div className="line bpm-line">{bpmReadout}<span className="unit">BPM</span></div>
                    <div className="line">{stateReadout}</div>
                    <div className="line">{countReadout}</div>
                    <div className="line">{resetButton}</div>
                </div>
            </div>
        </div>
    )
    const refocus = () => {
        if (document.activeElement !== root) {root.focus()}
    }
    const onKeyUp = (event: KeyboardEvent) => {
        const code = event.code
        if (code === "Space") {hexElement.classList.remove("pressed"); return}
        if (code === "ArrowLeft") {leftCircle.classList.remove("pressed"); clearNotch(); return}
        if (code === "ArrowRight") {rightCircle.classList.remove("pressed"); clearNotch(); return}
        if (code === "ArrowUp") {upCircle.classList.remove("pressed"); return}
        if (code === "ArrowDown") {downCircle.classList.remove("pressed"); return}
        if (code === "Escape") {resetButton.classList.remove("pressed"); return}
    }
    lifecycle.ownAll(
        animationFrameSub,
        Events.subscribe(window, "keydown", onKeyDown, true),
        Events.subscribe(window, "keyup", onKeyUp, true),
        Events.subscribe(window, "pointerup", clearNotch),
        Events.subscribe(root, "pointerup", () => queueMicrotask(refocus)),
        displayBpm.catchupAndSubscribe(owner => {
            const value = owner.getValue()
            bpmReadout.textContent = value > 0 ? value.toFixed(2) : "--"
        }),
        state.catchupAndSubscribe(owner => {
            const value = owner.getValue()
            if (value === "idle") {stateReadout.textContent = "tap to begin"}
            else if (value === "measuring") {stateReadout.textContent = "keep tapping..."}
            else {stateReadout.textContent = "running"}
        }),
        tapCountObs.catchupAndSubscribe(owner => {
            const value = owner.getValue()
            countReadout.textContent = value === 1 ? "1 tap" : `${value} taps`
        })
    )
    queueMicrotask(refocus)
    return root
}

export const TapTempo = ({lifecycle, service}: {lifecycle: Lifecycle, service: StudioService}) =>
    renderTapTempo(lifecycle, service)
