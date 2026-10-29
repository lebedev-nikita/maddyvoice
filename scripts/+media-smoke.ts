import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Settings } from "../src/core.ts";
import { Media } from "../src/media.ts";
import { Thumbnails } from "../src/thumbnail.ts";

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "maddyvoice-media-smoke-"));
const originalFetch = globalThis.fetch;
try {
  const audio = join(directory, "audio.wav");
  const red = join(directory, "red.png");
  const blue = join(directory, "blue.png");
  await exec("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    audio,
  ]);
  for (const [color, path] of [
    ["red", red],
    ["blue", blue],
  ] as const) {
    await exec("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${color}:size=640x480`,
      "-frames:v",
      "1",
      path,
    ]);
  }
  const bytes = new Map([
    ["https://cdn4.telesco.pe/audio", await readFile(audio)],
    ["https://cdn4.cdn-telegram.org/red", await readFile(red)],
    ["https://cdn4.cdn-telegram.org/blue", await readFile(blue)],
  ]);
  const fakeFetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      const data = bytes.get(url);
      assert(data, `Unexpected request ${url}`);
      return new Response(data);
    },
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = fakeFetch;
  const settings = Layer.succeed(
    Settings,
    Settings.of({
      channel: "maddysontg",
      dataDir: directory,
      pollSeconds: 300,
      privacy: "private",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      expectedChannel: "",
    }),
  );
  const media = Media.layer.pipe(Layer.provide(settings), Layer.provide(BunServices.layer));
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Media).render(
        {
          id: 1,
          date: "2026-10-26T01:02:03.000Z",
          text: "",
          forwarded: false,
          url: "https://t.me/maddysontg/1",
          audio: ["https://cdn4.telesco.pe/audio"],
          images: ["https://cdn4.cdn-telegram.org/red", "https://cdn4.cdn-telegram.org/blue"],
        },
        0,
        "slideshow",
      );
    }).pipe(Effect.provide(media)),
  );
  for (const [time, dominant] of [
    ["0.3", 0],
    ["1.5", 2],
    ["1.9", 2],
  ] as const) {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-ss",
        time,
        "-i",
        output.path,
        "-frames:v",
        "1",
        "-vf",
        "crop=1:1:960:540,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    assert(
      (stdout[dominant] ?? 0) > 150,
      `Wrong slide color at ${time}s: ${[...stdout].join(",")}`,
    );
  }
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,width,height,duration:format=duration",
    "-of",
    "json",
    output.path,
  ]);
  const probe = JSON.parse(stdout) as {
    format: { duration: string };
    streams: { codec_name: string; width?: number; height?: number; duration: string }[];
  };
  assert(
    probe.streams.some(
      (stream) => stream.codec_name === "h264" && stream.width === 1920 && stream.height === 1080,
    ),
  );
  assert(probe.streams.some((stream) => stream.codec_name === "aac"));
  assert(probe.streams.every((stream) => Math.abs(Number(stream.duration) - 2) < 0.1));
  assert(Math.abs(Number(probe.format.duration) - 2) < 0.1);
  const thumbnail = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Thumbnails).render(
        "Большой рассказ",
        join(directory, "thumbnails", "quote.png"),
      );
    }).pipe(Effect.provide(Thumbnails.layer), Effect.provide(BunServices.layer)),
  );
  const image = await readFile(thumbnail);
  assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 720);
  console.log(
    "Media smoke passed: ordered slides, H.264 1080p + AAC, full duration, 1280x720 quote thumbnail",
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
