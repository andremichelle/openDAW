import {OpfsProtocol} from "@opendaw/lib-fusion"
import {ScriptFiles} from "./ScriptStorage"

// In-memory stand-in for the OPFS worker: flat path map, folders are implied by their files
export class FakeFiles implements ScriptFiles {
    readonly store = new Map<string, Uint8Array>()
    async read(path: string): Promise<Uint8Array> {
        const bytes = this.store.get(path)
        if (bytes === undefined) {throw new Error(`Not found: ${path}`)}
        return bytes
    }
    async write(path: string, data: Uint8Array): Promise<void> {this.store.set(path, data)}
    async delete(path: string): Promise<void> {
        Array.from(this.store.keys()).filter(key => key === path || key.startsWith(`${path}/`))
            .forEach(key => this.store.delete(key))
    }
    async list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>> {
        const names = new Map<string, OpfsProtocol.Kind>()
        Array.from(this.store.keys()).filter(key => key.startsWith(`${path}/`)).forEach(key => {
            const rest = key.substring(path.length + 1)
            const slash = rest.indexOf("/")
            if (slash === -1) {names.set(rest, "file")} else {names.set(rest.substring(0, slash), "directory")}
        })
        return Array.from(names.entries()).map(([name, kind]) => ({name, kind}))
    }
}
