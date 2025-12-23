import {ShortcutDefinitions} from "@/shortcuts/ShortcutDefinitions"

export namespace ShortcutValidator {
    export const validate = <T extends ShortcutDefinitions>(actions: T): T => {
        const entries = Object.entries(actions)
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                if (entries[i][1].keys.equals(entries[j][1].keys)) {
                    alert(`Shortcut conflict: '${entries[i][0]}' and '${entries[j][0]}' both use ${entries[i][1].keys.format()}`)
                }
            }
        }
        return actions
    }
}
