import {AnyFunc, DefaultObservableValue, EmptyProcedure, ObservableValue, Procedure, Provider} from "@moises-ai/lib-std"

export type DotPath = string

export namespace ConsoleCommands {
    export const exportMethod = (path: DotPath, callback: AnyFunc): void =>
        store(path, {value: callback})

    export const exportBoolean = (path: DotPath, init: boolean = false): ObservableValue<boolean> => {
        const observableValue = new DefaultObservableValue(init)
        exportAccessor(path, () => observableValue.getValue(), input => {
            const value = Boolean(input)
            console.debug(`set to ${value}`)
            observableValue.setValue(value)
        })
        return observableValue
    }

    export const exportAccessor = (path: DotPath, getter: Provider<unknown>, setter: Procedure<any> = EmptyProcedure): void =>
        store(path, {
            get: () => {
                try {
                    console.debug(getter())
                    return 0
                } catch (error) {
                    console.error(error)
                    return 1
                }
            },
            set: (value) => {
                try {
                    setter(value)
                    return getter()
                } catch (error) {
                    console.error(error)
                    return 1
                }
            },
            enumerable: false,
            configurable: false
        })

    const global: any = (() => {try {return self} catch (_: unknown) {return {}}})()
    const scope = (global["opendaw"] ??= {}) as any
    const store = (path: string, attributes: PropertyDescriptor & ThisType<any>) => {
        const levels = path.split(".")
        const name = levels.splice(-1)[0]
        let current = scope
        for (const level of levels) {
            current = (current[level] ??= {})
        }
        Object.defineProperty(current, name, attributes)
        console.debug(`Console command 'opendaw.${path}' exported`)
    }
}