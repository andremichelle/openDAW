import css from "./PreferencePanel.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, Optional, ValueGuard} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {NumberInput} from "@/ui/components/NumberInput"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Preferences} from "@opendaw/lib-fusion"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "PreferencePanel")

type Primitive = boolean | number | string

export type NestedLabels<T> = {
    [K in keyof T]: T[K] extends Primitive
        ? string
        : T[K] extends object
            ? { label: string; fields: NestedLabels<T[K]> }
            : never
}

export type SelectOptions<T> = {
    [K in keyof T]?: T[K] extends Primitive
        ? T[K] extends boolean ? never : ReadonlyArray<{ value: T[K]; label: string }>
        : T[K] extends object
            ? SelectOptions<T[K]>
            : never
}

// Numeric fields are edited as free text, so a setting whose schema constrains its range needs a guard
// here as well. Without one an out-of-range value is stored and fails the schema on the next load,
// which costs the user that whole settings section.
export type ValueGuards<T> = {
    [K in keyof T]?: T[K] extends Primitive
        ? T[K] extends number ? ValueGuard<number> : never
        : T[K] extends object
            ? ValueGuards<T[K]>
            : never
}

type Construct<ROOT_SETTINGS, SETTINGS = ROOT_SETTINGS> = {
    lifecycle: Lifecycle
    preferences: Preferences<ROOT_SETTINGS>
    pathPrefix?: ReadonlyArray<string>
    labels: NestedLabels<SETTINGS>
    options?: SelectOptions<SETTINGS>
    guards?: ValueGuards<SETTINGS>
}

export const PreferencePanel = <ROOT_SETTINGS, SETTINGS = ROOT_SETTINGS>(
    {lifecycle, preferences, pathPrefix = [], labels, options, guards}: Construct<ROOT_SETTINGS, SETTINGS>
) => {
    const settings = pathPrefix.reduce(
        (obj, key) => (obj as Record<string, unknown>)[key],
        preferences.settings as unknown
    ) as SETTINGS

    return (
        <div className={className}
             onConnect={element => {if (pathPrefix.length === 0) {lifecycle.own(installScrollbars(element))}}}>
            {Object.keys(labels).map(key => {
                const pKey = key as keyof SETTINGS & string
                const setting = settings[pKey]
                const label = labels[pKey]
                const currentPath = [...pathPrefix, pKey]
                if (typeof setting === "object" && setting !== null && typeof label === "object" && "fields" in label) {
                    const nestedLabels = label as { label: string; fields: NestedLabels<typeof setting> }
                    const nestedOptions = options?.[pKey] as Optional<SelectOptions<typeof setting>>
                    const nestedGuards = guards?.[pKey] as Optional<ValueGuards<typeof setting>>
                    return (
                        <details className="accordion" open>
                            <summary>{nestedLabels.label}</summary>
                            <PreferencePanel
                                lifecycle={lifecycle}
                                preferences={preferences}
                                pathPrefix={currentPath}
                                labels={nestedLabels.fields}
                                options={nestedOptions}
                                guards={nestedGuards}/>
                        </details>
                    )
                }
                const createModel = () => lifecycle.own((preferences as any).createMutableObservableValue(...currentPath))
                switch (typeof setting) {
                    case "boolean": {
                        return (
                            <Frag>
                                <Checkbox lifecycle={lifecycle}
                                          model={createModel()}
                                          appearance={{
                                              color: Colors.black,
                                              activeColor: Colors.bright,
                                              cursor: "pointer"
                                          }}>
                                    <span style={{color: Colors.shadow.toString()}}>{label}</span>
                                    <hr/>
                                    <Icon symbol={IconSymbol.Checkbox}/>
                                </Checkbox>
                            </Frag>
                        )
                    }
                    case "number": {
                        const fieldOptions = options?.[pKey] as ReadonlyArray<{
                            value: number;
                            label: string
                        }> | undefined
                        if (fieldOptions) {
                            return (
                                <div className="select-field">
                                    <span style={{color: Colors.shadow.toString()}}>{label}</span>
                                    <hr/>
                                    <RadioGroup
                                        lifecycle={lifecycle}
                                        model={createModel()}
                                        elements={fieldOptions.map(option => ({
                                            value: option.value,
                                            element: <span>{option.label}</span>
                                        }))}
                                        appearance={{
                                            color: Colors.black,
                                            activeColor: Colors.bright,
                                            cursor: "pointer"
                                        }}/>
                                </div>
                            )
                        }
                        const fieldGuard = guards?.[pKey] as Optional<ValueGuard<number>>
                        return (
                            <div className="number-field">
                                <span style={{color: Colors.shadow.toString()}}>{label}</span>
                                <hr/>
                                <NumberInput lifecycle={lifecycle}
                                             model={createModel()}
                                             guard={fieldGuard}
                                             maxChars={4}
                                             className="big"/>
                            </div>
                        )
                    }
                    case "string": {
                        const fieldOptions = options?.[pKey] as ReadonlyArray<{
                            value: string;
                            label: string
                        }> | undefined
                        if (fieldOptions) {
                            return (
                                <div className="select-field">
                                    <span style={{color: Colors.shadow.toString()}}>{label}</span>
                                    <hr/>
                                    <RadioGroup
                                        lifecycle={lifecycle}
                                        model={createModel()}
                                        elements={fieldOptions.map(option => ({
                                            value: option.value,
                                            element: <span>{option.label}</span>
                                        }))}
                                        appearance={{
                                            color: Colors.black,
                                            activeColor: Colors.bright,
                                            cursor: "pointer"
                                        }}/>
                                </div>
                            )
                        }
                        return null
                    }
                    default:
                        return null
                }
            })}
        </div>
    )
}
