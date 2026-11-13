import css from "./SurgeonPreview.sass?inline"
import {Arrays, clamp, int, isDefined, Lifecycle, Notifier, Option, Optional, Procedure} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {CanvasPainter, ContextMenu, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {PreviewDevicePanel} from "@/ui/pages/testing/preview/PreviewDevicePanel"
import {SurgeonAudio} from "@/ui/pages/testing/surgeon/SurgeonAudio"
import {SurgeonControls} from "@/ui/pages/testing/surgeon/SurgeonControls"
import {SurgeonModel} from "@/ui/pages/testing/surgeon/SurgeonModel"

const className = Html.adoptStyleSheet(css, "SurgeonPreview")

type Construct = {
    lifecycle: Lifecycle
    audioContext: AudioContext
}

const Off = -1
const PreviewBpm = 136
const LaneNames = "ABCD"
const LaneColors = [Colors.blue, Colors.green, Colors.yellow, Colors.orange]
const ToneParams: ReadonlyArray<int> = [0, 1, 2, 3, 4, 5, 6, 7]
const ShapeParams: ReadonlyArray<int> = [8, 9, 10, 11, 12, 13, 14, 15]

// a draft of the Surgeon editor: every control works on the pattern model, the real engine core plays it in an
// audio worklet and reports the position the display follows
export const SurgeonPreview = ({lifecycle, audioContext}: Construct) => {
    const {Lanes, PatternCount, Params, Index, Rates, RatePulses, BarPulses, Kind} = SurgeonModel
    const {Prints, Parses, value, choice, control, button} = SurgeonControls
    const patterns: Array<SurgeonModel.Pattern> = Arrays.create(index =>
        index === 0 ? SurgeonModel.favourite() : SurgeonModel.rollAll(SurgeonModel.favourite(), index), PatternCount)
    const refresh = lifecycle.own(new Notifier<void>())
    const state: {
        shown: int, active: int, fired: Optional<int>, playing: boolean, start: number, pulses: number, bar: int,
        tune: number, volume: number, clipboard: Optional<SurgeonModel.Pattern>
    } = {shown: 0, active: 0, fired: undefined, playing: false, start: 0.0, pulses: 0.0, bar: 0, tune: 50.0, volume: 0.0, clipboard: undefined}
    let player: Option<SurgeonAudio.Player> = Option.None
    const sendSound = () => player.ifSome(loaded => {
        patterns.forEach((pattern, index) => loaded.pattern(index, pattern))
        loaded.tune(state.tune)
        loaded.volume(dbToGain(state.volume))
    })
    const current = (): SurgeonModel.Pattern => patterns[state.shown]
    const rollSeed = (): int => Math.floor(Math.random() * 100_000)
    const edit = (action: Procedure<SurgeonModel.Pattern>) => () => {
        action(current())
        refresh.notify()
    }
    const percent = (get: () => number, set: Procedure<number>): SurgeonControls.Field =>
        ({min: 0.0, max: 1.0, step: 0.01, print: Prints.percent, parse: Parses.percent, get, set})
    const whole = (min: int, max: int, get: () => number, set: Procedure<number>): SurgeonControls.Field =>
        ({min, max, step: 1, print: Prints.integer, parse: Parses.plain, get, set})
    const field = (source: SurgeonControls.Field) => value(lifecycle, refresh, source)
    const tiles: ReadonlyArray<HTMLElement> = Arrays.create(index => <div className="tile">{String(index + 1)}</div>, PatternCount)
    const offTile: HTMLElement = <div className="tile off">Off</div>
    const laneColor = (index: int): string => LaneColors[index].toString()
    const updateTiles = () => {
        tiles.forEach((tile, index) => {
            tile.classList.toggle("active", state.active === index)
            tile.classList.toggle("fired", state.fired === index)
        })
        offTile.classList.toggle("active", state.active === Off)
        offTile.classList.toggle("fired", state.fired === Off)
    }
    const takeOver = (slot: int) => {
        state.active = slot
        state.fired = undefined
        if (slot !== Off) {state.shown = slot}
        updateTiles()
        refresh.notify()
    }
    const fire = (slot: int) => {
        player.ifSome(loaded => loaded.fire(slot))
        if (!state.playing) {return takeOver(slot)}
        state.fired = slot === state.active ? undefined : slot
        updateTiles()
    }
    tiles.forEach((tile, index) => lifecycle.ownAll(
        Events.subscribe(tile, "click", () => fire(index)),
        ContextMenu.subscribe(tile, collector => collector.addItems(
            MenuItem.default({label: "Copy pattern"}).setTriggerProcedure(() => state.clipboard = SurgeonModel.copy(patterns[index])),
            MenuItem.default({label: "Paste pattern", selectable: isDefined(state.clipboard)}).setTriggerProcedure(() => {
                if (!isDefined(state.clipboard)) {return}
                patterns[index] = SurgeonModel.copy(state.clipboard)
                refresh.notify()
            })))))
    lifecycle.own(Events.subscribe(offTile, "click", () => fire(Off)))
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight, devicePixelRatio}) => {
        const pattern = current()
        const sounding = state.active !== Off
        const position = Math.max(0, Math.floor(state.pulses / RatePulses[pattern.rate]))
        const thickness = devicePixelRatio * 4
        const pitchBottom = actualHeight * 0.5
        const middle = pitchBottom / 2
        const reach = middle - thickness / 2
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.globalAlpha = sounding ? 1.0 : 0.35
        context.strokeStyle = DisplayPaint.gridStyle(0.3)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2 * devicePixelRatio, 3 * devicePixelRatio])
        context.beginPath()
        context.moveTo(0, middle)
        context.lineTo(actualWidth, middle)
        context.stroke()
        context.setLineDash([])
        const {pitch, lanes} = pattern
        const steps = clamp(pitch.steps, 1, SurgeonModel.MaxSteps)
        const first = Math.floor(position / steps) * steps
        const width = actualWidth / steps
        for (let index = 0; index < steps; index++) {
            const {offset, kind, slide} = SurgeonModel.step(pitch, first + index)
            const playing = state.playing && sounding && index === position % steps
            const x = index * width
            if (kind === Kind.Rest) {
                context.fillStyle = DisplayPaint.gridStyle(playing ? 0.6 : 0.25)
                context.fillRect(x + devicePixelRatio, middle - devicePixelRatio, width - devicePixelRatio * 2, devicePixelRatio * 2)
                continue
            }
            const y = middle - offset / Math.max(pitch.range, 1.0) * reach
            if (slide && first + index > 0) {
                const from = SurgeonModel.step(pitch, first + index - 1)
                if (from.kind !== Kind.Rest) {
                    context.strokeStyle = DisplayPaint.strokeStyle(0.5)
                    context.beginPath()
                    context.moveTo(x - width * 0.5, middle - from.offset / Math.max(pitch.range, 1.0) * reach)
                    context.lineTo(x + devicePixelRatio, y)
                    context.stroke()
                }
            }
            context.fillStyle = playing ? Colors.white.toString() : DisplayPaint.strokeStyle(0.8)
            context.beginPath()
            context.roundRect(x + devicePixelRatio, y - thickness / 2,
                (width - devicePixelRatio * 2) * (kind === Kind.Tie ? 1.0 : 0.5), thickness, thickness / 2)
            context.fill()
        }
        const laneHeight = (actualHeight - pitchBottom) / Lanes
        const letter = devicePixelRatio * 12
        context.font = `${8 * devicePixelRatio}px ${getComputedStyle(canvas).fontFamily}`
        context.textBaseline = "middle"
        lanes.forEach((lane, laneIndex) => {
            const top = pitchBottom + laneIndex * laneHeight
            const count = clamp(lane.steps, 1, SurgeonModel.MaxSteps)
            const start = Math.floor(position / count) * count
            const barWidth = (actualWidth - letter) / count
            const height = laneHeight - devicePixelRatio * 3
            context.fillStyle = LaneColors[laneIndex].toString()
            context.fillText(LaneNames[laneIndex], 0, top + (laneHeight + devicePixelRatio * 3) / 2)
            for (let index = 0; index < count; index++) {
                const amount = SurgeonModel.laneValue(lane, start + index)
                const playing = state.playing && sounding && index === position % count
                context.fillStyle = playing ? Colors.white.toString() : LaneColors[laneIndex].opacity(0.75).toString()
                const filled = Math.max(devicePixelRatio, amount * height)
                const last = index === count - 1
                context.fillRect(letter + index * barWidth, top + laneHeight - filled,
                    Math.max(devicePixelRatio, last ? barWidth : barWidth - devicePixelRatio), filled)
            }
        })
        context.globalAlpha = 1.0
    }))
    const playButton: HTMLElement = <div className="button play">Play</div>
    const status: HTMLElement = <span>{`Loading the engine, ${PreviewBpm} bpm`}</span>
    lifecycle.ownAll(
        refresh.subscribe(painter.requestUpdate),
        refresh.subscribe(sendSound),
        Events.subscribe(playButton, "click", () => {
            state.playing = !state.playing
            state.start = performance.now()
            state.pulses = 0.0
            state.bar = 0
            if (!state.playing && isDefined(state.fired)) {takeOver(state.fired)}
            playButton.textContent = state.playing ? "Stop" : "Play"
            if (state.playing) {audioContext.resume().catch(() => {})}
            player.ifSome(loaded => loaded.play(state.playing))
            painter.requestUpdate()
        }),
        // without the engine the display follows its own clock
        AnimationFrame.add(() => {
            if (!state.playing || player.nonEmpty()) {return}
            state.pulses = (performance.now() - state.start) / 1000.0 * PreviewBpm / 60.0 * 960.0
            const bar = Math.floor(state.pulses / BarPulses)
            if (bar !== state.bar) {
                state.bar = bar
                if (isDefined(state.fired)) {takeOver(state.fired)}
            }
            painter.requestUpdate()
        }),
        {terminate: () => player.ifSome(loaded => loaded.terminate())}
    )
    SurgeonAudio.load(audioContext, PreviewBpm).then(loaded => {
        player = Option.wrap(loaded)
        status.textContent = `Played by the real engine at ${PreviewBpm} bpm`
        sendSound()
        loaded.fire(state.active)
        loaded.play(state.playing)
        lifecycle.own(loaded.subscribe(({pulses, active, fired}) => {
            if (!state.playing) {return}
            state.pulses = pulses
            if (active !== state.active) {takeOver(active)}
            const waiting = fired === SurgeonAudio.NoSlot ? undefined : fired
            if (waiting !== state.fired) {
                state.fired = waiting
                updateTiles()
            }
            painter.requestUpdate()
        }))
    }, reason => status.textContent = `No sound, the engine did not load (${reason instanceof Error ? reason.message : String(reason)})`)
    const laneRolls: ReadonlyArray<HTMLElement> = Arrays.create(index =>
        button(lifecycle, "Roll", edit(pattern => pattern.lanes[index].seed = rollSeed()), `3 / ${index * 2 + 2}`, "lanes"), Lanes)
    // a button that rolls more than itself shows it on the buttons it stands for while it is held
    const presses = (element: HTMLElement, others: ReadonlyArray<HTMLElement>): HTMLElement => {
        const press = (pressed: boolean) => () => others.forEach(other => other.classList.toggle("pressed", pressed))
        lifecycle.ownAll(
            Events.subscribe(element, "pointerdown", press(true)),
            Events.subscribe(element, "pointerup", press(false)),
            Events.subscribe(element, "pointerleave", press(false)),
            Events.subscribe(element, "pointercancel", press(false)))
        return element
    }
    const laneControls = Arrays.create(index => {
        const column = 1 + index * 2
        const lane = () => current().lanes[index]
        return [
            control(`${LaneNames[index]} Steps`, field(whole(1, SurgeonModel.MaxSteps, () => lane().steps, steps => lane().steps = steps)), `2 / ${column}`, laneColor(index)),
            control("Seed", field(whole(0, 99_999, () => lane().seed, seed => lane().seed = seed)), `2 / ${column + 1}`),
            control("Mutate", field(percent(() => lane().mutate, mutate => lane().mutate = mutate)), `3 / ${column}`),
            laneRolls[index]
        ]
    }, Lanes)
    const pitch = () => current().pitch
    const rollPitch = button(lifecycle, "Pitch", edit(pattern => pattern.pitch.seed = rollSeed()), "4 / 1 / 5 / 3", "roll")
    const rollLanes = presses(button(lifecycle, "Lanes",
        edit(pattern => pattern.lanes.forEach(lane => lane.seed = rollSeed())), "4 / 3 / 5 / 5", "roll"), laneRolls)
    const rollSound = button(lifecycle, "Sound", edit(pattern => {
        const {base, amounts} = SurgeonModel.random(rollSeed())
        base.forEach((position, index) => pattern.base[index] = position)
        amounts.forEach((row, index) => pattern.amounts[index] = row)
    }), "4 / 5 / 5 / 7", "roll")
    const loops: HTMLElement = (
        <section className="loops">
            <div className="band pitch" style={{gridArea: "1 / 1 / 2 / -1"}}/>
            <div className="band lanes" style={{gridArea: "2 / 1 / 4 / -1"}}/>
            <div className="band roll" style={{gridArea: "4 / 1 / 5 / -1"}}/>
            <h3 className="rotated pitch" style={{gridArea: "1 / -2"}}>PITCH</h3>
            {control("Seed", field(whole(0, 99_999, () => pitch().seed, seed => pitch().seed = seed)), "1 / 1")}
            {control("Steps", field(whole(1, SurgeonModel.MaxSteps, () => pitch().steps, steps => pitch().steps = steps)), "1 / 2")}
            {control("Mutate", field(percent(() => pitch().mutate, mutate => pitch().mutate = mutate)), "1 / 3")}
            {control("Range", field({
                min: 0.0, max: 36.0, step: 0.25, print: Prints.octaves, parse: Parses.octaves,
                get: () => pitch().range, set: range => pitch().range = range
            }), "1 / 4")}
            {control("Density", field(percent(() => pitch().density, density => pitch().density = density)), "1 / 5")}
            {control("Tie", field(percent(() => pitch().tie, tie => pitch().tie = tie)), "1 / 6")}
            {control("Slide", field(percent(() => pitch().slide, slide => pitch().slide = slide)), "1 / 7")}
            {control("Accent", field(percent(() => pitch().accent, accent => pitch().accent = accent)), "1 / 8")}
            <h3 className="rotated lanes" style={{gridArea: "2 / -2 / 4 / -1"}}>LANES</h3>
            {laneControls}
            <h3 className="rotated roll" style={{gridArea: "4 / -2"}}>ROLL</h3>
            {rollPitch}
            {rollLanes}
            {rollSound}
            {presses(button(lifecycle, "All", () => {
                patterns[state.shown] = SurgeonModel.rollAll(current(), rollSeed())
                refresh.notify()
            }, "4 / 7 / 5 / 9", "roll"), [rollPitch, rollLanes, rollSound, ...laneRolls])}
        </section>
    )
    const basePrint = (param: int): SurgeonControls.Field["print"] => {
        const {StrikeDecay, Glide, Feedback, Fold, Length, HeldShare, Velocity} = Index
        const print = param === StrikeDecay || param === Glide ? Prints.millis
            : [Feedback, Fold, Length, HeldShare, Velocity].some(index => index === param) ? Prints.percent : Prints.fixed
        return position => print(SurgeonModel.valueOf(Params[param], position))
    }
    const baseCell = (param: int): HTMLElement => {
        const {choices} = Params[param]
        if (isDefined(choices)) {
            return choice(lifecycle, refresh, choices,
                () => Math.min(Math.floor(SurgeonModel.valueOf(Params[param], current().base[param])), choices.length - 1),
                index => current().base[param] = SurgeonModel.unitOf(Params[param], index + 0.5))
        }
        return field({
            min: 0.0, max: 1.0, step: 0.005, print: basePrint(param),
            parse: text => {
                const parsed = Parses.plain(text)
                if (!isDefined(parsed)) {return undefined}
                const scale = basePrint(param)(0.5)[1] === "%" ? 0.01 : basePrint(param)(0.5)[1] === "ms" ? 0.001 : 1.0
                return SurgeonModel.unitOf(Params[param], clamp(parsed * scale, Params[param].min, Params[param].max))
            },
            get: () => current().base[param], set: position => current().base[param] = position
        })
    }
    const amountCell = (param: int, lane: int): HTMLElement => field({
        min: -1.0, max: 1.0, step: 0.01,
        print: amount => Math.round(amount * 100) === 0 ? ["0", ""] : [`${amount > 0.0 ? "+" : ""}${Math.round(amount * 100)}`, "%"],
        parse: Parses.percent,
        get: () => current().amounts[param][lane],
        set: amount => current().amounts[param][lane] = amount,
        decorate: (label, amount) => label.classList.toggle("zero", Math.round(amount * 100) === 0)
    })
    const sound = (params: ReadonlyArray<int>): HTMLElement => (
        <section className="sound hidden">
            {params.map((param, index) => <h3 className="caption" style={{gridArea: `1 / ${index + 1}`}}>{Params[param].name}</h3>)}
            <div className="band base" style={{gridArea: "2 / 1 / 3 / -1"}}/>
            <h3 className="rotated base" style={{gridArea: "2 / -2"}}>0</h3>
            {params.map((param, index) => <div className="cell" style={{gridArea: `2 / ${index + 1}`}}>{baseCell(param)}</div>)}
            {Arrays.create(lane => [
                <div className="band" style={{gridArea: `${lane + 3} / 1 / ${lane + 4} / -1`, "--color": laneColor(lane)}}/>,
                <h3 className="rotated" style={{gridArea: `${lane + 3} / -2`, "--color": laneColor(lane)}}>{LaneNames[lane]}</h3>,
                params.map((param, index) => (
                    <div className="cell amount" style={{gridArea: `${lane + 3} / ${index + 1}`, "--color": laneColor(lane)}}>
                        {amountCell(param, lane)}
                    </div>
                ))
            ], Lanes)}
        </section>
    )
    const sections: ReadonlyArray<HTMLElement> = [loops, sound(ToneParams), sound(ShapeParams)]
    const tabs: ReadonlyArray<HTMLElement> = ["LOOPS", "TONE", "SHAPE"].map(label => <h3 className="tab">{label}</h3>)
    const selectTab = (selected: int) => {
        tabs.forEach((tab, index) => tab.classList.toggle("selected", index === selected))
        sections.forEach((section, index) => section.classList.toggle("hidden", index !== selected))
    }
    tabs.forEach((tab, index) => lifecycle.own(Events.subscribe(tab, "click", () => selectTab(index))))
    selectTab(0)
    updateTiles()
    const controls: HTMLElement = (
        <div className="surgeon">
            <nav className="patterns">
                <div className="circles">
                    {tiles}
                    {offTile}
                </div>
                <div className="values">
                    {control("Rate", choice(lifecycle, refresh, Rates, () => current().rate, rate => current().rate = rate))}
                    {control("Tune", field({
                        min: 24.0, max: 96.0, step: 0.1, print: Prints.hertz, parse: Parses.hertz,
                        get: () => state.tune, set: tune => state.tune = tune
                    }))}
                    {control("Volume", field({
                        min: -36.0, max: 6.0, step: 0.5, print: Prints.decibel, parse: Parses.plain,
                        get: () => state.volume, set: volume => state.volume = volume
                    }))}
                </div>
            </nav>
            <div className="display">{canvas}</div>
            <div className="sections">
                <header>{tabs}</header>
                {sections}
            </div>
        </div>
    )
    return (
        <div className={className}>
            <div className="transport">
                {playButton}
                {status}
            </div>
            {PreviewDevicePanel.create([PreviewDevicePanel.editor({
                lifecycle, name: "Surgeon", icon: IconSymbol.Waveform, type: "instrument", controls
            })])}
        </div>
    )
}
