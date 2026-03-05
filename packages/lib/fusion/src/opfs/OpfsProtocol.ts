export namespace OpfsProtocol {
    export type Kind = "file" | "directory"
    export type Entry = { name: string, kind: Kind }
}

export interface OpfsProtocol {
    write(path: string, data: Uint8Array): Promise<void>
    read(path: string): Promise<Uint8Array>
    exists(path: string): Promise<boolean>
    delete(path: string): Promise<void>
    list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>>
}
