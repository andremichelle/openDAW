import css from "./ComponentsPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {DefaultObservableValue, Option, panic, UUID} from "@moises-ai/lib-std"
import {Icon} from "@/ui/components/Icon.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {MenuItem} from "@moises-ai/studio-core"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Dialog} from "@/ui/components/Dialog.tsx"
import {Orientation, Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {TimeCodeInput} from "@/ui/components/TimeCodeInput.tsx"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {VUMeterDesign} from "@/ui/meter/VUMeterDesign.tsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {dbToGain} from "@moises-ai/lib-dsp"
import {RootBox, TimelineBox} from "@moises-ai/studio-boxes"
import {BoxGraph} from "@moises-ai/lib-box"
import {BoxDebugView} from "../components/BoxDebugView"
import {ProgressBar} from "@/ui/components/ProgressBar.tsx"
import {TextInput} from "../components/TextInput"
import {SearchInput} from "../components/SearchInput"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "ComponentsPage")

export const ComponentsPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    const checkbox = new DefaultObservableValue(false)
    const radioGroup = new DefaultObservableValue(0)

    const boxGraph = new BoxGraph(Option.None)
    boxGraph.beginTransaction()
    const rootBox = RootBox.create(boxGraph, UUID.generate(), box => box.created.setValue(new Date().toISOString()))
    const timelineBox = TimelineBox.create(boxGraph, UUID.generate(), _box => {
    })
    rootBox.timeline.refer(timelineBox.root)
    boxGraph.endTransaction()
    return (
        <div className={className}>
            <div>
                <h1>Components</h1>
                <div>
                    <label>Button</label>
                    <Button lifecycle={lifecycle} onClick={() => {}}
                            appearance={{activeColor: Colors.bright}}>
                        <Icon symbol={IconSymbol.Play}/>
                    </Button>
                    <label>Button (framed)</label>
                    <Button lifecycle={lifecycle} onClick={() => {}}
                            appearance={{activeColor: Colors.bright, framed: true}}>
                        <Icon symbol={IconSymbol.Play}/>
                    </Button>
                    <label>ProgressBar</label>
                    <ProgressBar lifecycle={lifecycle} progress={new DefaultObservableValue(0.5)}/>
                    <label>Checkbox</label>
                    <Checkbox lifecycle={lifecycle}
                              model={checkbox}
                              appearance={{activeColor: Colors.green, framed: false}}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                    <label>Checkbox (framed)</label>
                    <Checkbox lifecycle={lifecycle}
                              model={checkbox}
                              appearance={{activeColor: Colors.yellow, framed: true}}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                    <label>RadioGroup</label>
                    <RadioGroup lifecycle={lifecycle}
                                model={radioGroup}
                                elements={
                                    [
                                        {value: 0, element: <Icon symbol={IconSymbol.Flask}/>},
                                        {value: 1, element: <Icon symbol={IconSymbol.Waveform}/>},
                                        {value: 2, element: <Icon symbol={IconSymbol.Dial}/>}
                                    ]
                                }/>
                    <label>RadioGroup (framed)</label>
                    <RadioGroup lifecycle={lifecycle}
                                model={radioGroup}
                                elements={
                                    [
                                        {value: 0, element: <Icon symbol={IconSymbol.Flask}/>},
                                        {value: 1, element: <Icon symbol={IconSymbol.Waveform}/>},
                                        {value: 2, element: <Icon symbol={IconSymbol.Dial}/>}
                                    ]
                                }
                                appearance={{activeColor: Colors.yellow, framed: true}}/>
                    <label>Time-Code Input (Zero-Based)</label>
                    <TimeCodeInput lifecycle={lifecycle} model={new DefaultObservableValue(0)}/>
                    <label>Time-Code Input (One-Based)</label>
                    <TimeCodeInput lifecycle={lifecycle} model={new DefaultObservableValue(0)} oneBased/>
                    <label>Time-Code Input (One-Based, 3/4)</label>
                    <TimeCodeInput lifecycle={lifecycle} signature={[3, 4]} model={new DefaultObservableValue(0)}
                                   oneBased/>
                    <label>Time-Code Input (One-Based, 3/4) disabled</label>
                    <TimeCodeInput lifecycle={lifecycle} signature={[3, 4]}
                                   model={new DefaultObservableValue(0)}
                                   className="disabled"
                                   oneBased/>
                    <label>IntegerInput Input</label>
                    <NumberInput lifecycle={lifecycle} model={new DefaultObservableValue(0)}/>
                    <label>IntegerInput Input (disabled)</label>
                    <NumberInput lifecycle={lifecycle} model={new DefaultObservableValue(0)}
                                 className="disabled"/>
                    <label>TextInput</label>
                    <TextInput lifecycle={lifecycle} model={new DefaultObservableValue("Text")}/>
                    <label>SearchField</label>
                    <SearchInput lifecycle={lifecycle} model={new DefaultObservableValue("")}/>
                    <label>Scroller</label>
                    <div style={{
                        width: "128px",
                        height: "128px",
                        position: "relative",
                        backgroundColor: "rgba(255, 255, 255, 0.1)"
                    }}>
                        <Scroller lifecycle={lifecycle} model={(() => {
                            const model = new ScrollModel()
                            model.visibleSize = 128
                            model.contentSize = 128 * 2
                            model.trackSize = 128
                            return model
                        })()} orientation={Orientation.vertical} floating/>
                        <Scroller lifecycle={lifecycle} model={(() => {
                            const model = new ScrollModel()
                            model.visibleSize = 128
                            model.contentSize = 128 * 2
                            model.trackSize = 128
                            return model
                        })()} orientation={Orientation.horizontal} floating/>
                    </div>
                    <label>Meters</label>
                    <div>
                        <VUMeterDesign.Default model={new DefaultObservableValue(dbToGain(-6))}/>
                        <VUMeterDesign.Modern model={new DefaultObservableValue(dbToGain(-6))}/>
                    </div>
                </div>
            </div>
            <div>
                <h1>Debug</h1>
                <div style={{display: "flex", flexDirection: "column"}}>
                    <BoxDebugView box={timelineBox}/>
                    <BoxDebugView box={rootBox}/>
                </div>
            </div>
            <div>
                <h1>Menu / Dropdown</h1>
                <div>
                    <label>MenuButton</label>
                    <MenuButton root={TestMenuItem}
                                appearance={{
                                    color: Colors.yellow,
                                    activeColor: Colors.green,
                                    tooltip: "Open Test-Menu",
                                    framed: false
                                }}>
                        <Icon symbol={IconSymbol.Add}/>
                    </MenuButton>
                    <label>MenuButton (framed)</label>
                    <MenuButton root={TestMenuItem}
                                appearance={{
                                    color: Colors.yellow,
                                    activeColor: Colors.green,
                                    tooltip: "Open Test-Menu",
                                    framed: true
                                }}><Icon symbol={IconSymbol.Add}/></MenuButton>
                    <label>MenuButton (label)</label>
                    <MenuButton root={TestMenuItem}
                                appearance={{
                                    activeColor: Colors.bright,
                                    tooltip: "Open Test-Menu"
                                }}>
                        <label>select<Icon symbol={IconSymbol.Dropdown}/></label>
                    </MenuButton>
                    <label>MenuButton (label, framed)</label>
                    <MenuButton root={TestMenuItem}
                                appearance={{
                                    activeColor: Colors.gray,
                                    tooltip: "Open Test-Menu",
                                    framed: true
                                }}>
                        <label>
                            <span>select</span>
                            <Icon symbol={IconSymbol.Dropdown}/>
                        </label>
                    </MenuButton>
                    <label>MenuButton (tiny triangle)</label>
                    <MenuButton root={TestMenuItem}
                                appearance={{
                                    activeColor: Colors.gray,
                                    tooltip: "Open Test-Menu",
                                    tinyTriangle: true
                                }}>
                        <label><span>select</span></label>
                    </MenuButton>
                </div>
            </div>
            <div>
                <h1>Flying</h1>
                <div>
                    <label>TextInput</label>
                    <FloatingTextInput/>
                    <label>TextInput (with unit)</label>
                    <FloatingTextInput unit="db"/>
                    <label>TextInput (with value & unit)</label>
                    <FloatingTextInput value={50} unit="%"/>
                    <label>Dialog (simple)</label>
                    <Button lifecycle={lifecycle} onClick={() => {
                        const dialog: HTMLDialogElement = (
                            <Dialog headline="Dialog Headline" icon={IconSymbol.Effects}>
                                <p>This is the message of the dialog</p>
                            </Dialog>
                        )
                        document.body.appendChild(dialog)
                        dialog.showModal()
                    }}>Open</Button>
                    <label>Dialog (with buttons, cancelable)</label>
                    <Button lifecycle={lifecycle} onClick={() => {
                        const dialog: HTMLDialogElement = (
                            <Dialog headline="Dialog Headline"
                                    icon={IconSymbol.Effects}
                                    cancelable={true}
                                    buttons={[
                                        {primary: false, onClick: handler => handler.close(), text: "Cancel"},
                                        {primary: true, onClick: handler => handler.close(), text: "Ok"}
                                    ]}>
                                <p>This is the message of the dialog</p>
                            </Dialog>
                        )
                        document.body.appendChild(dialog)
                        dialog.showModal()
                    }}>Open</Button>
                    <label>Dialog (Error)</label>
                    <Button lifecycle={lifecycle} onClick={() => panic("I have thrown an error")}>Throw</Button>
                </div>
            </div>
        </div>
    )
}

const TestMenuItem = MenuItem.root()
    .addMenuItem(
        MenuItem.default({label: "Menu Item 1"}),
        MenuItem.default({label: "Menu Item 2"}),
        MenuItem.default({label: "Menu Item 3"}),
        MenuItem.default({label: "Menu Item 4"}),
        MenuItem.default({label: "Menu Item 5"})
            .addMenuItem(
                MenuItem.default({label: "Menu Item 1"}),
                MenuItem.default({label: "Menu Item 2"}),
                MenuItem.default({label: "Menu Item 3"}),
                MenuItem.default({label: "Menu Item 4"}),
                MenuItem.default({label: "Menu Item 5"})
                    .addMenuItem(
                        MenuItem.default({label: "Menu Item 1"}),
                        MenuItem.default({label: "Menu Item 2"}),
                        MenuItem.default({label: "Menu Item 3"}),
                        MenuItem.default({label: "Menu Item 4"}),
                        MenuItem.default({label: "Menu Item 5"})
                            .setRuntimeChildrenProcedure(parent => {
                                for (let i = 0; i < 250; i++) {
                                    parent.addMenuItem(MenuItem.default({label: `#${i + 1}`}))
                                }
                            })
                    )
            )
    )