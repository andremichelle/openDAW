import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {VoicingMode} from "@opendaw/studio-enums"
import {ClassicWaveform} from "@opendaw/lib-dsp"

// Give a freshly created Vaporisateur box an audible SAW BASS preset. Like `applySinePatch`, a bare box does
// not sound (oscillator volumes default to -inf dB, resonance leaves Q at 0), so every field the voice reads is
// set here. Oscillator A is a SAW at -6 dB; the cutoff stays wide open because the bass runs into the page's
// Revamp low-pass (the tempo-synced auto-wah) which does the actual filtering. Monophonic, for a tight bass.
export const applySawBassPatch = (box: VaporisateurDeviceBox): void => {
    box.cutoff.setValue(18_000.0)
    box.resonance.setValue(0.1)
    box.attack.setValue(0.005)
    box.decay.setValue(0.0)
    box.sustain.setValue(0.7)
    box.release.setValue(0.08)
    box.voicingMode.setValue(VoicingMode.Monophonic)
    box.lfo.rate.setValue(1.0)
    box.oscillators.fields()[0].waveform.setValue(ClassicWaveform.saw)
    box.oscillators.fields()[0].volume.setValue(-6.0)
    box.version.setValue(2)
}
