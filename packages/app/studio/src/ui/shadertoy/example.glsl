/*
 * midiNote(int pitch) - returns normalized velocity or 0. if off. Pitch: 60 = C4
 * midiCC(int cc)      - returns normalized CC value
 * iBeat               - returns normalized beat position (ppqn / PPQN.Quaver)
 * iPeaks              - returns vec4(leftPeak, rightPeak, leftRMS, rightRMS)
 */

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float aspect = iResolution.x / iResolution.y;
    vec3 green = vec3(0.3, 0.7, 0.4);
    vec3 gray = vec3(0.2);
    vec3 blue = vec3(0.46, 0.72, 1.0);

    // Striped background
    float stripe = fract((uv.x + uv.y * 0.25) * 30.0 + iBeat);
    vec3 col = stripe < 0.5 ? vec3(0.04) : vec3(0.08);

    // Waveform (top: 0.78 - 0.98)
    if (uv.y > 0.78 && uv.y < 0.98) {
        float wave = texture(iChannel0, vec2(uv.x, 0.75)).r * 2.0 - 1.0;
        float waveY = 0.88 + wave * 0.08;
        if (abs(uv.y - waveY) < 0.002) col = vec3(0.5, 0.5, 0.7);
    }

    // Spectrum blocks (middle: 0.36 - 0.74)
    if (uv.y > 0.36 && uv.y < 0.74 && uv.x > 0.02 && uv.x < 0.98) {
        float specX = (uv.x - 0.02) / 0.96;
        float specY = (uv.y - 0.36) / 0.38;
        int bx = int(specX * 32.0);
        int by = int(specY * 16.0);
        float fft = texture(iChannel0, vec2((float(bx) + 0.5) / 32.0, 0.25)).r;
        float blockY = (float(by) + 0.5) / 16.0;
        vec2 blockUV = vec2(fract(specX * 32.0), fract(specY * 16.0));
        if (blockY < fft && blockUV.x > 0.1 && blockUV.x < 0.9 && blockUV.y > 0.15 && blockUV.y < 0.85) {
            vec3 specCol = mix(green, blue, specX);
            col = specCol * (0.5 + 0.5 * blockY);
        }
    }

    // Dots (bottom left)
    float beat = mod(floor(iBeat * 4.0), 16.0);
    for (int i = 0; i < 16; i++) {
        vec2 center = vec2(0.08 + float(i) * 0.05, 0.18);
        vec2 d = uv - center;
        d.x *= aspect;
        if (length(d) < 0.022) {
            int ci = int(mod(float(i), 4.0));
            vec3 dotCol = ci == 0 ? blue : gray;
            col = (float(i) == beat) ? vec3(1.0) : dotCol;
        }
    }

    // Peak/RMS meters (bottom right)
    float h = uv.y - 0.06;
    if (h > 0.0 && h < 0.24) {
        float n = h / 0.24;
        float x = uv.x - 0.92;
        if (x > -0.02 && x < -0.01) col = n < iPeaks.z ? green : n < iPeaks.x ? gray : col;
        if (x > 0.01 && x < 0.02) col = n < iPeaks.w ? green : n < iPeaks.y ? gray : col;
    }

    fragColor = vec4(col, 1.0);
}