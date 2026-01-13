import {createElement} from "@moises-ai/lib-jsx"

export const Logo = () => {
    const S = 60
    const L = 30
    return (
        <svg width="100%" height="100%" viewBox="0 0 1000 600">
            <g transform="translate(100 100)">
                <circle r="60" fill={`hsl(195 ${S}% ${L - 10}%)`}/>
                <circle cx="200" r="60" fill={`hsl(188 ${S}% ${L}%)`}/>
                <circle cx="400" r="60" fill={`hsl(15 ${S}% ${L - 5}%)`}/>
                <circle cx="600" r="60" fill={`hsl(33 ${S}% ${L + 5}%)`}/>
                <circle cx="800" r="60" fill={`hsl(48 ${S}% ${L + 10}%)`}/>
                <circle cy="200" r="60" fill={`hsl(48 ${S}% ${L + 10}%)`}/>
                <circle cx="200" cy="200" r="60" fill={`hsl(195 ${S}% ${L - 10}%)`}/>
                <circle cx="400" cy="200" r="60" fill={`hsl(188 ${S}% ${L}%)`}/>
                <circle cx="600" cy="200" r="60" fill={`hsl(15 ${S}% ${L - 5}%)`}/>
                <circle cx="800" cy="200" r="60" fill={`hsl(33 ${S}% ${L + 5}%)`}/>
                <circle cy="400" r="60" fill={`hsl(33 ${S}% ${L + 5}%)`}/>
                <circle cx="200" cy="400" r="60" fill={`hsl(48 ${S}% ${L + 10}%)`}/>
                <circle cx="400" cy="400" r="60" fill={`hsl(195 ${S}% ${L - 10}%)`}/>
                <circle cx="600" cy="400" r="60" fill={`hsl(188 ${S}% ${L}%)`}/>
                <circle cx="800" cy="400" r="60" fill={`hsl(15 ${S}% ${L - 5}%)`}/>
            </g>
        </svg>
    )
}