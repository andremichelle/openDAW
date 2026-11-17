import {mkdirSync} from "node:fs"
import {createRelay} from "./relay.js"

const isDev = process.env.NODE_ENV !== "production"
mkdirSync("data", {recursive: true})
const relay = createRelay({
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 8790),
    tokenFile: "data/tokens.json",
    origins: isDev
        ? ["https://localhost:8080", "https://localhost:8081", "https://localhost:8082", "https://localhost:8083",
            "https://localhost:8084", "https://localhost:8085", "https://localhost:8086", "https://localhost:8087",
            "https://localhost:8088", "https://localhost:8089"]
        : ["https://opendaw.studio", "https://dev.opendaw.studio"],
    log: message => console.log(message)
})
relay.listen().then(port => console.log(`agent relay on 127.0.0.1:${port} (${isDev ? "development" : "production"})`))
