import css from "./SampleEditorPage.sass?inline"
import {
    ByteArrayInput,
    DefaultObservableValue,
    EmptyExec,
    int,
    isDefined,
    MutableObservableOption,
    Option,
    Predicates,
    Progress,
    RuntimeNotifier,
    Terminator
} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html, Key, Keyboard, Shortcut, ShortcutManager} from "@opendaw/lib-dom"
import {createElement, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {AudioSplice, SampleEffect, SampleEffects} from "@opendaw/lib-dsp"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {AudioDevices, CanvasPainter, MenuItem, Workers} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {SampleDocument} from "@/ui/pages/sample-editor/SampleDocument"
import {SampleEdits} from "@/ui/pages/sample-editor/SampleEdits"
import {SamplePainter} from "@/ui/pages/sample-editor/SamplePainter"
import {SamplePlayer} from "@/ui/pages/sample-editor/SamplePlayer"
import {SampleRecorder} from "@/ui/pages/sample-editor/SampleRecorder"
import {SampleViewport} from "@/ui/pages/sample-editor/SampleViewport"

const className = Html.adoptStyleSheet(css, "SampleEditorPage")

const ctrl = true
const shift = true

export const SampleEditorPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const editor = service.sampleEditor
    const player = lifecycle.own(new SamplePlayer(service.audioContext))
    const viewport = new SampleViewport()
    const loop = new DefaultObservableValue(false)
    const channelCount = new DefaultObservableValue<1 | 2>(2)
    const inputDevice = new DefaultObservableValue<Option<MediaDeviceInfo>>(Option.None)
    const recorder = new MutableObservableOption<SampleRecorder>()
    const peaks = new MutableObservableOption<Peaks>()
    const playhead = new DefaultObservableValue<Option<int>>(Option.None)
    const noDocument = new DefaultObservableValue(true)
    const noSelection = new DefaultObservableValue(true)
    const cannotPaste = new DefaultObservableValue(true)
    const cannotUndo = new DefaultObservableValue(true)
    const cannotRedo = new DefaultObservableValue(true)
    const isRecording = new DefaultObservableValue(false)
    const documentLifecycle = lifecycle.own(new Terminator())
    const current = (): Option<SampleDocument> => editor.document
    const nameLabel: HTMLElement = <span className="name"/>
    const infoLabel: HTMLElement = <span className="info"/>
    const inputLabel: HTMLElement = <span>Default Input</span>
    const meterBar: HTMLElement = <div className="bar"/>
    const recordTime: HTMLElement = <span className="record-time"/>
    const statusSelection: HTMLElement = <span/>
    const statusLength: HTMLElement = <span/>
    const statusZoom: HTMLElement = <span/>
    const overviewCanvas: HTMLCanvasElement = <canvas/>
    const rulerCanvas: HTMLCanvasElement = <canvas/>
    const waveformCanvas: HTMLCanvasElement = <canvas/>
    const lanes: HTMLElement = <div className="lanes">{waveformCanvas}</div>
    const empty: HTMLElement = (
        <div className="empty">
            <p>Open a sample from the File menu or press Record.</p>
        </div>
    )
    const refresh = (): void => {
        const document = current()
        noDocument.setValue(document.isEmpty())
        noSelection.setValue(!document.mapOr(document => document.hasSelection, false))
        cannotUndo.setValue(!document.mapOr(document => document.canUndo, false))
        cannotRedo.setValue(!document.mapOr(document => document.canRedo, false))
        cannotPaste.setValue(document.isEmpty() || editor.clipboard.isEmpty()
            || !SampleEdits.canPaste(document.unwrap(), editor.clipboard.unwrap()))
        empty.classList.toggle("hidden", document.nonEmpty())
        document.match({
            none: () => {
                nameLabel.textContent = "Sample Editor"
                infoLabel.textContent = ""
                statusSelection.textContent = ""
                statusLength.textContent = ""
                statusZoom.textContent = ""
            },
            some: document => {
                const {audio: {sampleRate, numberOfChannels, numberOfFrames}} = document
                const seconds = (frames: number) => SamplePainter.formatTime(frames / sampleRate)
                const {from, to} = document.selection.getValue()
                nameLabel.textContent = `${document.name}${document.hasUnsavedChanges ? " *" : ""}`
                infoLabel.textContent = `${sampleRate / 1000} kHz · ${numberOfChannels === 1 ? "Mono" : numberOfChannels === 2
                    ? "Stereo" : `${numberOfChannels} Channels`} · ${seconds(numberOfFrames)}`
                statusSelection.textContent = to > from
                    ? `Selection ${seconds(from)} – ${seconds(to)} (${to - from} frames)`
                    : `Cursor ${seconds(from)}`
                statusLength.textContent = `Length ${numberOfFrames} frames`
                statusZoom.textContent = viewport.framesPerPixel >= 1.0
                    ? `Zoom 1:${Math.round(viewport.framesPerPixel)}`
                    : `Zoom ${Math.round(1.0 / viewport.framesPerPixel)}:1`
            }
        })
    }
    const overviewPainter = lifecycle.own(new CanvasPainter(overviewCanvas, painter =>
        current().ifSome(document => SamplePainter.overview(painter, document.audio, peaks, viewport))))
    const rulerPainter = lifecycle.own(new CanvasPainter(rulerCanvas, painter =>
        current().ifSome(document => SamplePainter.ruler(painter, viewport, document.audio.sampleRate))))
    const waveformPainter = lifecycle.own(new CanvasPainter(waveformCanvas, painter =>
        current().ifSome(document => SamplePainter.waveform(painter, {
            audio: document.audio, peaks, viewport, selection: document.selection.getValue(), playhead: playhead.getValue()
        }))))
    const repaint = (): void => {
        overviewPainter.requestUpdate()
        rulerPainter.requestUpdate()
        waveformPainter.requestUpdate()
    }
    const updatePeaks = (document: SampleDocument): void => {
        const {audio} = document
        peaks.clear()
        if (audio.numberOfFrames === 0) {return}
        Workers.Peak.generateAsync(Progress.Empty, SamplePeaks.findBestFit(audio.numberOfFrames),
            audio.frames, audio.numberOfFrames, audio.numberOfChannels)
            .then(buffer => {
                if (current().unwrapOrNull()?.audio !== audio) {return}
                peaks.wrap(SamplePeaks.from(new ByteArrayInput(buffer as ArrayBuffer)))
                repaint()
            }, console.warn)
    }
    const stop = (): void => player.stop()
    const play = (): void => current().ifSome(document => {
        if (player.isPlaying.getValue()) {return stop()}
        const {from, to} = document.selection.getValue()
        const range = to > from ? {from, to} : {from, to: document.audio.numberOfFrames}
        player.play(document.audio, range, loop.getValue() && to > from)
    })
    const edit = (procedure: (document: SampleDocument) => void): void => current().ifSome(document => {
        stop()
        procedure(document)
    })
    const copy = () => current().ifSome(document => SampleEdits.copy(document).ifSome(clip => editor.clipboard.wrap(clip)))
    const cut = () => edit(document => SampleEdits.cut(document).ifSome(clip => editor.clipboard.wrap(clip)))
    const paste = () => edit(document => editor.clipboard.ifSome(clip => SampleEdits.paste(document, clip)))
    const remove = () => edit(document => SampleEdits.remove(document))
    const crop = () => edit(document => SampleEdits.crop(document))
    const silence = () => edit(document => SampleEdits.silence(document))
    const undo = () => edit(document => document.undo())
    const redo = () => edit(document => document.redo())
    const save = () => current().ifSome(document => editor.save(document).then(refresh, console.warn))
    const saveAs = () => current().ifSome(document => editor.saveAs(document).then(refresh, console.warn))
    const exportFile = () => current().ifSome(document => editor.exportFile(document).then(EmptyExec, console.warn))
    const zoomSelection = () => current().ifSome(document => {
        const {from, to} = document.selection.getValue()
        if (to > from) {viewport.zoomTo(from, to)}
    })
    const startRecording = async (): Promise<void> => {
        stop()
        await service.audioContext.resume()
        const {status, value, error} = await Promises.tryCatch(SampleRecorder.start(service.audioContext,
            inputDevice.getValue().map(({deviceId}) => deviceId).unwrapOrUndefined(), channelCount.getValue()))
        if (status === "rejected") {
            return RuntimeNotifier.info({headline: "Could not record", message: String(error)})
        }
        value.record()
        recorder.wrap(value)
        isRecording.setValue(true)
    }
    const stopRecording = (): void => recorder.ifSome(active => {
        const audio = active.finish()
        active.terminate()
        recorder.clear()
        isRecording.setValue(false)
        if (audio.numberOfFrames === 0) {return}
        const document = current()
        if (document.nonEmpty() && document.unwrap().audio.sampleRate === audio.sampleRate) {
            const target = document.unwrap()
            const {from, to} = target.selection.getValue()
            const insert = AudioSplice.matchChannels(audio, target.audio.numberOfChannels)
            target.replace(from, to - from, insert, {from, to: from + insert.numberOfFrames})
        } else {
            editor.openRecording(audio).then(EmptyExec, console.warn)
        }
    })
    const toggleRecording = () => isRecording.getValue() ? stopRecording() : startRecording().then(EmptyExec, console.warn)
    const fileMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const document = current()
        parent.addMenuItem(
            MenuItem.default({label: "New", selectable: document.nonEmpty()})
                .setTriggerProcedure(() => editor.close().then(EmptyExec, console.warn)),
            MenuItem.default({label: "Open Sample..."})
                .setTriggerProcedure(() => editor.openPicker().then(EmptyExec, console.warn)),
            MenuItem.default({label: "Import Audio File..."})
                .setTriggerProcedure(() => editor.importFile().then(EmptyExec, console.warn)),
            MenuItem.default({
                label: "Save",
                shortcut: Shortcut.of(Key.KeyS, {ctrl}).format(),
                selectable: document.mapOr(document => editor.canSave(document), false),
                separatorBefore: true
            }).setTriggerProcedure(save),
            MenuItem.default({
                label: "Save As New Sample",
                shortcut: Shortcut.of(Key.KeyS, {ctrl, shift}).format(),
                selectable: document.nonEmpty()
            }).setTriggerProcedure(saveAs),
            MenuItem.default({label: "Export...", selectable: document.nonEmpty(), separatorBefore: true})
                .setTriggerProcedure(exportFile)
        )
    })
    const effectsMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const document = current()
        const item = (effect: SampleEffect, separatorBefore: boolean) =>
            MenuItem.default({
                label: effect.parameters.length > 0 ? `${effect.name}...` : effect.name,
                selectable: document.mapOr(document => document.audio.numberOfFrames > 0 && effect.accepts(document.audio), false),
                separatorBefore
            }).setTriggerProcedure(() => edit(document =>
                editor.applyEffect(document, effect).then(EmptyExec, console.warn)))
        parent.addMenuItem(
            ...SampleEffects.Basics.map(effect => item(effect, false)),
            ...SampleEffects.Processors.map((effect, index) => item(effect, index === 0)))
    })
    const inputMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        parent.addMenuItem(MenuItem.default({label: "Default Input", checked: inputDevice.getValue().isEmpty()})
            .setTriggerProcedure(() => inputDevice.setValue(Option.None)))
        AudioDevices.inputs.forEach(device => parent.addMenuItem(MenuItem.default({
            label: device.label,
            checked: inputDevice.getValue().mapOr(({deviceId}) => deviceId === device.deviceId, false)
        }).setTriggerProcedure(() => inputDevice.setValue(Option.wrap(device)))))
        if (AudioDevices.inputs.length === 0) {
            parent.addMenuItem(MenuItem.default({label: "Allow Access to List Inputs", separatorBefore: true})
                .setTriggerProcedure(() => AudioDevices.requestPermission().then(EmptyExec, console.warn)))
        }
    })
    const shortcuts = ShortcutManager.get().createContext(Predicates.alwaysTrue, "SampleEditor", 1000)
    lifecycle.ownAll(
        shortcuts,
        shortcuts.register(Shortcut.of(Key.Space), play),
        shortcuts.register(Shortcut.of(Key.DeleteAction), remove),
        shortcuts.register(Shortcut.of(Key.KeyA, {ctrl}), () => current().ifSome(document => document.selectAll())),
        shortcuts.register(Shortcut.of(Key.KeyZ, {ctrl}), undo, {allowRepeat: true}),
        shortcuts.register(Shortcut.of(Key.KeyZ, {ctrl, shift}), redo, {allowRepeat: true}),
        shortcuts.register(Shortcut.of(Key.KeyS, {ctrl}), save),
        shortcuts.register(Shortcut.of(Key.KeyS, {ctrl, shift}), saveAs),
        shortcuts.register(Shortcut.of(Key.KeyR), toggleRecording),
        Surface.subscribeKeyboard("keydown", event => {
            if (!Keyboard.isControlKey(event) || event.shiftKey || event.altKey || Events.isTextInput(event.target)
                || isDefined(document.querySelector("dialog[open]"))) {return}
            const action = event.code === Key.KeyC ? copy : event.code === Key.KeyX ? cut : event.code === Key.KeyV ? paste : null
            if (!isDefined(action)) {return}
            event.preventDefault()
            action()
        }),
        editor.clipboard.subscribe(refresh),
        inputDevice.catchupAndSubscribe(owner =>
            inputLabel.textContent = owner.getValue().mapOr(({label}) => label, "Default Input")),
        viewport.subscribe(() => {
            repaint()
            refresh()
        }),
        peaks.subscribe(repaint),
        playhead.subscribe(() => waveformPainter.requestUpdate()),
        player.isPlaying.subscribe(owner => {if (!owner.getValue()) {playhead.setValue(Option.None)}}),
        AnimationFrame.add(() => {
            const position = player.position()
            if (position.nonEmpty() || playhead.getValue().nonEmpty()) {playhead.setValue(position)}
            position.ifSome(frame => {
                if (frame < viewport.start || frame > viewport.end) {viewport.scrollTo(frame)}
            })
            recorder.ifSome(active => {
                const data = new Float32Array(active.analyser.fftSize)
                active.analyser.getFloatTimeDomainData(data)
                const peak = data.reduce((max, value) => Math.max(max, Math.abs(value)), 0.0)
                meterBar.style.width = `${Math.min(100, peak * 100)}%`
                recordTime.textContent = SamplePainter.formatTime(active.numberOfFrames / service.audioContext.sampleRate, 0.1)
            })
            if (recorder.isEmpty() && meterBar.style.width !== "0%") {
                meterBar.style.width = "0%"
                recordTime.textContent = ""
            }
        }),
        {terminate: () => recorder.ifSome(active => active.terminate())},
        Html.watchResize(lanes, ({contentRect: {width}}) => viewport.resize(width)),
        editor.document.catchupAndSubscribe(option => {
            documentLifecycle.terminate()
            stop()
            option.match({
                none: () => {
                    peaks.clear()
                    viewport.setLength(0)
                },
                some: document => {
                    viewport.setLength(document.audio.numberOfFrames)
                    viewport.fit()
                    updatePeaks(document)
                    documentLifecycle.ownAll(
                        document.subscribe(() => {
                            viewport.setLength(document.audio.numberOfFrames)
                            updatePeaks(document)
                            repaint()
                            refresh()
                        }),
                        document.selection.subscribe(() => {
                            waveformPainter.requestUpdate()
                            refresh()
                        }))
                }
            })
            repaint()
            refresh()
        })
    )
    const installSelection = (element: HTMLElement): void => {
        lifecycle.ownAll(
            Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0) {return}
                current().ifSome(document => {
                    stop()
                    const frameOf = (clientX: number) =>
                        viewport.frameAt(clientX - element.getBoundingClientRect().left)
                    const {from, to} = document.selection.getValue()
                    const pointer = frameOf(event.clientX)
                    const anchor = event.shiftKey ? (Math.abs(pointer - from) < Math.abs(pointer - to) ? to : from) : pointer
                    document.select(anchor, pointer)
                    element.setPointerCapture(event.pointerId)
                    const moving = new Terminator()
                    moving.ownAll(
                        Events.subscribe(element, "pointermove", (move: PointerEvent) =>
                            document.select(anchor, frameOf(move.clientX))),
                        Events.subscribe(element, "pointerup", () => moving.terminate()),
                        Events.subscribe(element, "lostpointercapture", () => moving.terminate()))
                })
            }),
            Events.subscribe(element, "dblclick", () => current().ifSome(document => document.selectAll())),
            Events.subscribe(element, "wheel", (event: WheelEvent) => {
                event.preventDefault()
                if (event.ctrlKey || event.metaKey) {
                    viewport.zoom(Math.exp(event.deltaY * 0.01), event.clientX - element.getBoundingClientRect().left)
                } else {
                    viewport.scrollBy(Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
                }
            }, {passive: false})
        )
    }
    const installOverview = (element: HTMLElement): void => {
        const center = (clientX: number) => {
            const {left, width} = element.getBoundingClientRect()
            const frame = (clientX - left) / width * viewport.numberOfFrames
            viewport.scrollTo(frame - (viewport.end - viewport.start) * 0.5)
        }
        lifecycle.own(Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            if (event.button !== 0 || viewport.numberOfFrames === 0) {return}
            center(event.clientX)
            element.setPointerCapture(event.pointerId)
            const moving = new Terminator()
            moving.ownAll(
                Events.subscribe(element, "pointermove", (move: PointerEvent) => center(move.clientX)),
                Events.subscribe(element, "pointerup", () => moving.terminate()),
                Events.subscribe(element, "lostpointercapture", () => moving.terminate()))
        }))
    }
    return (
        <div className={className}>
            <header>
                <Button lifecycle={lifecycle}
                        onClick={() => RouteLocation.get().navigateTo(service.hasProfile ? "/create" : "/")}
                        appearance={{tooltip: "Exit editor"}}>
                    <span>Exit</span> <Icon symbol={IconSymbol.Exit}/>
                </Button>
                <MenuButton root={fileMenu} appearance={{tinyTriangle: true, color: Colors.dark}}>
                    <span>File</span>
                </MenuButton>
                <Button lifecycle={lifecycle} onClick={undo} disabled={cannotUndo} appearance={{tooltip: "Undo"}}>
                    <Icon symbol={IconSymbol.Undo}/>
                </Button>
                <Button lifecycle={lifecycle} onClick={redo} disabled={cannotRedo} appearance={{tooltip: "Redo"}}>
                    <Icon symbol={IconSymbol.Redo}/>
                </Button>
                {nameLabel}
                {infoLabel}
            </header>
            <div className="toolbar">
                <div className="group">
                    <Button lifecycle={lifecycle} onClick={toggleRecording}
                            onInit={element => lifecycle.own(isRecording.catchupAndSubscribe(owner =>
                                element.classList.toggle("recording", owner.getValue())))}
                            appearance={{tooltip: "Record (R)"}}>
                        <Icon symbol={IconSymbol.Record}/>
                    </Button>
                    <MenuButton root={inputMenu} appearance={{tinyTriangle: true, color: Colors.dark}}>
                        {inputLabel}
                    </MenuButton>
                    <RadioGroup lifecycle={lifecycle} model={channelCount} appearance={{framed: true}}
                                elements={[
                                    {value: 1, element: <span>Mono</span>},
                                    {value: 2, element: <span>Stereo</span>}
                                ]}/>
                    <div className="meter">{meterBar}</div>
                    {recordTime}
                </div>
                <div className="group">
                    <Button lifecycle={lifecycle} onClick={play} disabled={noDocument}
                            onInit={element => lifecycle.own(player.isPlaying.catchupAndSubscribe(owner =>
                                element.classList.toggle("active", owner.getValue())))}
                            appearance={{tooltip: "Play (Space)"}}>
                        <Icon symbol={IconSymbol.Play}/>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={stop} disabled={noDocument} appearance={{tooltip: "Stop"}}>
                        <Icon symbol={IconSymbol.Stop}/>
                    </Button>
                    <Checkbox lifecycle={lifecycle} model={loop} appearance={{tooltip: "Loop selection"}}>
                        <Icon symbol={IconSymbol.Loop}/>
                    </Checkbox>
                </div>
                <div className="group">
                    <Button lifecycle={lifecycle} onClick={cut} disabled={noSelection} appearance={{tooltip: "Cut"}}>
                        <Icon symbol={IconSymbol.Scissors}/>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={copy} disabled={noSelection} appearance={{tooltip: "Copy"}}>
                        <Icon symbol={IconSymbol.Copy}/>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={paste} disabled={cannotPaste} appearance={{tooltip: "Paste"}}>
                        <Icon symbol={IconSymbol.Paste}/>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={remove} disabled={noSelection} appearance={{tooltip: "Delete"}}>
                        <Icon symbol={IconSymbol.Delete}/>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={crop} disabled={noSelection}
                            appearance={{tooltip: "Crop to selection"}}>
                        <span>Crop</span>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={silence} disabled={noSelection}
                            appearance={{tooltip: "Silence selection"}}>
                        <span>Silence</span>
                    </Button>
                </div>
                <div className="group">
                    <MenuButton root={effectsMenu} appearance={{tinyTriangle: true, color: Colors.dark}}>
                        <span>Effects</span>
                    </MenuButton>
                </div>
                <div className="group zoom">
                    <Button lifecycle={lifecycle} onClick={() => viewport.zoom(2.0)} disabled={noDocument}
                            appearance={{tooltip: "Zoom out"}}>
                        <span>−</span>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={() => viewport.zoom(0.5)} disabled={noDocument}
                            appearance={{tooltip: "Zoom in"}}>
                        <span>+</span>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={zoomSelection} disabled={noSelection}
                            appearance={{tooltip: "Zoom to selection"}}>
                        <span>Sel</span>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={() => viewport.fit()} disabled={noDocument}
                            appearance={{tooltip: "Fit"}}>
                        <Icon symbol={IconSymbol.ZoomFit}/>
                    </Button>
                </div>
            </div>
            <div className="overview" onInit={installOverview}>{overviewCanvas}</div>
            <div className="editor">
                <div className="ruler">{rulerCanvas}</div>
                <div className="lanes-wrapper" onInit={installSelection}>{lanes}{empty}</div>
            </div>
            <footer>
                {statusSelection}
                {statusLength}
                {statusZoom}
            </footer>
        </div>
    )
}
