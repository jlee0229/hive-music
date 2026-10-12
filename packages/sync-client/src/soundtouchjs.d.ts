// soundtouchjs ships no types; this covers the two classes the pitch shifter uses.
declare module "soundtouchjs" {
  /** Frame source for SimpleFilter: fills `target` with interleaved stereo, returns frames written. */
  export interface StereoFrameSource {
    extract(target: Float32Array, numFrames: number, position: number): number;
  }
  export class SoundTouch {
    /** Pitch shift in semitones; tempo stays 1.0, so duration is preserved (WSOLA + transpose). */
    set pitchSemitones(semitones: number);
    /** Effective WSOLA tempo: the requested tempo divided by the pitch ratio. */
    get tempo(): number;
    set tempo(tempo: number);
    /** Effective resampling rate: the pitch ratio when tempo is 1. */
    get rate(): number;
    /** The WSOLA stage; its window sizes (in samples, at any sample rate) fix the render's lag. */
    readonly stretch: { readonly seekWindowLength: number; readonly seekLength: number };
  }
  export class SimpleFilter {
    constructor(sourceSound: StereoFrameSource, soundtouch: SoundTouch);
    /** Pulls processed frames into `target` (interleaved stereo); returns frames extracted. */
    extract(target: Float32Array, numFrames: number): number;
  }
}
