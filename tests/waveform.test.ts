import { describe, expect, it } from "vitest";
import { Waveform, WaveformAnalyzer, waveformFrame } from "../src/waveform.ts";

function speechFixture(): Buffer {
  const pcm = Buffer.alloc(Waveform.sampleRate * 3 * 4);
  for (let i = 0; i < pcm.length / 4; i++) {
    const time = i / Waveform.sampleRate;
    const gain = time > 0.3 && time < 0.6 ? 0.15 : time > 1 && time < 1.4 ? 0.7 : 0;
    pcm.writeFloatLE(gain * Math.sin((i * 2 * Math.PI * 240) / Waveform.sampleRate), i * 4);
  }
  return pcm;
}

function columnPixels(frame: Uint8Array, column: number): number[] {
  const values: number[] = [];
  for (let y = 0; y < Waveform.height; y++) {
    values.push(frame[(y * Waveform.width + 8 + column * 12) * 4 + 3]!);
  }
  return values;
}

describe("voice waveform", () => {
  it("analyzes arbitrary PCM chunk boundaries without changing speech timing", () => {
    const pcm = speechFixture();
    const contiguous = new WaveformAnalyzer();
    contiguous.write(pcm);
    const chunked = new WaveformAnalyzer();
    for (let offset = 0; offset < pcm.length; offset += 4093) {
      chunked.write(pcm.subarray(offset, offset + 4093));
    }
    const levels = chunked.finish();
    expect(levels).toEqual(contiguous.finish());
    expect(levels[40]).toBe(0);
    expect(levels[240]).toBeGreaterThan(levels[90]!);
    expect(levels[580]).toBeLessThan(0.001);
    expect(levels.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });

  it("renders silence as small dots and rejects truncated or empty PCM", () => {
    const analyzer = new WaveformAnalyzer();
    analyzer.write(Buffer.alloc(Waveform.sampleRate * 4));
    expect(analyzer.finish().every((level) => level === 0)).toBe(true);
    expect(() => new WaveformAnalyzer().finish()).toThrow("Incomplete");
    const truncated = new WaveformAnalyzer();
    truncated.write(new Uint8Array([0, 0, 0]));
    expect(() => truncated.finish()).toThrow("Incomplete");
    const frame = waveformFrame(new Float32Array(400), 1);
    expect(columnPixels(frame, 20).filter((alpha) => alpha > 0)).toHaveLength(7);
  });

  it("passes heights to the left while all capsule positions and widths stay fixed", () => {
    const levels = Float32Array.from({ length: 1000 }, (_, index) =>
      Math.exp(-(((index * Waveform.sampleStep - 0.75) / 0.08) ** 2)),
    );
    const before = waveformFrame(levels, 1.77);
    const after = waveformFrame(levels, 1.77 + Waveform.columnDelay);
    expect(columnPixels(after, 31)).toEqual(columnPixels(before, 32));
    expect(columnPixels(after, 32)).not.toEqual(columnPixels(before, 32));
    const baseline = (frame: Uint8Array) =>
      Array.from(
        { length: Waveform.width },
        (_, x) => frame[(48 * Waveform.width + x) * 4 + 3]! > 0,
      );
    expect(baseline(after)).toEqual(baseline(before));
    expect(before.length).toBe(Waveform.width * Waveform.height * 4);
  });
});
