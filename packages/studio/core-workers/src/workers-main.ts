import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {OpfsWorker, SamplePeakWorker} from "@opendaw/lib-fusion"
import {
    analyzeBursts,
    AudioData,
    AudioMaterialFeatures,
    AudioMaterialProtocol,
    BpmProtocol,
    LatencyCalibrationAnalysis,
    LatencyCalibrationInput,
    LatencyCalibrationProtocol,
    TransientDetector,
    TransientProtocol
} from "@opendaw/lib-dsp"
import {detectBpm} from "./bpm-detection"
import {analyzeMaterial} from "./material-analysis"

const messenger: Messenger = Messenger.for(self)

OpfsWorker.init(messenger)
SamplePeakWorker.install(messenger)

Communicator.executor(messenger.channel("transients"), new class implements TransientProtocol {
    async detect(audioData: AudioData): Promise<Array<number>> {
        return TransientDetector.detect(audioData)
    }
})

Communicator.executor(messenger.channel("bpm"), new class implements BpmProtocol {
    async detect(audioData: AudioData, moduleUrl: string): Promise<number> {
        return detectBpm(audioData, moduleUrl)
    }
})

Communicator.executor(messenger.channel("material"), new class implements AudioMaterialProtocol {
    async analyze(audioData: AudioData, moduleUrl: string): Promise<AudioMaterialFeatures> {
        return analyzeMaterial(audioData, moduleUrl)
    }
})

Communicator.executor(messenger.channel("latency-calibration"), new class implements LatencyCalibrationProtocol {
    async analyze(input: LatencyCalibrationInput): Promise<LatencyCalibrationAnalysis> {
        return analyzeBursts(input)
    }
})

messenger.channel("initialize").send("ready")