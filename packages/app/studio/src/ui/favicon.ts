import {DefaultObservableValue, isDefined, Nullable, Subscription} from "@moises-ai/lib-std"

export const subscribeFavicon = (observable: DefaultObservableValue<Nullable<unknown>>): Subscription => {
    return observable.catchupAndSubscribe(owner => {
        const link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
        if (isDefined(link)) {
            link.href = isDefined(owner.getValue()) ? "/favicon-live.svg" : "/favicon.svg"
        }
    })
}
