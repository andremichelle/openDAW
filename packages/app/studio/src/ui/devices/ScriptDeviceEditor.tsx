import css from "./ScriptDeviceEditor.sass?inline"
import {
    AutomatableParameterFieldAdapter,
    DeclarationSection,
    DeviceBoxAdapter,
    DeviceHost,
    GroupDeclaration,
    ParamDeclaration,
    ParameterAdapterSet,
    SampleDeclaration,
    ScriptCompiler,
    ScriptDeclaration,
    ScriptViewLayout,
    ScriptEntryPoints,
    SidechainDeclaration,
    ViewDeclaration
} from "@opendaw/studio-adapters"
import {
    asInstanceOf,
    Color,
    DefaultObservableValue,
    Editing,
    EmptyExec,
    isDefined,
    Lifecycle,
    MutableObservableValue,
    Nullable,
    Observable,
    ObservableValue,
    Observer,
    Subscription,
    Terminable,
    Terminator,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {DeviceEditor, getColorFor} from "@/ui/devices/DeviceEditor.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {AudioFileBox, WerkstattParameterBox, WerkstattSampleBox, WerkstattSidechainBox} from "@opendaw/studio-boxes"
import {Field} from "@opendaw/lib-box"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Icon, IconCartridge} from "@/ui/components/Icon"
import {Column} from "@/ui/devices/Column"
import {LKR} from "@/ui/devices/constants"
import {CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {MenuItem} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"
import {SidechainSelector} from "@/ui/devices/SidechainSelector"
import {ScriptViews, ScriptWindows} from "@/ui/devices/script-view/ScriptViews"

const className = Html.adoptStyleSheet(css, "ScriptDeviceEditor")

const boolModel = (editing: Editing, parameter: AutomatableParameterFieldAdapter<number>): MutableObservableValue<boolean> =>
    new class implements MutableObservableValue<boolean> {
        getValue(): boolean {return parameter.getControlledValue() >= 0.5}
        setValue(value: boolean) {editing.modify(() => parameter.setValue(value ? 1 : 0))}
        subscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
            return parameter.subscribe(() => observer(this))
        }
        catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
            return parameter.catchupAndSubscribe(() => observer(this))
        }
    }

type ScriptAdapter = DeviceBoxAdapter & {
    readonly box: ScriptCompiler.ScriptDeviceBox
    readonly parameters: ParameterAdapterSet
    readonly codeChanged: Observable<void>
    readonly sideChains?: Field<Pointers.ScriptSideChain>
}

export type ScriptDeviceEditorConfig = {
    readonly compiler: ScriptCompiler.Config
    readonly defaultCode: string
    readonly communityTarget: CommunityScriptTarget
    readonly starterPrompt: string
    readonly entryPoints: ScriptEntryPoints.Api
    readonly icon: IconSymbol
    readonly renew: (box: ScriptCompiler.ScriptDeviceBox, uuid: UUID.Bytes) => ScriptCompiler.ScriptDeviceBox
    readonly populateMenu: (parent: MenuItem, service: StudioService, deviceHost: DeviceHost, adapter: ScriptAdapter) => void
    readonly populateMeter: (construct: {
        lifecycle: Lifecycle,
        service: StudioService,
        adapter: ScriptAdapter
    }) => Nullable<HTMLElement>
}

// an example replaces the device: the replaced device keeps the code editor open, the new one takes it over
const codeEditorHandover = {replaced: new Set<string>(), opening: new Set<string>()}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ScriptAdapter
    deviceHost: DeviceHost
    config: ScriptDeviceEditorConfig
}

