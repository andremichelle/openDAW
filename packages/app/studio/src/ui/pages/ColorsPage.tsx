import {createElement} from "@moises-ai/lib-jsx"

export const ColorsPage = () => {
    const cssVars: Record<string, string> = {}
    Array.from(document.styleSheets).forEach((sheet) => {
        try {
            const rules = sheet.cssRules as CSSRuleList
            Array.from(rules).forEach((rule) => {
                if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
                    Array.from(rule.style).forEach((prop) => {
                        if (prop.startsWith("--")) {
                            const value = rule.style.getPropertyValue(prop).trim()
                            const style = new Option().style
                            style.color = value
                            if (style.color === "") {return}
                            cssVars[prop] = value
                        }
                    })
                }
            })
        } catch (_) {/*Ignore cross-origin stylesheets*/}
    })
    return (
        <div style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "repeat(5, 1fr)"}}>
            {Object.entries(cssVars).map(([key, value]) => (
                <div style={{
                    width: "100%",
                    height: "100%",
                    backgroundColor: value,
                    display: "flex",
                    placeItems: "center",
                    placeContent: "center",
                    color: "white",
                    textShadow: "0 1px 2px black"
                }}>{key}</div>
            ))}
        </div>
    )
}