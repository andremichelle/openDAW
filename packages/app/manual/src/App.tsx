import {createElement, Router} from "@opendaw/lib-jsx"
import {TerminableOwner} from "@opendaw/lib-std"
import {ManualPage} from "./ManualPage"

export const App = (runtime: TerminableOwner) => (
    <Router
        runtime={runtime}
        service={null}
        fallback={() => (
            <div style={{flex: "1 0 0", display: "flex", justifyContent: "center", alignItems: "center"}}>
                <span>Page not found.</span>
            </div>
        )}
        routes={[
            {path: "/manuals/*", factory: ManualPage}
        ]}
    />
)
