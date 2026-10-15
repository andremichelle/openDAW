import {Errors, isDefined, Nullable, Option, Optional} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Shell} from "@/platform/desktop/Shell"

type ShellFilter = { name: string, extensions: ReadonlyArray<string> }
type ShellOptions = { suggestedName?: string, multiple?: boolean, filters?: ReadonlyArray<ShellFilter> }
type ShellFile = { id: number, name: string, lastModified: number }
type WriteData = Shell.Body

export namespace DesktopFiles {
    const request = Shell.request

    const toFilters = (types: Optional<ReadonlyArray<FilePickerAcceptType>>): ReadonlyArray<ShellFilter> =>
        (types ?? []).map(({description, accept}) => ({
            name: description ?? "",
            extensions: Object.values(accept ?? {}).flat().map(extension => extension.replace(/^\./, ""))
        }))

    const withOptions = (options: ShellOptions): Record<string, string> => ({options: JSON.stringify(options)})

    const isWriteData = (chunk: FileSystemWriteChunkType): chunk is WriteData =>
        typeof chunk === "string" || chunk instanceof Blob || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)

    export const saveFile = async (arrayBuffer: ArrayBuffer, options?: SaveFilePickerOptions): Promise<string> => {
        const response = await request("save", withOptions({
            suggestedName: options?.suggestedName, filters: toFilters(options?.types)
        }), arrayBuffer)
        if (response.status === 204) {return Promise.reject(Errors.AbortError)}
        return response.text()
    }

    export const openFiles = async (options?: OpenFilePickerOptions): Promise<ReadonlyArray<File>> => {
        const response = await request("open", withOptions({
            multiple: options?.multiple ?? false, filters: toFilters(options?.types)
        }))
        const entries: ReadonlyArray<ShellFile> = await response.json()
        if (entries.length === 0) {return Promise.reject(Errors.AbortError)}
        return Promise.all(entries.map(async ({id, name, lastModified}) => {
            const blob = await (await request("read", {id: String(id)})).blob()
            const type = blob.type === "application/octet-stream" ? "" : blob.type
            return new File([blob], name, {lastModified, type})
        }))
    }

    export const saveStream = async (options: SaveFilePickerOptions): Promise<Option<WritableStream>> => {
        const response = await request("stream", withOptions({
            suggestedName: options.suggestedName, filters: toFilters(options.types)
        }))
        if (response.status === 204) {return Option.None}
        const id = await response.text()
        const write = (data: Nullable<Optional<WriteData>>, position: Nullable<Optional<number>>) =>
            request("write", isDefined(position) ? {id, position: String(position)} : {id}, data)
        return Option.wrap(new WritableStream<FileSystemWriteChunkType>({
            write: async (chunk: FileSystemWriteChunkType): Promise<void> => {
                if (isWriteData(chunk)) {
                    await write(chunk, null)
                } else if (chunk.type === "write") {
                    await write(chunk.data, chunk.position)
                } else if (chunk.type === "seek") {
                    await request("seek", {id, position: String(chunk.position ?? 0)})
                } else {
                    await request("truncate", {id, size: String(chunk.size ?? 0)})
                }
            },
            close: async (): Promise<void> => {await request("close", {id})},
            abort: async (): Promise<void> => {await request("abort", {id})}
        }))
    }

    export const install = (): void => Platform.install({saveFile, openFiles, canSaveStream: () => true, saveStream})
}
