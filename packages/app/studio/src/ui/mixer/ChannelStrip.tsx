import css from "./ChannelStrip.sass?inline"
import {EmptyExec, Lifecycle, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, ColorCodes} from "@opendaw/studio-adapters"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {createElement, DomElement, Frag, Inject} from "@opendaw/lib-jsx"
import {VolumeSlider} from "@/ui/components/VolumeSlider.tsx"
import {PeakMeter} from "@/ui/components/PeakMeter.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Icon, IconCartridge} from "@/ui/components/Icon.tsx"
import {Knob} from "@/ui/components/Knob.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter} from "@/ui/configs"
import {StudioService} from "@/service/StudioService"
import {MenuItem} from "@/ui/model/menu-item"
import {AuxSendGroup} from "@/ui/mixer/AuxSendGroup.tsx"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput.tsx"
import {ContextMenu} from "@/ui/ContextMenu"
import {ChannelOutputSelector} from "@/ui/mixer/ChannelOutputSelector.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {gainToDb} from "@opendaw/lib-dsp"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {DebugMenus} from "@/ui/menu/debug.ts"
import {ControlIndicator} from "../components/ControlIndicator"
import {DragAndDrop} from "../DragAndDrop"
import {Events, Html} from "@opendaw/lib-dom"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {AudioOutputSelector} from "./AudioOutputSelector"
import {ChannelStripView} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ChannelStrip")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AudioUnitBoxAdapter
    compact: boolean
}

