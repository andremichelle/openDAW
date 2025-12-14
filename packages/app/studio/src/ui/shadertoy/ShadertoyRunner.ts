import {Terminable} from "@opendaw/lib-std"
import {ShadertoyState} from "@/ui/shadertoy/ShadertoyState"

export class ShadertoyRunner implements Terminable {
    readonly #gl: WebGL2RenderingContext

    #uniformLocations: {
        iResolution: WebGLUniformLocation | null
        iTime: WebGLUniformLocation | null
        iTimeDelta: WebGLUniformLocation | null
        iFrame: WebGLUniformLocation | null
        iBeat: WebGLUniformLocation | null
        iPeaks: WebGLUniformLocation | null
        iChannelResolution: WebGLUniformLocation | null
        iChannel0: WebGLUniformLocation | null
        iMidiCC: WebGLUniformLocation | null
        iMidiNotes: WebGLUniformLocation | null
    } = {
        iResolution: null,
        iTime: null,
        iTimeDelta: null,
        iFrame: null,
        iBeat: null,
        iPeaks: null,
        iChannelResolution: null,
        iChannel0: null,
        iMidiCC: null,
        iMidiNotes: null
    }

    #program: WebGLProgram | null = null
    #vao: WebGLVertexArrayObject | null = null
    #audioTexture: WebGLTexture | null = null
    #midiCCTexture: WebGLTexture | null = null
    #midiNoteTexture: WebGLTexture | null = null
    #startTime = 0.0
    #lastFrameTime = 0.0
    #frameCount = 0

    static readonly #VERTEX_SHADER = `#version 300 es
        in vec4 aPosition;
        void main() {
            gl_Position = aPosition;
        }
    `
    static readonly #FRAGMENT_PREFIX = `#version 300 es
        precision highp float;
        uniform vec3 iResolution;
        uniform float iBeat;
        uniform float iTime;
        uniform float iTimeDelta;
        uniform int iFrame;
        uniform vec4 iPeaks; // leftPeak, leftRMS, rightPeak, rightRMS
        uniform vec3 iChannelResolution[1];
        uniform sampler2D iChannel0;
        uniform sampler2D iMidiCC;
        uniform sampler2D iMidiNotes;
        out vec4 fragColor;
        float midiCC(int cc) {
            return texture(iMidiCC, vec2((float(cc) + 0.5) / 128.0, 0.5)).r;
        }
        float midiNote(int pitch) {
            return texture(iMidiNotes, vec2((float(pitch) + 0.5) / 128.0, 0.5)).r;
        }
    `
    static readonly #FRAGMENT_SUFFIX = `
        void main() {
            mainImage(fragColor, gl_FragCoord.xy);
            fragColor.a = 1.0;
        }
    `
    constructor(gl: WebGL2RenderingContext) {
        this.#gl = gl
        this.#initGeometry()
        this.#initAudioTexture()
        this.#initMidiCCTexture()
        this.#initMidiNoteTexture()
    }

    /**
     * Compiles and links a Shadertoy fragment shader.
     * @param fragmentSource The mainImage() function source code (Shadertoy format)
     */
    compile(fragmentSource: string): void {
        const gl = this.#gl
        if (this.#program) {
            gl.deleteProgram(this.#program)
            this.#program = null
        }
        while (gl.getError() !== gl.NO_ERROR) {}
        const vertexShader = this.#compileShader(gl.VERTEX_SHADER, ShadertoyRunner.#VERTEX_SHADER)
        const fullFragmentSource = ShadertoyRunner.#FRAGMENT_PREFIX + fragmentSource + ShadertoyRunner.#FRAGMENT_SUFFIX
        const fragmentShader = this.#compileShader(gl.FRAGMENT_SHADER, fullFragmentSource)
        this.#program = gl.createProgram()
        if (!this.#program) {
            throw new Error("Failed to create program")
        }
        gl.attachShader(this.#program, vertexShader)
        gl.attachShader(this.#program, fragmentShader)
        gl.linkProgram(this.#program)
        gl.deleteShader(vertexShader)
        gl.deleteShader(fragmentShader)
        if (!gl.getProgramParameter(this.#program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(this.#program)
            gl.deleteProgram(this.#program)
            this.#program = null
            throw new Error(`Program linking failed: ${info}`)
        }
        this.#uniformLocations = {
            iResolution: gl.getUniformLocation(this.#program, "iResolution"),
            iTime: gl.getUniformLocation(this.#program, "iTime"),
            iTimeDelta: gl.getUniformLocation(this.#program, "iTimeDelta"),
            iFrame: gl.getUniformLocation(this.#program, "iFrame"),
            iBeat: gl.getUniformLocation(this.#program, "iBeat"),
            iPeaks: gl.getUniformLocation(this.#program, "iPeaks"),
            iChannelResolution: gl.getUniformLocation(this.#program, "iChannelResolution"),
            iChannel0: gl.getUniformLocation(this.#program, "iChannel0"),
            iMidiCC: gl.getUniformLocation(this.#program, "iMidiCC"),
            iMidiNotes: gl.getUniformLocation(this.#program, "iMidiNotes")
        }
    }

    /**
     * Renders a single frame.
     * @param time Optional explicit time in seconds. If omitted, uses elapsed time since resetTime().
     */
    render(time?: number): void {
        const gl = this.#gl
        if (!this.#program) {
            return
        }
        const {audioData, midiCCData, midiNoteData, beat, peaks} = ShadertoyState.get()
        const currentTime = time ?? (performance.now() / 1000.0 - this.#startTime)
        const timeDelta = currentTime - this.#lastFrameTime
        this.#lastFrameTime = currentTime
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
        gl.disable(gl.BLEND)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.#audioTexture)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, audioData)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, this.#midiCCTexture)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, midiCCData)
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, this.#midiNoteTexture)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, midiNoteData)
        gl.useProgram(this.#program)
        gl.uniform3f(this.#uniformLocations.iResolution, gl.drawingBufferWidth, gl.drawingBufferHeight, 1.0)
        gl.uniform1f(this.#uniformLocations.iTime, currentTime)
        gl.uniform1f(this.#uniformLocations.iTimeDelta, timeDelta)
        gl.uniform1i(this.#uniformLocations.iFrame, this.#frameCount)
        gl.uniform1f(this.#uniformLocations.iBeat, beat)
        gl.uniform4fv(this.#uniformLocations.iPeaks, peaks)
        gl.uniform3fv(this.#uniformLocations.iChannelResolution, [512.0, 2.0, 1.0])
        gl.uniform1i(this.#uniformLocations.iChannel0, 0)
        gl.uniform1i(this.#uniformLocations.iMidiCC, 1)
        gl.uniform1i(this.#uniformLocations.iMidiNotes, 2)
        gl.bindVertexArray(this.#vao)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.bindVertexArray(null)
        this.#frameCount++
    }

    /**
     * Resets the time and frame counter.
     */
    resetTime(): void {
        this.#startTime = performance.now() / 1000.0
        this.#lastFrameTime = this.#startTime
        this.#frameCount = 0
    }

    /**
     * Cleans up WebGL resources.
     */
    terminate(): void {
        const gl = this.#gl
        if (this.#program) {
            gl.deleteProgram(this.#program)
            this.#program = null
        }
        if (this.#vao) {
            gl.deleteVertexArray(this.#vao)
            this.#vao = null
        }
        if (this.#audioTexture) {
            gl.deleteTexture(this.#audioTexture)
            this.#audioTexture = null
        }
        if (this.#midiCCTexture) {
            gl.deleteTexture(this.#midiCCTexture)
            this.#midiCCTexture = null
        }
        if (this.#midiNoteTexture) {
            gl.deleteTexture(this.#midiNoteTexture)
            this.#midiNoteTexture = null
        }
    }

    #initGeometry(): void {
        const gl = this.#gl
        const vertices = new Float32Array([
            -1.0, -1.0,
            1.0, -1.0,
            -1.0, 1.0,
            1.0, 1.0
        ])
        const vbo = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
        this.#vao = gl.createVertexArray()
        gl.bindVertexArray(this.#vao)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.bindVertexArray(null)
    }

    #initAudioTexture(): void {
        const gl = this.#gl
        this.#audioTexture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.#audioTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 512, 2, 0, gl.RED, gl.UNSIGNED_BYTE,
            ShadertoyState.get().audioData)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    #initMidiCCTexture(): void {
        const gl = this.#gl
        this.#midiCCTexture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.#midiCCTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
            ShadertoyState.get().midiCCData)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    #initMidiNoteTexture(): void {
        const gl = this.#gl
        this.#midiNoteTexture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.#midiNoteTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
            ShadertoyState.get().midiNoteData)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    #compileShader(type: number, source: string): WebGLShader {
        const gl = this.#gl
        const shader = gl.createShader(type)
        if (!shader) {
            throw new Error("Failed to create shader")
        }
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader)
            gl.deleteShader(shader)
            throw new Error(`Shader compilation failed: ${info}`)
        }
        return shader
    }
}