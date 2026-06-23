import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {VoicingMode} from "@opendaw/studio-enums"
import {ClassicWaveform} from "@opendaw/lib-dsp"

// Give a freshly created Vaporisateur box an audible SINE preset. A bare `VaporisateurDeviceBox.create` does
// not sound: the schema leaves cutoff / resonance / attack / release UNSET and defaults BOTH oscillator
// volumes to -inf dB (silent), and an unset resonance leaves the filter Q at 0. This mirrors the canonical
// `InstrumentFactories.Vaporisateur` preset the real app uses (so every field the voice reads is set), but
// with oscillator A SINE at -6 dB (oscillator B stays silent) instead of the factory's saw.
export const applySinePatch = (box: VaporisateurDeviceBox): void => {
    box.cutoff.setValue(18_000.0)
    box.resonance.setValue(0.1)
    box.attack.setValue(0.005)
    box.decay.setValue(0.0)
    box.sustain.setValue(0.5)
    box.release.setValue(0.2)
    box.voicingMode.setValue(VoicingMode.Polyphonic)
    box.lfo.rate.setValue(1.0)
    box.oscillators.fields()[0].waveform.setValue(ClassicWaveform.sine)
    box.oscillators.fields()[0].volume.setValue(-6.0)
    box.version.setValue(2) // matches the factory (osc array + no legacy -15 dB)
}
