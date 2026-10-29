export const Waveform = {
  fps: 60,
  sampleRate: 24_000,
  sampleStep: 0.005,
  columnDelay: 0.0625,
  columns: 49,
  left: 1248,
  top: 948,
  width: 600,
  height: 96,
} as const;

const hop = 120;
const window = 960;
const blockSize = 16_384;
const attack = 1 - Math.exp(-Waveform.sampleStep / 0.018);
const release = 1 - Math.exp(-Waveform.sampleStep / 0.065);

/** Streaming mono f32le analysis: keep 40 ms of PCM and one level per 5 ms. */
export class WaveformAnalyzer {
  private pending = Buffer.alloc(0);
  private readonly squares = new Float64Array(window);
  private readonly blocks: Float32Array[] = [new Float32Array(blockSize)];
  private samples = 0;
  private count = 1;
  private energy = 0;
  private smoothed = 0;

  write(chunk: Uint8Array): void {
    const bytes = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const end = bytes.length - (bytes.length % 4);
    for (let offset = 0; offset < end; offset += 4) this.sample(bytes.readFloatLE(offset));
    this.pending = Buffer.from(bytes.subarray(end));
  }

  private sample(value: number): void {
    if (!Number.isFinite(value)) throw new Error("Invalid decoded audio sample");
    const slot = this.samples % window;
    const square = value * value;
    this.energy += square - this.squares[slot]!;
    this.squares[slot] = square;
    this.samples++;
    if (this.samples % hop !== 0) return;
    const rms = Math.sqrt(Math.max(0, this.energy) / Math.min(this.samples, window));
    this.smoothed += (rms - this.smoothed) * (rms > this.smoothed ? attack : release);
    const block = Math.floor(this.count / blockSize);
    this.blocks[block] ??= new Float32Array(blockSize);
    this.blocks[block]![this.count % blockSize] = this.smoothed;
    this.count++;
  }

  finish(): Float32Array {
    if (this.pending.length || !this.samples) throw new Error("Incomplete decoded audio");
    const levels = new Float32Array(this.count);
    for (const [index, block] of this.blocks.entries()) {
      const offset = index * blockSize;
      levels.set(block.subarray(0, Math.min(blockSize, this.count - offset)), offset);
    }
    const sorted = levels.slice().sort();
    const percentile = (fraction: number) => {
      const position = (sorted.length - 1) * fraction;
      const lower = Math.floor(position);
      const blend = position - lower;
      return sorted[lower]! * (1 - blend) + sorted[Math.ceil(position)]! * blend;
    };
    const noise = percentile(0.08) * 0.85;
    const range = Math.max(percentile(0.99) - noise, 1e-9);
    for (let i = 0; i < levels.length; i++) {
      levels[i] = Math.min(1, Math.max(0, (levels[i]! - noise) / range)) ** 0.92;
    }
    return levels;
  }
}

function levelAt(levels: Float32Array, time: number): number {
  if (time < 0 || !levels.length) return 0;
  const position = Math.min(time / Waveform.sampleStep, levels.length - 1);
  const lower = Math.floor(position);
  const blend = position - lower;
  return levels[lower]! * (1 - blend) + levels[Math.ceil(position)]! * blend;
}

const edgeOpacity = [0.24, 0.4, 0.6, 0.78, 0.92];
const accent = [
  [186, 220, 173],
  [171, 219, 156],
  [157, 216, 142],
] as const;

/** Straight-alpha RGBA; fixed capsule positions, delayed heights moving left. */
export function waveformFrame(levels: Float32Array, time: number): Uint8Array {
  const frame = new Uint8Array(Waveform.width * Waveform.height * 4);
  for (let column = 0; column < Waveform.columns; column++) {
    const value = levelAt(levels, time - (Waveform.columns - 1 - column) * Waveform.columnDelay);
    const halfBody = (76 * value) / 2;
    const opacity =
      (0.38 + 0.56 * Math.sqrt(value)) *
      (edgeOpacity[column] ?? (column === Waveform.columns - 1 ? 0.85 : 1));
    const color = accent[column - (Waveform.columns - 3)] ?? [231, 239, 232];
    const centerX = 8 + column * 12;
    for (let y = 0; y < Waveform.height; y++) {
      const dy = Math.max(Math.abs(y - 48) - halfBody, 0);
      for (let dx = -5; dx <= 5; dx++) {
        const coverage = Math.min(1, Math.max(0, 4 - Math.sqrt(dx * dx + dy * dy)));
        if (coverage === 0) continue;
        const pixel = (y * Waveform.width + centerX + dx) * 4;
        frame[pixel] = color[0]!;
        frame[pixel + 1] = color[1]!;
        frame[pixel + 2] = color[2]!;
        frame[pixel + 3] = Math.round(coverage * opacity * 255);
      }
    }
  }
  return frame;
}

export function* waveformFrames(levels: Float32Array, duration: number): Generator<Uint8Array> {
  for (let index = 0; index < Math.ceil(duration * Waveform.fps); index++) {
    yield waveformFrame(levels, index / Waveform.fps);
  }
}
