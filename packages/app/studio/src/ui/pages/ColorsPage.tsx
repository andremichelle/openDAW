import {createElement} from "@opendaw/lib-jsx"
import {Color} from "@opendaw/lib-std"
import {Colors} from "@opendaw/studio-enums"

export const ColorsPage = () => {
    return (
        <div style={{flex: "1 0 0", display: "grid", gridTemplateColumns: "repeat(5, 1fr)"}}>
            {Object.entries(Colors).map(([name, color]) => (
                <div style={{
                    width: "100%",
                    height: "100%",
                    backgroundColor: color.toString(),
                    display: "flex",
                    flexDirection: "column",
                    placeItems: "center",
                    placeContent: "center",
                    color: "white",
                    textShadow: "0 1px 2px black"
                }}>
                    <div>{name}</div>
                    <div style={{userSelect: "text", fontSize: "0.85em", opacity: "0.85"}}>
                        {Color.hslStringToHex(color.toString())}
                    </div>
                </div>
            ))}
        </div>
    )
}