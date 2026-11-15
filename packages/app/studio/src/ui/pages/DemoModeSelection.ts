import {Arrays, isDefined, tryCatch, UUID} from "@opendaw/lib-std"

export namespace DemoModeSelection {
    const keyOf = (project: UUID.Bytes): string => `demo-mode/${UUID.toString(project)}`

    export const load = (project: UUID.Bytes): ReadonlyArray<UUID.Bytes> => {
        const {status, value} = tryCatch(() => localStorage.getItem(keyOf(project)))
        if (status === "failure" || !isDefined(value)) {return Arrays.empty()}
        const parsed = tryCatch(() => JSON.parse(value))
        if (parsed.status === "failure" || !Array.isArray(parsed.value)) {return Arrays.empty()}
        return parsed.value
            .filter((entry: unknown): entry is UUID.String => typeof entry === "string" && UUID.validateString(entry))
            .map(entry => UUID.parse(entry))
    }

    export const save = (project: UUID.Bytes, devices: ReadonlyArray<UUID.Bytes>): void => {
        tryCatch(() => localStorage.setItem(keyOf(project), JSON.stringify(devices.map(uuid => UUID.toString(uuid)))))
    }
}
