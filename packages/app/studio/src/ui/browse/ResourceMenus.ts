import {Exec, Func, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {MenuItem, ResourceStructureFolder} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {LocalTree} from "@/ui/browse/LocalTree"
import {FolderDialogs} from "@/ui/browse/FolderDialogs"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"

export namespace ResourceMenus {
    export const moveTo = <T>(tree: LocalTree<T>,
                              uuids: ReadonlyArray<UUID.String>,
                              refresh: Exec): MenuItem => {
        const move = async (path: string) => {
            await tree.move(uuids, path)
            refresh()
        }
        const moveIntoNewFolder = async (parentPath: string) => {
            const {status, value: name} = await Promises.tryCatch(
                FolderDialogs.showNameDialog("New Folder", "Create", "untitled folder"))
            if (status === "rejected") {return}
            return move(LocalTree.path(parentPath, await tree.createFolder(parentPath, name)))
        }
        const destination = (parent: MenuItem,
                             path: string,
                             folders: ReadonlyArray<ResourceStructureFolder>): void => {
            parent.addMenuItem(
                MenuItem.header({
                    label: path.length === 0 ? "Root" : path,
                    icon: IconSymbol.FolderOpen,
                    color: Colors.orange
                }),
                MenuItem.default({label: "Drop Here", icon: IconSymbol.FolderOpen})
                    .setTriggerProcedure(() => move(path)),
                MenuItem.default({label: "Create new Folder…", icon: IconSymbol.FolderAdd})
                    .setTriggerProcedure(() => moveIntoNewFolder(path)))
            folders.forEach((folder, index) => {
                const folderPath = LocalTree.path(path, folder.name)
                parent.addMenuItem(MenuItem.default({
                    label: folder.name,
                    icon: IconSymbol.Folder,
                    separatorBefore: index === 0
                }).setRuntimeChildrenProcedure(sub => destination(sub, folderPath, folder.folders ?? [])))
            })
        }
        return MenuItem.default({label: "Move to Root…", icon: IconSymbol.FolderOpen})
            .setRuntimeChildrenProcedure(parent => destination(parent, "", tree.folders))
    }

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
        MenuItem.header({label: LocalTree.TrashName, icon: IconSymbol.Delete, color: Colors.orange}),
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

    export const folder = <T>(tree: LocalTree<T>, path: string, refresh: Exec): ReadonlyArray<MenuItem> => {
        const name = LocalTree.nameOf(path)
        return [
            MenuItem.header({label: name, icon: IconSymbol.Folder, color: Colors.orange}),
            MenuItem.default({label: "New Folder…", icon: IconSymbol.FolderAdd})
                .setTriggerProcedure(() => createFolder(tree, path, refresh)),
            MenuItem.default({label: "Rename…", icon: IconSymbol.Pencil})
                .setTriggerProcedure(async () => {
                    const {status, value: renamed} = await Promises.tryCatch(
                        FolderDialogs.showNameDialog("Rename Folder", "Rename", name))
                    if (status === "rejected") {return}
                    await tree.renameFolder(path, renamed)
                    refresh()
                }),
            MenuItem.default({label: "Move to Trash", icon: IconSymbol.Delete, separatorBefore: true})
                .setTriggerProcedure(async () => {
                    await tree.trashFolder(path)
                    refresh()
                })
        ]
    }
}