export const ScriptDeviceEditor = ({lifecycle, service, adapter, deviceHost, config}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const compiler = ScriptCompiler.create(config.compiler)
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? compiler.stripHeader(storedCode) : config.defaultCode
    const compile = async (code: string) => {
        const result = await Promises.tryCatch(compiler.compile(service.audioContext, editing, box, code))
        if (result.status === "rejected") {
            errorIcon.classList.remove("hidden")
            errorIcon.title = String(result.error)
            throw result.error
        }
    }
    const loadExample = async (code: string): Promise<void> => {
        const uuid = UUID.generate()
        const oldKey = UUID.toString(adapter.uuid), newKey = UUID.toString(uuid)
        codeEditorHandover.replaced.add(oldKey)
        codeEditorHandover.opening.add(newKey)
        const result = await Promises.tryCatch(compiler.replace(service.audioContext, editing, box, code,
            () => config.renew(box, uuid)))
        if (result.status === "rejected") {
            codeEditorHandover.replaced.delete(oldKey)
            codeEditorHandover.opening.delete(newKey)
            throw result.error
        }
    }
    if (storedCode.length > 0) {
        compiler.load(service.audioContext, box).finally(EmptyExec)
    } else {
        compiler.compile(service.audioContext, editing, box, userCode, true).finally(EmptyExec)
    }
    const isEditorActive = (): boolean => service.activeCodeEditor
        .map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
    const openEditor = () => service.openCodeEditor({
        handler: {
            uuid: adapter.uuid,
            name: adapter.labelField,
            compile,
            loadExample,
            subscribeErrors: observer =>
                service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), observer),
            subscribeCode: observer =>
                box.code.subscribe(owner => observer(compiler.stripHeader(owner.getValue())))
        },
        initialCode: compiler.stripHeader(box.code.getValue()) || config.defaultCode,
        previousScreen: service.layout.screen.getValue(),
        communityTarget: config.communityTarget,
        starterPrompt: config.starterPrompt,
        entryPoints: config.entryPoints
    })
    const toggleEditor = () => {
        if (isEditorActive()) {
            service.closeCodeEditor()
        } else {
            openEditor()
        }
    }
    const resolveGroupColor = (colorName: string): Color => {
        const color = (Colors as Record<string, Color>)[colorName]
        return isDefined(color) ? color : Colors.dark
    }
    const stripGroupPrefix = (group: Nullable<GroupDeclaration>, label: string): string => {
        if (!isDefined(group) || group.label.length === 0) {return label}
        const prefix = group.label
        if (label.length <= prefix.length) {return label}
        if (label.substring(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {return label}
        const suffix = label.substring(prefix.length)
        if (suffix.charAt(0) !== suffix.charAt(0).toUpperCase()) {return label}
        return suffix
    }
    const editorIcon = new DefaultObservableValue(IconSymbol.Code)
    const toggleEditorButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={toggleEditor}
                appearance={{tooltip: "Toggle Code Editor", cursor: "pointer"}}
                style={{fontSize: "14px"}}>
            <IconCartridge lifecycle={lifecycle} symbol={editorIcon}/>
        </Button>
    )
    let lastErrorMessage = ""
    const showError = (message: string): void => {
        lastErrorMessage = message
        errorIcon.classList.remove("hidden")
        errorIcon.title = message
    }
    const errorIcon: HTMLElement = (
        <div className="error hidden"
             onclick={() => Dialogs.info({
                 headline: "Script Error",
                 message: lastErrorMessage,
                 buttons: [{
                     text: "Copy to Clipboard",
                     onClick: handler => Clipboard.writeText(lastErrorMessage)
                         .then(() => Surface.get(errorIcon).toast("Error message copied to clipboard", IconSymbol.Copy))
                         .finally(() => handler.close())
                 }]
             })}>
            <Icon symbol={IconSymbol.Bug}/>
        </div>
    )
    const controlsContainer: HTMLElement = (<div className={className}/>)
    const controlsTerminator = lifecycle.own(new Terminator())
    const paramBoxesByLabel = new Map<string, WerkstattParameterBox>()
    const sampleBoxesByLabel = new Map<string, WerkstattSampleBox>()
    const sidechainBoxesByLabel = new Map<string, WerkstattSidechainBox>()
    const createParamElement = (terminator: Terminator,
                                declaration: ParamDeclaration,
                                group: Nullable<GroupDeclaration>): HTMLElement => {
        const werkstattParam = paramBoxesByLabel.get(declaration.label)
        if (!isDefined(werkstattParam)) {return <div/>}
        const parameter = adapter.parameters.parameters()
            .find(param => param.address.equals(werkstattParam.value.address))
        if (!isDefined(parameter)) {return <div/>}
        const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
        const label = stripGroupPrefix(group, declaration.label)
        return declaration.mapping === "bool"
            ? (<AutomationControl lifecycle={terminator}
                                  editing={editing}
                                  midiLearning={midiLearning}
                                  tracks={tracks}
                                  parameter={parameter}>
                <Column ems={LKR} color={Colors.cream}>
                    <h5>{label}</h5>
                    <Checkbox lifecycle={terminator}
                              model={boolModel(editing, parameter)}
                              style={{marginTop: "0.25em"}}
                              appearance={{
                                  color: Colors.cream,
                                  activeColor: Colors.blue,
                                  framed: true,
                                  cursor: "pointer"
                              }}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                </Column>
            </AutomationControl>)
            : ControlBuilder.createKnob({lifecycle: terminator, editing, midiLearning, adapter, parameter, label})
    }
    const createSampleElement = (terminator: Terminator, declaration: SampleDeclaration): HTMLElement => {
        const sample = sampleBoxesByLabel.get(declaration.label)
        if (!isDefined(sample)) {return <div/>}
        const fileNameLabel: HTMLSpanElement = (<span className="sample-name"/>)
        const dropZone: HTMLElement = (
            <div className="sample-drop">
                <Icon symbol={IconSymbol.Waveform}/>
            </div>
        )
        const sampleSelector = new SampleSelector(service, {
            isAttached: () => sample.isAttached(),
            hasSample: () => sample.file.nonEmpty(),
            replace: (replacement) => replacement.match({
                none: () => sample.file.targetVertex.ifSome(({box: fileBox}) => {
                    const mustDelete = fileBox.pointerHub.size() === 1
                    sample.file.defer()
                    if (mustDelete) {fileBox.delete()}
                }),
                some: () => SampleSelectStrategy.changePointer(sample.file, replacement)
            })
        })
        terminator.ownAll(
            sample.file.catchupAndSubscribe(pointer => pointer.targetVertex.match({
                none: () => {
                    dropZone.removeAttribute("sample")
                    fileNameLabel.textContent = ""
                },
                some: ({box: fileBox}) => {
                    const name = asInstanceOf(fileBox, AudioFileBox).fileName.getValue()
                    dropZone.setAttribute("sample", name)
                    fileNameLabel.textContent = name
                }
            })),
            sampleSelector.configureBrowseClick(dropZone),
            sampleSelector.configureContextMenu(dropZone),
            sampleSelector.configureDrop(dropZone)
        )
        return (
            <Column ems={LKR} color={Colors.cream}>
                <h5>{declaration.label}</h5>
                {dropZone}
                {fileNameLabel}
            </Column>
        )
    }
    const createSidechainElement = (terminator: Terminator, declaration: SidechainDeclaration): HTMLElement => {
        const sidechain = sidechainBoxesByLabel.get(declaration.label)
        if (!isDefined(sidechain)) {return <div/>}
        return (
            <SidechainSelector lifecycle={terminator}
                               editing={editing}
                               rootBoxAdapter={project.rootBoxAdapter}
                               sideChain={sidechain.source}
                               deviceHost={deviceHost}
                               label={declaration.label}/>
        )
    }
    const placeInGrid = (element: HTMLElement, {column, row, columns, rows}: ScriptViewLayout.Area): HTMLElement => {
        element.style.gridColumn = `${column} / span ${columns}`
        element.style.gridRow = `${row} / span ${rows}`
        return element
    }
    const createViewElement = (terminator: Terminator, view: ViewDeclaration): Nullable<HTMLElement> => {
        const area = ScriptViewLayout.visibleArea(view)
        if (!isDefined(area)) {return null}
        const frame = ScriptViews.createFrame({
            lifecycle: terminator, service, adapter, userCode: () => compiler.stripHeader(box.code.getValue()),
            className: view.className, mode: "inline", onError: showError
        })
        frame.classList.toggle("overflow", ScriptViewLayout.overflows(view))
        return placeInGrid(frame, area)
    }
    const populateSection = (terminator: Terminator, section: DeclarationSection, container: HTMLElement): void => {
        const controls: HTMLElement = (<div className="controls"/>)
        const views: Array<ViewDeclaration> = []
        for (const item of section.items) {
            switch (item.type) {
                case "param":
                    if (item.declaration.omitDefaultUi !== true) {
                        controls.appendChild(createParamElement(terminator, item.declaration, section.group))
                    }
                    break
                case "sample":
                    controls.appendChild(createSampleElement(terminator, item.declaration))
                    break
                case "sidechain":
                    controls.appendChild(createSidechainElement(terminator, item.declaration))
                    break
                case "view": {
                    const element = createViewElement(terminator, item.declaration)
                    if (isDefined(element)) {controls.appendChild(element)}
                    views.push(item.declaration)
                    break
                }
            }
        }
        for (const {area} of ScriptViewLayout.overlaps(views)) {
            const visible = ScriptViewLayout.visibleArea(area)
            if (isDefined(visible)) {controls.appendChild(placeInGrid(<div className="view-overlap"/>, visible))}
        }
        if (isDefined(section.group)) {
            const color = resolveGroupColor(section.group.color)
            controls.style.backgroundColor = color.opacity(0.03).toString()
            const group: HTMLElement = (
                <div className="group">
                    <div className="group-header" style={{backgroundColor: color.opacity(0.33).toString()}}>
                        <span>{section.group.label}</span>
                    </div>
                    {controls}
                </div>
            )
            container.appendChild(group)
        } else {
            container.appendChild(controls)
        }
    }
    const rebuildControls = () => {
        controlsTerminator.terminate()
        controlsContainer.replaceChildren()
        const sections = ScriptDeclaration.parseGroups(box.code.getValue())
        const terminator = new Terminator()
        if (sections.length === 0) {
            controlsContainer.appendChild(
                <div className="controls empty">
                    <div className="hint">Click <Icon symbol={IconSymbol.Code} style={{color: getColorFor(adapter.type).toString()}}/> to edit the script</div>
                </div>
            )
        }
        for (const section of sections) {populateSection(terminator, section, controlsContainer)}
        controlsTerminator.own(terminator)
    }
    const indexParamBoxes = () => {
        paramBoxesByLabel.clear()
        for (const pointer of box.parameters.pointerHub.incoming()) {
            const werkstattParam = asInstanceOf(pointer.box, WerkstattParameterBox)
            paramBoxesByLabel.set(werkstattParam.label.getValue(), werkstattParam)
        }
    }
    const indexSampleBoxes = () => {
        sampleBoxesByLabel.clear()
        for (const pointer of box.samples.pointerHub.incoming()) {
            const sample = asInstanceOf(pointer.box, WerkstattSampleBox)
            sampleBoxesByLabel.set(sample.label.getValue(), sample)
        }
    }
    const indexSidechainBoxes = () => {
        sidechainBoxesByLabel.clear()
        for (const pointer of adapter.sideChains?.pointerHub.incoming() ?? []) {
            const sidechain = asInstanceOf(pointer.box, WerkstattSidechainBox)
            sidechainBoxesByLabel.set(sidechain.label.getValue(), sidechain)
        }
    }
    const rebuildNow = () => {
        indexParamBoxes()
        indexSampleBoxes()
        indexSidechainBoxes()
        rebuildControls()
    }
    // one rebuild per change: a compile adds its param, sample and sidechain boxes one by one
    const rebuild = {pending: false, alive: true}
    const scheduleRebuild = () => {
        if (rebuild.pending) {return}
        rebuild.pending = true
        queueMicrotask(() => {
            rebuild.pending = false
            if (rebuild.alive) {rebuildNow()}
        })
    }
    lifecycle.ownAll(
        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), showError),
        Terminable.create(() => rebuild.alive = false),
        {
            terminate: () => {
                const replaced = codeEditorHandover.replaced.delete(UUID.toString(adapter.uuid))
                if (isEditorActive() && !replaced) {service.closeCodeEditor()}
            }
        },
        adapter.codeChanged.subscribe(() => {
            compiler.load(service.audioContext, box).finally(EmptyExec)
        }),
        service.activeCodeEditor.catchupAndSubscribe(option => {
            const isActive = option.map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
            editorIcon.setValue(isActive ? IconSymbol.CodeClose : IconSymbol.Code)
        }),
        box.parameters.pointerHub.subscribe({onAdded: scheduleRebuild, onRemoved: scheduleRebuild}),
        box.samples.pointerHub.subscribe({onAdded: scheduleRebuild, onRemoved: scheduleRebuild}),
        box.code.subscribe(scheduleRebuild),
        box.code.subscribe(() => {
            errorIcon.classList.add("hidden")
            errorIcon.title = ""
        })
    )
    if (isDefined(adapter.sideChains)) {
        lifecycle.own(adapter.sideChains.pointerHub.subscribe({onAdded: scheduleRebuild, onRemoved: scheduleRebuild}))
    }
    rebuildNow()
    if (codeEditorHandover.opening.delete(UUID.toString(adapter.uuid))) {
        queueMicrotask(() => {if (rebuild.alive && !isEditorActive()) {openEditor()}})
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          config.populateMenu(parent, service, deviceHost, adapter)
                          const windows = tryCatch(() => ScriptDeclaration.parseWindows(box.code.getValue()))
                          if (windows.status === "failure") {return}
                          windows.value.forEach(({className}, index) => parent.addMenuItem(MenuItem.default({
                              label: `${className} Window`, checked: ScriptWindows.isOpen(adapter, className), separatorBefore: index === 0
                          }).setTriggerProcedure(() => ScriptWindows.isOpen(adapter, className)
                              ? ScriptWindows.close(adapter, className)
                              : ScriptWindows.open(service, adapter, () => compiler.stripHeader(box.code.getValue()), className))))
                      }}
                      populateControls={() => controlsContainer}
                      populateHeader={() => [errorIcon, toggleEditorButton]}
                      populateMeter={() => config.populateMeter({lifecycle, service, adapter})}
                      icon={config.icon}/>
    )
}
