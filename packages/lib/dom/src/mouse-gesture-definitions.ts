import {isAbsent, isDefined, isRecord, JSONValue, Objects} from "@opendaw/lib-std"
import {MouseGesture} from "./mouse-gesture"

export type MouseGestureDefinition = { gesture: MouseGesture, description: string }

export type MouseGestureDefinitions = Record<string, MouseGestureDefinition>

export namespace MouseGestureDefinitions {
    export const copy = <T extends MouseGestureDefinitions>(defs: T): T => {
        const result = {...defs}
        for (const [key, definition] of Objects.entries(defs)) {
            result[key] = {...definition, gesture: definition.gesture.copy()}
        }
        return result
    }

    export const copyInto = (source: MouseGestureDefinitions, target: MouseGestureDefinitions): void => {
        for (const [key, {gesture}] of Object.entries(source)) {
            target[key].gesture.overrideWith(gesture.copy())
        }
    }

    export const toJSON = (defs: MouseGestureDefinitions): JSONValue => {
        const result: Record<string, JSONValue> = {}
        for (const [key, {gesture}] of Object.entries(defs)) {
            result[key] = gesture.toJSON()
        }
        return result
    }

    export const fromJSON = (defs: MouseGestureDefinitions, values: JSONValue): void => {
        if (!isRecord(values) || Array.isArray(values)) {return}
        for (const [key, value] of Object.entries(values)) {
            const definition = defs[key]
            if (isAbsent(definition) || !isDefined(value)) {continue}
            MouseGesture.fromJSON(value).ifSome(gesture => definition.gesture.overrideWith(gesture))
        }
    }
}

export namespace MouseGestureValidator {
    export const conflicts = (defs: MouseGestureDefinitions): ReadonlyArray<[string, string]> => {
        const entries = Object.entries(defs)
        return entries.flatMap(([key, {gesture}], index) => entries.slice(index + 1)
            .filter(([, other]) => gesture.equals(other.gesture))
            .map(([otherKey]): [string, string] => [key, otherKey]))
    }

    export const validate = <T extends MouseGestureDefinitions>(defs: T): T => {
        for (const [key, otherKey] of conflicts(defs)) {
            alert(`Mouse gesture conflict: '${key}' and '${otherKey}' both use ${defs[key].gesture.format().join("")}`)
        }
        return defs
    }
}
