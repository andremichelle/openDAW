import css from "./StemPreviewDialog.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Exec, ObservableValue, Option, Terminator, unitValue} from "@opendaw/lib-std"
import {Dragging, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon, IconCartridge} from "@/ui/components/Icon"
import {ProgressBar} from "@/ui/components/ProgressBar"
import {Surface} from "@/ui/surface/Surface"
import {STEM_NAMES, StemName, StemPreviewPlayer} from "@/service/StemPreviewPlayer"

const className = Html.adoptStyleSheet(css, "StemPreviewDialog")

const STEM_LABELS: Record<StemName, string> = {drums: "Drums", bass: "Bass", other: "Other", vocals: "Vocals"}

const formatClock = (seconds: number): string => {
    const total = Math.max(0, Math.floor(seconds))
    const minutes = Math.floor(total / 60)
    const secs = total % 60
    return `${minutes}:${secs.toString().padStart(2, "0")}`
}

type Construct = {
    player: StemPreviewPlayer
    totalSamples: number
    sampleRate: number
    progress: ObservableValue<unitValue>
    providerLabel: string
    onCancel: Exec
}

const openStemPreviewDialog = ({player, totalSamples, sampleRate, progress, providerLabel, onCancel}: Construct): {close: Exec} => {
    const lifecycle = new Terminator()
    let completed = false

    const statusEl: HTMLParagraphElement = (<p className="status"/>) as HTMLParagraphElement
    const updateStatus = (): void => {
        const separatedSeconds = player.frontier.getValue() / sampleRate
        const totalSeconds = totalSamples / sampleRate
        const done = player.frontier.getValue() >= totalSamples
        const suffix = done ? "" : " · still separating…"
        statusEl.textContent =
            `Separated ${formatClock(separatedSeconds)} / ${formatClock(totalSeconds)} · ${providerLabel}${suffix}`
    }
    lifecycle.own(player.frontier.subscribe(updateStatus))
    updateStatus()

    const iconModel = new DefaultObservableValue(IconSymbol.Play)
    const playButton: HTMLElement = (
        <div className="play-stop" onclick={() => (player.playing.getValue() ? player.stop() : player.play())}>
            <IconCartridge lifecycle={lifecycle} symbol={iconModel}/>
        </div>
    )
    lifecycle.own(player.playing.catchupAndSubscribe(owner =>
        iconModel.setValue(owner.getValue() ? IconSymbol.Stop : IconSymbol.Play)))

    const seekFill: HTMLElement = (<div className="seek-fill"/>)
    const seekPlayhead: HTMLElement = (<div className="seek-playhead"/>)
    const seekTrack: HTMLElement = (
        <div className="seek-track">
            {seekFill}
            {seekPlayhead}
        </div>
    )
    const seekToClientX = (clientX: number): void => {
        const rect = seekTrack.getBoundingClientRect()
        const fraction = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
        player.seek(Math.round(fraction * totalSamples))
    }
    lifecycle.own(Dragging.attach(seekTrack, () => Option.wrap({
        update: (event: Dragging.Event) => seekToClientX(event.clientX)
    } satisfies Dragging.Process), {immediate: true}))

    let rafHandle: number = -1
    const tick = (): void => {
        const playheadFraction = totalSamples > 0 ? Math.min(1, player.currentSample() / totalSamples) : 0
        seekPlayhead.style.setProperty("--position", playheadFraction.toFixed(4))
        const frontierFraction = totalSamples > 0 ? Math.min(1, player.frontier.getValue() / totalSamples) : 0
        seekFill.style.setProperty("--progress", frontierFraction.toFixed(4))
        rafHandle = requestAnimationFrame(tick)
    }
    rafHandle = requestAnimationFrame(tick)
    lifecycle.own({terminate: () => cancelAnimationFrame(rafHandle)})

    const stemRowsHeader: HTMLElement = (
        <div className="stem-row header">
            <span className="name"/>
            <span className="column-label">Mute</span>
            <span className="column-label">Solo</span>
        </div>
    )
    const stemRows = STEM_NAMES.map(name => {
        const controls = player.stems[name]
        return (
            <div className="stem-row">
                <span className="name">{STEM_LABELS[name]}</span>
                <Checkbox lifecycle={lifecycle} model={controls.mute} appearance={{activeColor: Colors.orange, framed: true}}>
                    <Icon symbol={IconSymbol.Mute}/>
                    <span>Mute</span>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={controls.solo} appearance={{activeColor: Colors.yellow, framed: true}}>
                    <Icon symbol={IconSymbol.Solo}/>
                    <span>Solo</span>
                </Checkbox>
            </div>
        )
    })
    const hint: HTMLElement = (
        <p className="hint">
            Play/Stop previews stems as they finish separating · drag the bar to seek within what's
            already separated · Mute silences a stem, Solo isolates it
        </p>
    )

    const dialog = (
        <Dialog headline="Separating stems"
                icon={IconSymbol.Waveform}
                cancelable
                onCancel={() => {if (!completed) {onCancel()}}}
                buttons={[{text: "Cancel", onClick: handler => {onCancel(); handler.close()}}]}>
            <div className={className}>
                {statusEl}
                <ProgressBar lifecycle={lifecycle} progress={progress}/>
                <div className="transport">
                    {playButton}
                    {seekTrack}
                </div>
                <div className="stems">
                    {stemRowsHeader}
                    {stemRows}
                </div>
                {hint}
            </div>
        </Dialog>
    )
    dialog.addEventListener("close", () => lifecycle.terminate())
    Surface.get().body.appendChild(dialog)
    dialog.showModal()

    return {
        close: (): void => {
            completed = true
            dialog.close()
        }
    }
}

export const StemPreviewDialog = {open: openStemPreviewDialog}
