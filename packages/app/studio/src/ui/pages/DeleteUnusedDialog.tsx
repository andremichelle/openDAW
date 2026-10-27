import css from "./DeleteUnusedDialog.sass?inline"
import {Bytes, DefaultObservableValue, Errors, Lifecycle, MutableObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Surface} from "@/ui/surface/Surface"
import {StorageScan} from "@/storage/StorageScan"
import {StorageReport} from "@/storage/StorageReport"

const className = Html.adoptStyleSheet(css, "DeleteUnusedDialog")

const KindLabels: Record<StorageScan.AssetKind, string> = {
    "sample": "Samples", "soundfont": "Soundfonts", "wclap": "WebCLAP plugins"
}

const Toggle = ({lifecycle, model}: { lifecycle: Lifecycle, model: MutableObservableValue<boolean> }) => (
    <Checkbox lifecycle={lifecycle} model={model} appearance={{framed: true, color: Colors.black}}>
        <Icon symbol={IconSymbol.Checkbox}/>
    </Checkbox>
)

export namespace DeleteUnusedDialog {
    export const show = (unused: ReadonlyArray<StorageScan.Asset>, consequence: string): Promise<ReadonlyArray<StorageScan.Asset>> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<ReadonlyArray<StorageScan.Asset>>()
        promise.finally(() => lifecycle.terminate())
        const kinds = StorageReport.AssetKinds
            .map(kind => ({kind, assets: unused.filter(asset => asset.kind === kind)}))
            .filter(({assets}) => assets.length > 0)
            .map(({kind, assets}) => ({kind, assets, model: lifecycle.own(new DefaultObservableValue(true))}))
        const rows = unused.map(asset => ({asset, model: lifecycle.own(new DefaultObservableValue(true))}))
        const selection = (): ReadonlyArray<StorageScan.Asset> => rows
            .filter(({asset, model}) => model.getValue() && kinds.some(entry => entry.kind === asset.kind && entry.model.getValue()))
            .map(({asset}) => asset)
        const nothingSelected = lifecycle.own(new DefaultObservableValue(false))
        const total: HTMLElement = <div className="total"/>
        const list: HTMLElement = (
            <div className="list">
                {rows.map(({asset, model}) => (
                    <div className="row" data-kind={asset.kind}>
                        <Toggle lifecycle={lifecycle} model={model}/>
                        <span className="name" title={asset.id} onclick={() => model.setValue(!model.getValue())}>
                            {asset.name}
                        </span>
                        <span className="library" title="Can be downloaded again from the openDAW library">
                            {asset.origin === "openDAW" ? "library" : ""}
                        </span>
                        <span className="size">{Bytes.toString(asset.size)}</span>
                    </div>
                ))}
            </div>
        )
        const refresh = (): void => {
            kinds.forEach(({kind, model}) => list.querySelectorAll(`[data-kind="${kind}"]`)
                .forEach(row => row.classList.toggle("hidden", !model.getValue())))
            const selected = selection()
            total.textContent = `${selected.length} of ${unused.length} selected (${Bytes.toString(StorageReport.sizeOf(selected))})`
            nothingSelected.setValue(selected.length === 0)
        }
        lifecycle.ownAll(...[...kinds, ...rows].map(({model}) => model.subscribe(refresh)))
        refresh()
        const dialog: HTMLDialogElement = (
            <Dialog headline="Delete Unused"
                    icon={IconSymbol.Delete}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => handler.close()
                    }, {
                        text: "Delete",
                        primary: true,
                        disabled: nothingSelected,
                        onClick: handler => {
                            resolve(selection())
                            handler.close()
                        }
                    }]}>
                <div className={className}>
                    <div className="kinds">
                        {kinds.map(({kind, assets, model}) => (
                            <div className="option">
                                <Toggle lifecycle={lifecycle} model={model}/>
                                <span onclick={() => model.setValue(!model.getValue())}>
                                    {`${KindLabels[kind]} (${assets.length}, ${Bytes.toString(StorageReport.sizeOf(assets))})`}
                                </span>
                            </div>
                        ))}
                    </div>
                    {list}
                    {total}
                    <div className="note">{consequence}</div>
                </div>
            </Dialog>
        )
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
