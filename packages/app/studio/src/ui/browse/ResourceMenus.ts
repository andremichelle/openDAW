import {Exec, Func, int, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {MenuItem, ResourceStructureFolder} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {LocalTree} from "@/ui/browse/LocalTree"
import {FolderDialogs} from "@/ui/browse/FolderDialogs"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"
import {Dialogs} from "@/ui/components/dialogs"

export namespace ResourceMenus {
    // The destination tree is built when the submenu opens, not when the menu is created, so it always shows
    // the current structure and never a stale copy of it. A folder that has children becomes a submenu, with
    // an "Into" entry so the folder itself stays reachable.
    export const moveTo = <T>(tree: LocalTree<T>,
                              uuids: ReadonlyArray<UUID.String>,
                              refresh: Exec): MenuItem => {
        const move = async (path: string) => {
            await tree.move(uuids, path)
            refresh()
        }
        const populate = (parent: MenuItem, folders: ReadonlyArray<ResourceStructureFolder>, path: string): void =>
            folders.forEach(folder => {
                const folderPath = LocalTree.path(path, folder.name)
                const item = MenuItem.default({label: folder.name, icon: IconSymbol.Folder})
                    .setTriggerProcedure(() => move(folderPath))
                const children = folder.folders ?? []
                if (children.length > 0) {
                    item.setRuntimeChildrenProcedure(sub => {
                        sub.addMenuItem(MenuItem.default({label: `Into "${folder.name}"`})
                            .setTriggerProcedure(() => move(folderPath)))
                        populate(sub, children, folderPath)
                    })
                }
                parent.addMenuItem(item)
            })
        return MenuItem.default({label: "Move to", icon: IconSymbol.Folder})
            .setRuntimeChildrenProcedure(parent => {
                parent.addMenuItem(MenuItem.default({label: "Root"}).setTriggerProcedure(() => move("")))
                populate(parent, tree.folders, "")
            })
    }

    // What a local row can do with itself. Trashing is free and asks nothing, because it takes nothing away:
    // the files stay until someone empties the trash, and that is the step that asks.
    export const itemActions = <T>(tree: LocalTree<T>,
                                   selection: ResourceSelection<T>,
                                   targets: ReadonlyArray<T>,
                                   uuidOf: Func<T, UUID.String>,
                                   refresh: Exec): ReadonlyArray<MenuItem> => {
        const uuids = targets.map(uuidOf)
        const trashed = uuids.length > 0 && uuids.every(uuid => tree.isTrashed(uuid))
        if (trashed) {
            return [
                MenuItem.default({label: "Put Back", icon: IconSymbol.Undo, separatorBefore: true})
                    .setTriggerProcedure(async () => {
                        await tree.restore(uuids)
                        refresh()
                    }),
                MenuItem.default({label: "Delete Forever…", icon: IconSymbol.Delete})
                    .setTriggerProcedure(() => deleteForever(tree, selection, targets, uuidOf, refresh))
            ]
        }
        return [
            moveTo(tree, uuids, refresh),
            MenuItem.default({label: "Move to Trash", icon: IconSymbol.Delete, separatorBefore: true})
                .setTriggerProcedure(async () => {
                    await tree.trash(uuids)
                    refresh()
                })
        ]
    }

    const deleteForever = async <T>(tree: LocalTree<T>,
                                    selection: ResourceSelection<T>,
                                    targets: ReadonlyArray<T>,
                                    uuidOf: Func<T, UUID.String>,
                                    refresh: Exec): Promise<void> => {
        const deleted = await selection.deleteItems(targets)
        await tree.forget(deleted.map(uuidOf))
        refresh()
    }

    export const trashFolder = <T>(tree: LocalTree<T>,
                                   selection: ResourceSelection<T>,
                                   items: ReadonlyArray<T>,
                                   uuidOf: Func<T, UUID.String>,
                                   refresh: Exec): ReadonlyArray<MenuItem> => [
        MenuItem.header({label: LocalTree.TrashName, icon: IconSymbol.Delete}),
        MenuItem.default({label: "Empty Trash…", icon: IconSymbol.Delete, selectable: items.length > 0})
            .setTriggerProcedure(() => deleteForever(tree, selection, items, uuidOf, refresh))
    ]

    const createFolder = async <T>(tree: LocalTree<T>, parentPath: string, refresh: Exec): Promise<void> => {
        const {status, value: name} = await Promises.tryCatch(
            FolderDialogs.showNameDialog("New Folder", "Create", "untitled folder"))
        if (status === "rejected") {return}
        await tree.createFolder(parentPath, name)
        refresh()
    }

    export const folder = <T>(tree: LocalTree<T>,
                              path: string,
                              count: int,
                              refresh: Exec): ReadonlyArray<MenuItem> => {
        const name = LocalTree.nameOf(path)
        return [
            MenuItem.header({label: name, icon: IconSymbol.Folder}),
            MenuItem.default({label: "New Folder…", icon: IconSymbol.Add})
                .setTriggerProcedure(() => createFolder(tree, path, refresh)),
            MenuItem.default({label: "Rename…", icon: IconSymbol.Pencil})
                .setTriggerProcedure(async () => {
                    const {status, value: renamed} = await Promises.tryCatch(
                        FolderDialogs.showNameDialog("Rename Folder", "Rename", name))
                    if (status === "rejected") {return}
                    await tree.renameFolder(path, renamed)
                    refresh()
                }),
            // Deleting a folder never deletes what is in it: an empty one goes without asking, a full one
            // asks and then hands its contents to the level above.
            MenuItem.default({label: "Delete Folder", icon: IconSymbol.Delete, separatorBefore: true})
                .setTriggerProcedure(async () => {
                    if (count > 0) {
                        const approved = await Dialogs.approve({
                            headline: "Delete Folder",
                            message: `"${name}" still holds ${count} item(s).\n\nThey move up one level.`,
                            approveText: "Move Up"
                        })
                        if (!approved) {return}
                    }
                    await tree.deleteFolder(path)
                    refresh()
                })
        ]
    }

    export const background = <T>(tree: LocalTree<T>, refresh: Exec): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "New Folder in Root…", icon: IconSymbol.Add})
            .setTriggerProcedure(() => createFolder(tree, "", refresh))
    ]
}
