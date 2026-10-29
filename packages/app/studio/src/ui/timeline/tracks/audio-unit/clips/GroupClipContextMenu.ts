import {EmptyExec, int} from "@opendaw/lib-std"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {ColorMenu} from "@/ui/timeline/ColorMenu"
import {Surface} from "@/ui/surface/Surface"
import {NameValidator} from "@/ui/validator/name"
import {GroupClipAppearance} from "./GroupClipAppearance"
import {GroupClipLauncher} from "./GroupClipLauncher"

export const installGroupClipContextMenu = (element: HTMLElement, launcher: GroupClipLauncher, index: int) =>
    ContextMenu.subscribe(element, collector => {
        const clips = launcher.clips(index)
        const appearance = GroupClipAppearance.read(launcher.group, index)
        collector.addItems(
            MenuItem.default({label: "Delete", selectable: clips.length > 0 || appearance.label !== "" || appearance.hue !== 200})
                .setTriggerProcedure(() => launcher.delete(index)),
            MenuItem.default({label: "Rename"})
                .setTriggerProcedure(() => Surface.get(element).requestFloatingTextInput(collector.client,
                    GroupClipAppearance.read(launcher.group, index).label).then(value => NameValidator.validate(value, {
                        success: name => launcher.rename(index, name)
                    }), EmptyExec)),
            MenuItem.default({label: "Mute", checked: launcher.isMuted(index), selectable: clips.length > 0})
                .setTriggerProcedure(() => launcher.setMuted(index, !launcher.isMuted(index))),
            ColorMenu.createItem(hue => launcher.setColor(index, hue)),
            MenuItem.default({label: "Consolidate", selectable: clips.some(clip => clip.isMirrowed)})
                .setTriggerProcedure(() => launcher.consolidate(index)),
            MenuItem.default({label: "Trigger", selectable: clips.length > 0})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({label: "Loop", checked: launcher.isLooping(index)})
                        .setTriggerProcedure(() => launcher.setLooping(index, !launcher.isLooping(index)))
                ))
        )
    })
