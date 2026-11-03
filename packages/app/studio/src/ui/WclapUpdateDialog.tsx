import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Errors, Lifecycle, MutableObservableValue, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {WclapUpdates} from "@/service/WclapUpdates"
import {Dialogs} from "@/ui/components/dialogs"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

// Moves every project to the newer builds of its WebCLAP plugins and deletes the old builds no project uses anymore
export namespace WclapUpdateDialog {
    // resolves true when nothing is left to update
    export const open = async (service: StudioService): Promise<boolean> => {
        const outdated = await WclapUpdates.find()
        if (outdated.length === 0) {return true}
        const update = new DefaultObservableValue(true)
        const deleteOld = new DefaultObservableValue(true)
        const lifecycle = new Terminator()
        const names = Array.from(new Set(outdated.map(({successor}) => successor.name))).toSorted()
        const shown = await Promises.tryCatch(Dialogs.show({
            headline: "Update WebCLAP Plugins",
            content: (
                <div style={{display: "flex", flexDirection: "column", rowGap: "0.75em", maxWidth: "24em"}}>
                    <p>Newer builds are in the openDAW cloud:<br/>
                        <span style={{color: Colors.orange.toString()}}>{names.join(", ")}</span>
                    </p>
                    <Toggle lifecycle={lifecycle} model={update}
                            text="Update the plugins in all projects and templates"/>
                    <Toggle lifecycle={lifecycle} model={deleteOld}
                            text="Delete the old builds no project uses anymore"/>
                </div>
            ),
            okText: "Update"
        }))
        lifecycle.terminate()
        if (shown.status === "rejected") {
            if (Errors.isAbort(shown.error)) {return false}
            throw shown.error
        }
        if (!update.getValue() && !deleteOld.getValue()) {return false}
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Updating WebCLAP Plugins", progress})
        const result = await Promises.tryCatch(WclapUpdates.run(service, outdated,
            {update: update.getValue(), deleteOld: deleteOld.getValue()}, value => progress.setValue(value)))
        dialog.terminate()
        if (result.status === "rejected") {
            await RuntimeNotifier.info({headline: "Update Failed", message: String(result.error)})
            return false
        }
        const {projects, presets, devices, deleted, kept} = result.value
        const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`
        RuntimeNotifier.notify({
            message: `Updated ${plural(devices, "device")} in ${plural(projects, "project")}`
                + (presets > 0 ? ` and ${plural(presets, "preset")}` : "")
                + (deleteOld.getValue() ? `, deleted ${plural(deleted, "old build")}` : "")
                + ".",
            icon: "Info"
        })
        if (kept.length > 0) {
            await RuntimeNotifier.info({
                headline: "Old Builds Still In Use",
                message: kept.map(({name, users}) => `${name}: ${users.join(", ")}`).join("\n")
            })
        }
        return (await WclapUpdates.find()).length === 0
    }

    const Toggle = ({lifecycle, model, text}: {
        lifecycle: Lifecycle, model: MutableObservableValue<boolean>, text: string
    }) => (
        <div style={{display: "flex", alignItems: "center", columnGap: "0.5em"}}>
            <Checkbox lifecycle={lifecycle} model={model} appearance={{framed: true, color: Colors.black}}>
                <Icon symbol={IconSymbol.Checkbox}/>
            </Checkbox>
            <span style={{cursor: "pointer"}} onclick={() => model.setValue(!model.getValue())}>{text}</span>
        </div>
    )
}
