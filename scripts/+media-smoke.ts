import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { defaultChromium, Settings } from "../src/core.ts";
import { Media } from "../src/media.ts";
import { Thumbnails } from "../src/thumbnail.ts";

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "maddyvoice-media-smoke-"));
const originalFetch = globalThis.fetch;
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const duration = 4;
try {
  const audio = join(directory, "audio.wav");
  const red = join(directory, "red.png");
  const blue = join(directory, "blue.png");
  await exec(ffmpeg, [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${duration}`,
    "-af",
    "volume=0:enable='not(between(t,0.35,0.65))'",
    audio,
  ]);
  for (const [color, path] of [
    ["red", red],
    ["blue", blue],
  ] as const) {
    await exec(ffmpeg, [
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
  const emoji = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/1f525.png";
  const bytes = new Map([
    ["https://cdn4.telesco.pe/audio", await readFile(audio)],
    ["https://cdn4.cdn-telegram.org/red", await readFile(red)],
    ["https://cdn4.cdn-telegram.org/blue", await readFile(blue)],
    ["https://cdn4.telesco.pe/avatar", await readFile(red)],
    [emoji, await readFile(blue)],
  ]);
  const fakeFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      // Chromium's DevTools endpoint stays real.
      if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
      const data = bytes.get(url);
      assert(data, `Unexpected request ${url}`);
      return new Response(data, { headers: { "content-type": "image/png" } });
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
      ffmpeg,
      ffprobe: "ffprobe",
      chromium: process.env.CHROMIUM_PATH ?? defaultChromium(),
      expectedChannel: "",
    }),
  );
  const media = Media.layer.pipe(Layer.provide(settings), Layer.provide(BunServices.layer));
  const card = {
    author: "Канал",
    avatar: "https://cdn4.telesco.pe/avatar",
    views: "12.3K",
    edited: false,
    reactions: [
      {
        emoji: "🔥",
        image: "//telegram.org/img/emoji/40/F09F94A5.png",
        count: "1.2K",
        paid: false,
      },
      { emoji: "", image: "", count: "5", paid: true },
    ],
    waveforms: [Array.from({ length: 100 }, (_, index) => (index * 7) % 32)],
  };
  const render = (post: Parameters<Media["Service"]["render"]>[0], key: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Media).render(post, 0, key);
      }).pipe(Effect.provide(media)),
    );
  const output = await render(
    {
      id: 1,
      date: "2026-10-26T01:02:03.000Z",
      text: "Короткий текст",
      forwarded: false,
      url: "https://t.me/maddysontg/1",
      audio: ["https://cdn4.telesco.pe/audio"],
      images: ["https://cdn4.cdn-telegram.org/red", "https://cdn4.cdn-telegram.org/blue"],
      card,
    },
    "slideshow",
  );
  for (const [time, dominant] of [
    ["0.3", 0],
    ["2.5", 2],
    ["3.9", 2],
  ] as const) {
    const { stdout } = await exec(
      ffmpeg,
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
        "crop=1:1:400:540,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
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
    "stream=codec_name,width,height,duration,r_frame_rate:format=duration",
    "-of",
    "json",
    output.path,
  ]);
  const probe = JSON.parse(stdout) as {
    format: { duration: string };
    streams: {
      codec_name: string;
      width?: number;
      height?: number;
      duration: string;
      r_frame_rate: string;
    }[];
  };
  assert(
    probe.streams.some(
      (stream) =>
        stream.codec_name === "h264" &&
        stream.width === 1920 &&
        stream.height === 1080 &&
        stream.r_frame_rate === "30/1",
    ),
  );
  assert(probe.streams.some((stream) => stream.codec_name === "aac"));
  assert(probe.streams.every((stream) => Math.abs(Number(stream.duration) - duration) < 0.1));
  assert(Math.abs(Number(probe.format.duration) - duration) < 0.1);
  const pixels = async (time: number, crop: string, path = output.path) => {
    const result = await exec(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-ss",
        String(time),
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        `format=rgb24,crop=${crop}`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    return result.stdout;
  };
  const edge = await pixels(0.3, "1:1:10:540");
  assert(edge[0]! > 150, "Image must fill the frame without side bars");
  const logo = await pixels(0.3, "1:1:88:990");
  assert(
    logo.every((channel) => channel > 180),
    "YouTube branding must be visible",
  );
  // The card sits right of x=896; count its white bubble, blue (played) waveform pixels and
  // pure blue ones from the fake blue photo.
  const count = (frame: Buffer, test: (r: number, g: number, b: number) => boolean) => {
    let matches = 0;
    for (let offset = 0; offset < frame.length; offset += 3)
      if (test(frame[offset]!, frame[offset + 1]!, frame[offset + 2]!)) matches++;
    return matches;
  };
  const cardPixels = async (time: number, path = output.path) => {
    const frame = await pixels(time, "988:1040:896:20", path);
    return {
      white: count(frame, (r, g, b) => Math.min(r, g, b) > 245),
      blue: count(frame, (r, g, b) => Math.hypot(r - 64, g - 167, b - 227) < 30),
      photo: count(frame, (r, g, b) => Math.hypot(r, g, b - 255) < 60),
    };
  };
  const early = await cardPixels(0.2);
  const late = await cardPixels(3.8);
  assert(early.white > 100_000, `Post card must be visible: ${early.white} white pixels`);
  assert(
    late.blue > early.blue + 5_000,
    `Waveform progress must advance: ${early.blue} -> ${late.blue} blue pixels`,
  );
  const long = await render(
    {
      id: 2,
      date: "2026-10-26T01:02:03.000Z",
      text: Array.from({ length: 12 }, () => "Очень длинный абзац текста. ".repeat(20)).join(
        "\n\n",
      ),
      forwarded: false,
      url: "https://t.me/maddysontg/2",
      audio: ["https://cdn4.telesco.pe/audio"],
      images: [],
      card,
    },
    "long",
  );
  const background = await exec(
    ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      long.path,
      "-frames:v",
      "1",
      "-vf",
      "format=rgb24,crop=1:1:400:300",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const [r, g, b] = background.stdout;
  assert(
    !(r! > 150 && g! < 80 && b! < 80) && !(b! > 150 && r! < 80 && g! < 80),
    "A post without photos must use a rotating background",
  );
  // Two voices in one video: the first shows two text posts in turn, one with its own photo.
  const voice = (id: number, images: string[] = []) => ({
    id,
    date: "2026-10-26T01:02:03.000Z",
    text: "",
    forwarded: false,
    url: `https://t.me/maddysontg/${id}`,
    audio: ["https://cdn4.telesco.pe/audio"],
    images,
    card,
  });
  const episode = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Media).renderEpisode(
        [
          {
            post: voice(3),
            audioIndex: 0,
            texts: [
              {
                ...voice(4, ["https://cdn4.cdn-telegram.org/blue"]),
                audio: [],
                text: "Первый пост",
              },
              { ...voice(5), audio: [], text: "Второй пост" },
            ],
          },
          { post: voice(6, ["https://cdn4.cdn-telegram.org/red"]), audioIndex: 0, texts: [] },
        ],
        "episode",
      );
    }).pipe(Effect.provide(media)),
  );
  assert.deepEqual(
    episode.starts.map((start) => Math.round(start * 10) / 10),
    [0, duration],
  );
  assert(Math.abs(episode.duration - 2 * duration) < 0.2, `Episode lasts ${episode.duration}s`);
  const scene = async (time: number) => [...(await pixels(time, "1:1:400:540", episode.path))];
  const [first, third] = [await scene(1), await scene(5)];
  // The fake reaction emoji are blue as well, so the next post is the baseline.
  const [shownPhoto, nextPost] = [
    (await cardPixels(1, episode.path)).photo,
    (await cardPixels(3, episode.path)).photo,
  ];
  assert(
    !(first[2]! > 150 && first[0]! < 80 && first[1]! < 80),
    `A text post's photo must not replace the background: ${first.join(",")}`,
  );
  assert(
    shownPhoto > nextPost + 50_000,
    `A text post's photo must appear in its bubble only: ${shownPhoto} -> ${nextPost} pixels`,
  );
  assert(
    third[0]! > 150 && third[2]! < 80,
    `The second voice must show its own photo: ${third.join(",")}`,
  );
  const thumbnail = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Thumbnails).render(
        "Большой рассказ",
        { messageId: 2, publishedAt: "2026-10-26T01:02:03.000Z" },
        join(directory, "thumbnails", "quote.png"),
      );
    }).pipe(
      Effect.provide(
        Thumbnails.layer.pipe(Layer.provide(settings), Layer.provide(BunServices.layer)),
      ),
    ),
  );
  const image = await readFile(thumbnail);
  assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 720);
  // Right padding of the white post card, then the scene behind the portrait's hair.
  const thumbnailPixels = await Promise.all(
    ["crop=1:1:1215:360", "crop=1:1:20:20"].map((crop) =>
      exec(
        ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          thumbnail,
          "-vf",
          `format=rgb24,${crop}`,
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer" },
      ).then(({ stdout }) => [...stdout]),
    ),
  );
  assert(
    thumbnailPixels[0]!.every((channel) => channel > 245),
    "The thumbnail quote sits on a white card",
  );
  assert(
    !thumbnailPixels[1]!.every((channel) => channel > 230),
    "The thumbnail shows the video scene",
  );
  console.log(
    "Media smoke passed: full-frame slides, branding, post card with waveform progress, background for long posts, two-voice episode with text posts, H.264 1080p30 + AAC, full duration, quote thumbnail",
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
