export const isManualsPath = (pathname: string): boolean =>
    pathname === "/manuals" || pathname.startsWith("/manuals/")
