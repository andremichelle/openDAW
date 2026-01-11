import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {IconSymbol} from "@opendaw/studio-enums"
import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, Terminator} from "@opendaw/lib-std"
import {Button} from "@/ui/components/Button"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"

export interface VideoExportConfig {
    readonly width: number
    readonly height: number
    readonly frameRate: number
    readonly sampleRate: number
    readonly previewDuration: number
}

type DimensionPreset = {
    readonly label: string
    readonly width: number
    readonly height: number
}

const PRESETS: ReadonlyArray<DimensionPreset> = [
    {label: "HD", width: 1280, height: 720},
    {label: "Full HD", width: 1920, height: 1080},
    {label: "4K", width: 3840, height: 2160},
    {label: "Vertical", width: 1080, height: 1920}
]

const FPS_OPTIONS: ReadonlyArray<number> = [30, 60, 120]

export const showVideoExportDialog = async (sampleRate: number): Promise<VideoExportConfig> => {
    const {resolve, reject, promise} = Promise.withResolvers<VideoExportConfig>()
    const lifecycle = new Terminator()

    const widthModel = new DefaultObservableValue(1280)
    const heightModel = new DefaultObservableValue(720)
    const fpsModel = new DefaultObservableValue(60)
    const previewModel = new DefaultObservableValue(0)

    const setDimensions = (width: number, height: number): void => {
        widthModel.setValue(width)
        heightModel.setValue(height)
    }

    const dialog: HTMLDialogElement = (
        <Dialog headline="Export Video"
                icon={IconSymbol.Film}
                style={{minWidth: "24em"}}
                buttons={[
                    {
                        text: "Cancel",
                        onClick: handler => {
                            handler.close()
                            reject(Errors.AbortError)
                        }
                    },
                    {
                        text: "Export",
                        primary: true,
                        onClick: handler => {
                            handler.close()
                            resolve({
                                width: widthModel.getValue(),
                                height: heightModel.getValue(),
                                frameRate: fpsModel.getValue(),
                                sampleRate,
                                previewDuration: previewModel.getValue()
                            })
                        }
                    }
                ]}
                cancelable={true}>
            <div style={{padding: "1em 0", display: "flex", flexDirection: "column", gap: "1em"}}>
                <div>
                    <div style={{marginBottom: "0.5em", fontWeight: "bold"}}>Dimensions</div>
                    <div style={{display: "flex", gap: "0.5em", alignItems: "center"}}>
                        <NumberInput lifecycle={lifecycle} model={widthModel} maxChars={5}/>
                        <span>×</span>
                        <NumberInput lifecycle={lifecycle} model={heightModel} maxChars={5}/>
                        <span style={{opacity: "0.5"}}>px</span>
                    </div>
                    <div style={{display: "flex", gap: "0.25em", flexWrap: "wrap", marginTop: "0.5em"}}>
                        {PRESETS.map(preset => (
                            <Button lifecycle={lifecycle}
                                    onClick={() => setDimensions(preset.width, preset.height)}>
                                <span>{preset.label}</span>
                            </Button>
                        ))}
                    </div>
                </div>
                <div>
                    <div style={{marginBottom: "0.5em", fontWeight: "bold"}}>Frame Rate</div>
                    <div style={{display: "flex", gap: "0.5em", alignItems: "center", fontSize: "10px"}}>
                        <RadioGroup lifecycle={lifecycle}
                                    model={fpsModel}
                                    elements={FPS_OPTIONS.map(fps => ({value: fps, element: <span>{fps}</span>}))}/>
                        <span style={{opacity: "0.5"}}>fps</span>
                    </div>
                </div>
                <div>
                    <div style={{marginBottom: "0.5em", fontWeight: "bold"}}>Preview Duration</div>
                    <div style={{display: "flex", gap: "0.5em", alignItems: "center"}}>
                        <NumberInput lifecycle={lifecycle} model={previewModel} maxChars={4}/>
                        <span style={{opacity: "0.5"}}>seconds (0 = full)</span>
                    </div>
                </div>
            </div>
        </Dialog>
    )
    dialog.oncancel = () => reject(Errors.AbortError)
    Surface.get().flyout.appendChild(dialog)
    dialog.showModal()
    return promise.finally(() => lifecycle.terminate())
}