export const ChannelStrip = ({lifecycle, service, adapter, compact}: Construct) => {
    const {mute, panning, solo, volume} = adapter.namedParameter
    const {project} = service
    const {editing, mixer, rootBoxAdapter, liveStreamReceiver, midiLearning} = project
    const isBus = adapter.type === AudioUnitType.Bus
    const isAux = adapter.type === AudioUnitType.Aux
    const isOutput = adapter.type === AudioUnitType.Output
    const inputLabel = lifecycle.own(Inject.value("No Input"))
    const peaks = new Float32Array(2)
    const volumeLabel: HTMLDivElement = <div className="value-display"/>
    const maxPeakLabel: HTMLDivElement = <div className="value-display peak valid">-∞</div>
    const updateVolumeLabel = () => volumeLabel.textContent = volume.stringMapping.x(volume.getControlledValue()).value
    updateVolumeLabel()
    let permanentPeak = Number.NEGATIVE_INFINITY
    lifecycle.own(liveStreamReceiver.subscribeFloats(adapter.address, array => {
        peaks[0] = gainToDb(array[0])
        peaks[1] = gainToDb(array[1])
        const maxPeak = Math.max(...peaks)
        if (permanentPeak <= maxPeak) {
            permanentPeak = maxPeak
            maxPeakLabel.textContent = Number.isFinite(permanentPeak) && permanentPeak > -96 ? permanentPeak.toFixed(1) : "-∞"
            maxPeakLabel.classList.toggle("valid", maxPeak <= 0.0)
            maxPeakLabel.classList.toggle("clipping", maxPeak > 0.0)
        }
    }))
    const volumeControl = (
        <ControlIndicator lifecycle={lifecycle} parameter={volume}>
            <VolumeSlider lifecycle={lifecycle} editing={editing} parameter={volume}/>
        </ControlIndicator>
    )
    const panningControl = (
        <ControlIndicator lifecycle={lifecycle} parameter={panning}>
            <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={panning}
                                       options={SnapCenter}>
                <Knob lifecycle={lifecycle} value={panning} anchor={0.5}/>
            </RelativeUnitValueDragging>
        </ControlIndicator>
    )
    const muteModel = EditWrapper.forAutomatableParameter(editing, mute)
    const soloModel = EditWrapper.forAutomatableParameter(editing, solo)
    const muteControl = (
        <ControlIndicator lifecycle={lifecycle} parameter={mute}>
            <Checkbox lifecycle={lifecycle}
                      model={muteModel}
                      className="mute"
                      appearance={{color: Colors.shadow, activeColor: Colors.orange, framed: true}}>
                <Icon symbol={IconSymbol.Mute}/>
            </Checkbox>
        </ControlIndicator>
    )
    const soloControl = (
        <ControlIndicator lifecycle={lifecycle} parameter={solo}>
            <Checkbox lifecycle={lifecycle}
                      model={soloModel}
                      className="solo"
                      appearance={{color: Colors.shadow, activeColor: Colors.yellow, framed: true}}>
                <Icon symbol={IconSymbol.Solo}/>
            </Checkbox>
        </ControlIndicator>
    )
    const iconElement: HTMLElement = <div
        style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: adapter.isOutput ? "auto" : "grab"
        }}>
        <IconCartridge lifecycle={lifecycle} symbol={adapter.input.iconValue}
                       style={{
                           fontSize: "2em",
                           alignSelf: "center",
                           justifySelf: "center",
                           marginTop: "0.5em",
                           marginBottom: "0.5em",
                           color: ColorCodes.forAudioType(adapter.type).toString()
                       }}/>
    </div>
    const classList = Html.buildClassList(className,
        isAux && "aux", isBus && "bus", isOutput && "output", compact && "compact")
    const peakMeter: DomElement = (<PeakMeter lifecycle={lifecycle} peaks={peaks}/>)
    const element: HTMLElement = (
        <div className={classList} data-drag>
            {!compact && (
                <Frag>
                    {iconElement}
                    <DblClckTextInput resolversFactory={
                        () => {
                            const resolvers = Promise.withResolvers<string>()
                            resolvers.promise.then((value: string) => editing.modify(() => adapter.input.label = value), EmptyExec)
                            return resolvers
                        }
                    } provider={() => ({value: adapter.input.label.unwrap(), unit: ""})}>
                        <h5 className="input">{inputLabel}</h5>
                    </DblClckTextInput>
                    <AuxSendGroup lifecycle={lifecycle} project={project} audioUnitAdapter={adapter}/>
                    {isOutput
                        ? <AudioOutputSelector lifecycle={lifecycle} output={service.audioDevices}/>
                        : <ChannelOutputSelector lifecycle={lifecycle} project={project} adapter={adapter}/>
                    }
                    {panningControl}
                </Frag>
            )}
            <div className="twin-layout volume">
                {volumeLabel}
                {maxPeakLabel}
                {volumeControl}
                {peakMeter}
            </div>
            <div className="twin-layout mute-solo">
                {muteControl}
                {!isOutput && soloControl}
            </div>
        </div>
    )
    if (!isOutput) {
        lifecycle.own(attachParameterContextMenu(editing, midiLearning, adapter.tracks, solo, soloControl))
    }
    lifecycle.ownAll(
        mixer.registerChannelStrip(adapter, {
            silent: (value: boolean) => peakMeter.classList.toggle("silent", value)
        } satisfies ChannelStripView),
        ContextMenu.subscribe(element, collector => {
            if (!isOutput) {
                collector.addItems(
                    MenuItem.default({label: `Delete '${adapter.input.label.unwrapOrElse("Untitled")}'`})
                        .setTriggerProcedure(() => editing.modify(() => project.api.deleteAudioUnit(adapter.box))))
            }
            collector.addItems(
                MenuItem.default({
                    label: "Reset Mute",
                    selectable: rootBoxAdapter.audioUnits.adapters().some(adapter => adapter.box.mute.getValue())
                }).setTriggerProcedure(() => editing.modify(() => rootBoxAdapter.audioUnits.adapters()
                    .forEach(adapter => adapter.box.mute.setValue(false)))),
                MenuItem.default({
                    label: "Reset Solo",
                    selectable: rootBoxAdapter.audioUnits.adapters().some(adapter => adapter.box.solo.getValue())
                }).setTriggerProcedure(() => editing.modify(() => rootBoxAdapter.audioUnits.adapters()
                    .forEach(adapter => adapter.box.solo.setValue(false)))),
                DebugMenus.debugBox(adapter.box, false)
            )
        }),
        adapter.input.catchupAndSubscribeLabelChange(option => inputLabel.value = option.unwrapOrElse("No Input")),
        attachParameterContextMenu(editing, midiLearning, adapter.tracks, volume, volumeControl),
        attachParameterContextMenu(editing, midiLearning, adapter.tracks, panning, panningControl),
        attachParameterContextMenu(editing, midiLearning, adapter.tracks, mute, muteControl),
        service.subscribeSignal(() => permanentPeak = Number.NEGATIVE_INFINITY, "reset-peaks"),
        Events.subscribe(maxPeakLabel, "pointerdown", (event) => {
            service.resetPeaks()
            event.stopPropagation()
            event.preventDefault()
        }),
        TextTooltip.default(maxPeakLabel, () => "Click to reset"),
        adapter.isOutput
            ? Terminable.Empty
            : DragAndDrop.installSource(iconElement, () => ({
                uuid: UUID.toString(adapter.uuid),
                type: "channelstrip",
                start_index: adapter.indexField.getValue()
            }), element),
        volume.subscribe(updateVolumeLabel)
    )
    return element
}