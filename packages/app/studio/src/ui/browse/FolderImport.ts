import {Arrays, isDefined} from "@opendaw/lib-std"

export namespace FolderImport {
    export type Entry = { readonly file: File, readonly folder: string }

    const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile
    const isDirectoryEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory
    const isHidden = (name: string): boolean => name.startsWith(".")
    const join = (folder: string, name: string): string => folder.length === 0 ? name : `${folder}/${name}`

    export const hasFolder = (entries: ReadonlyArray<FileSystemEntry>): boolean => entries.some(isDirectoryEntry)

    // readEntries delivers a directory in batches (Chrome: 100 per call) until it returns an empty one
    const readAll = async (directory: FileSystemDirectoryEntry): Promise<ReadonlyArray<FileSystemEntry>> => {
        const reader = directory.createReader()
        const all: Array<FileSystemEntry> = []
        while (true) {
            const batch = await new Promise<ReadonlyArray<FileSystemEntry>>((resolve, reject) =>
                reader.readEntries(resolve, reject))
            if (batch.length === 0) {return all}
            all.push(...batch)
        }
    }

    const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
        new Promise((resolve, reject) => entry.file(resolve, reject))

    export const fromEntries = async (entries: ReadonlyArray<FileSystemEntry>): Promise<ReadonlyArray<Entry>> => {
        const collected: Array<Entry> = []
        const visit = async (entry: FileSystemEntry, folder: string): Promise<void> => {
            if (isHidden(entry.name)) {return}
            if (isFileEntry(entry)) {
                collected.push({file: await fileOf(entry), folder})
            } else if (isDirectoryEntry(entry)) {
                const path = join(folder, entry.name)
                for (const child of await readAll(entry)) {await visit(child, path)}
            }
        }
        for (const entry of entries) {await visit(entry, "")}
        return collected
    }

    export const fromRelativePaths = (files: ReadonlyArray<File>): ReadonlyArray<Entry> => files
        .map(file => ({file, parts: (file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name).split("/")}))
        .filter(({parts}) => !parts.some(isHidden))
        .map(({file, parts}) => ({file, folder: parts.slice(0, -1).join("/")}))

    export const byFolder = (entries: ReadonlyArray<Entry>): ReadonlyArray<[string, ReadonlyArray<File>]> => {
        const groups = new Map<string, Array<File>>()
        entries.forEach(({file, folder}) => {
            const group = groups.get(folder)
            if (isDefined(group)) {group.push(file)} else {groups.set(folder, [file])}
        })
        return Array.from(groups)
    }

    export const pick = (): Promise<ReadonlyArray<Entry>> => new Promise(resolve => {
        const input = document.createElement("input")
        input.type = "file"
        input.webkitdirectory = true
        input.classList.add("hidden")
        const done = (entries: ReadonlyArray<Entry>) => {
            input.remove()
            resolve(entries)
        }
        input.addEventListener("cancel", () => done(Arrays.empty()))
        input.addEventListener("change", () =>
            done(isDefined(input.files) ? fromRelativePaths(Array.from(input.files)) : Arrays.empty()))
        document.body.appendChild(input)
        input.click()
    })
}
