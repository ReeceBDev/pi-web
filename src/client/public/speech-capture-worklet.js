// Runs inside an AudioWorkletGlobalScope. Forwards raw Float32 mono capture
// frames to the main thread; resampling and int16 conversion happen there.
class SpeechCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input !== undefined && input.length > 0) {
      this.port.postMessage(input[0]);
    }
    return true;
  }
}

registerProcessor("speech-capture", SpeechCaptureProcessor);
