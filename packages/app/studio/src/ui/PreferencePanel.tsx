import css from "./PreferencePanel.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {Preferences} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "PreferencePanel")

type Construct = {
    lifecycle: Lifecycle
}

const Labels: { [K in keyof Preferences]: string } = {
    "visible-help-hints": "Visible Help & Hints",
    "enable-history-buttons": "Show Undo/Redo buttons",
    "note-audition-while-editing": "Note audition while editing",
    "auto-open-clips": "Always open clip view",
    "auto-create-output-compressor": "Automatically add compressor to main output",
    "dragging-use-pointer-lock": "Use Pointer Lock when dragging close to window edges [Chrome only]",
    "modifying-controls-wheel": "Modify controls with mouse wheel",
    "normalize-mouse-wheel": "Normalize mouse wheel speed",
    "time-display": "Time Display",
    "footer-show-fps-meter": "🪲 Show FPS meter",
    "footer-show-build-infos": "🪲 Show Build Informations",
    "enable-beta-features": "☢️ Enable Experimental Features"
}

export const PreferencePanel = ({lifecycle}: Construct) => {
    return (
        <div className={className}>
            {Object.keys(Labels).map(key => {
                const pKey = key as keyof Preferences
                const values = Preferences.values
                const value = values[pKey]
                switch (typeof value) {
                    case "boolean": {
                        const pKey = key as keyof Preferences & {
                            [K in keyof Preferences]: Preferences[K] extends boolean ? K : never
                        }[keyof Preferences]
                        const model = new DefaultObservableValue<boolean>(value)
                        lifecycle.own(model.subscribe(owner => values[pKey] = owner.getValue()))
                        return (
                            <Frag>
                                <Checkbox lifecycle={lifecycle}
                                          model={model}
                                          appearance={{
                                              color: Colors.black,
                                              activeColor: Colors.bright,
                                              cursor: "pointer"
                                          }}>
                                    <span style={{color: Colors.shadow.toString()}}>{Labels[pKey]}</span>
                                    <hr/>
                                    <Icon symbol={IconSymbol.Checkbox}/>
                                </Checkbox>
                            </Frag>
                        )
                    }
                }
            })}
        </div>
    )
}