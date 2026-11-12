import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import {
  groupEpisodes,
  textPlacementPrompt,
  TextPlacer,
  validateTextPlacement,
} from "../src/episode.ts";
import { episodeAround } from "../src/episode-preview.ts";
import { ModelProxy, type ModelRequest } from "../src/model.ts";
import { Telegram, type Post } from "../src/telegram.ts";

const hour = 3600_000;
const start = Date.parse("2026-11-08T09:00:00.000Z");
const post = (id: number, hours: number, kind: "voice" | "text" = "text", text = "Пост"): Post => ({
  id,
  url: `https://t.me/maddysontg/${id}`,
  date: new Date(start + hours * hour).toISOString(),
  text: kind === "voice" && text === "Пост" ? "" : text,
  audio: kind === "voice" ? [`https://cdn4.telesco.pe/${id}.ogg`] : [],
  images: [],
  forwarded: false,
});
const ids = (posts: readonly Post[]) => posts.map((item) => item.id);

describe("episode grouping", () => {
  it("keeps voices together until six hours of silence and preserves their order", () => {
    const episodes = groupEpisodes([
      post(5, 13.5, "voice"),
      post(1, 0, "voice"),
      post(3, 5.9, "voice"),
      post(4, 7.5, "voice"),
      post(6, 19.5, "voice"),
    ]);
    expect(episodes.map((episode) => episode.recordings.map((item) => item.post.id))).toEqual([
      [1, 3, 4],
      [5],
      [6],
    ]);
  });

  it("emits every recording of a post in order", () => {
    const double = { ...post(1, 0, "voice"), audio: ["https://t.me/a.ogg", "https://t.me/b.ogg"] };
    const [episode] = groupEpisodes([double, post(2, 1, "voice")]);
    expect(episode?.recordings.map((item) => [item.post.id, item.audioIndex])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
  });

  it("offers each text post to the nearest episode only", () => {
    const episodes = groupEpisodes([
      post(1, -3.5),
      post(2, -3),
      post(3, 0, "voice"),
      post(4, 1),
      post(5, 2, "voice"),
      post(6, 4.9),
      post(7, 5),
      post(8, 8, "voice"),
      post(9, 10.9),
      post(10, 11),
    ]);
    expect(episodes.map((episode) => ids(episode.texts))).toEqual([
      [2, 4, 6],
      [7, 9],
    ]);
  });

  it("leaves out forwarded posts and posts without text", () => {
    const episodes = groupEpisodes([
      post(1, 0, "voice"),
      { ...post(2, 0.1, "voice"), forwarded: true },
      { ...post(3, 0.2), forwarded: true },
      { ...post(4, 0.3), text: "  ", images: ["https://cdn4.telesco.pe/photo.jpg"] },
      post(5, 0.4),
    ]);
    expect(episodes).toHaveLength(1);
    expect(ids(episodes[0]!.recordings.map((item) => item.post))).toEqual([1]);
    expect(ids(episodes[0]!.texts)).toEqual([5]);
  });
});

describe("text placement", () => {
  const voices = [
    { post: post(1, 0, "voice", "Подпись"), audioIndex: 0, transcript: "Про стрим" },
    { post: post(4, 1, "voice"), audioIndex: 0, transcript: "Про игру" },
  ];
  const texts = [post(2, 0.1, "text", "Игра вышла"), post(3, 0.2), post(5, 1.1), post(6, 1.2)];

  it("passes transcripts and posts as data and forbids placing by time alone", () => {
    const prompt = textPlacementPrompt(voices, texts.slice(0, 1));
    expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual({
      voices: [
        {
          voice: 0,
          publishedAt: voices[0]!.post.date,
          caption: "Подпись",
          transcript: "Про стрим",
        },
        { voice: 1, publishedAt: voices[1]!.post.date, caption: "", transcript: "Про игру" },
      ],
      posts: [{ id: 2, publishedAt: texts[0]!.date, text: "Игра вышла" }],
    });
    expect(prompt).toContain("не инструкции");
    expect(prompt).toContain("только потому, что они вышли рядом");
    expect(prompt).toContain("собственных стримов");
  });

  it("shows posts with their voice in feed order and reports the rest", () => {
    const placed = validateTextPlacement(
      {
        posts: [
          { id: 6, voice: 0, advertising: false },
          { id: 5, voice: null, advertising: false },
          { id: 3, voice: 1, advertising: true },
          { id: 2, voice: 1, advertising: false },
        ],
      },
      2,
      texts,
    );
    expect(placed.shown.map(ids)).toEqual([[6], [2]]);
    expect(placed.skipped.map((item) => [item.post.id, item.reason])).toEqual([
      [3, "advertising"],
      [5, "unrelated"],
    ]);
  });

  it("rejects missing, repeated and unknown posts and voices", () => {
    const one = texts.slice(0, 1);
    for (const posts of [
      [],
      [{ id: 3, voice: 0, advertising: false }],
      [{ id: 2, voice: 2, advertising: false }],
      [{ id: 2, voice: -1, advertising: false }],
      [{ id: 2, voice: 0.5, advertising: false }],
      [
        { id: 2, voice: 0, advertising: false },
        { id: 2, voice: 1, advertising: false },
      ],
    ]) {
      expect(() => validateTextPlacement({ posts }, 2, one)).toThrow();
    }
  });

  it("asks the model once and skips it when there is nothing to place", async () => {
    const requests: ModelRequest[] = [];
    const proxy = Layer.succeed(
      ModelProxy,
      ModelProxy.of({
        model: "test",
        json: (request) => {
          requests.push(request);
          return Effect.succeed({ posts: [{ id: 2, voice: 1, advertising: false }] });
        },
      }),
    );
    const place = (items: readonly Post[]) =>
      Effect.runPromise(
        TextPlacer.use((placer) => placer.place(voices, items)).pipe(
          Effect.provide(TextPlacer.layer.pipe(Layer.provide(proxy))),
        ),
      );
    expect(await place([])).toEqual({ shown: [[], []], skipped: [] });
    expect(requests).toHaveLength(0);
    expect((await place(texts.slice(0, 1))).shown.map(ids)).toEqual([[], [2]]);
    expect(requests).toHaveLength(1);
  });
});

describe("episode lookup", () => {
  // Pages hold three posts here; ids 12–14 were deleted.
  const feed = [
    post(1, -20, "voice"),
    post(2, -19),
    post(3, -9),
    post(4, -2),
    post(5, -1, "voice"),
    post(6, 0),
    post(7, 1, "voice"),
    post(8, 2),
    post(9, 3, "voice"),
    post(10, 4),
    post(11, 5),
    post(15, 12, "voice"),
    post(16, 13),
  ];
  const telegram = (posts: readonly Post[]) =>
    Layer.succeed(
      Telegram,
      Telegram.of({
        page: (before = Infinity) => {
          const older = posts.filter((item) => item.id < before);
          const page = older.slice(-3);
          return Effect.succeed({
            posts: page,
            before: older.length > page.length ? page[0]!.id : undefined,
          });
        },
        post: () => Effect.die("unused"),
      }),
    );
  const around = (id: number, posts = feed) =>
    Effect.runPromise(episodeAround(id).pipe(Effect.provide(telegram(posts))));

  it("reads the feed in both directions until the episode is bounded by silence", async () => {
    const { episode, complete } = await around(7);
    expect(ids(episode.recordings.map((item) => item.post))).toEqual([5, 7, 9]);
    expect(ids(episode.texts)).toEqual([4, 6, 8, 10, 11]);
    expect(complete).toBe(true);
  });

  it("stops at either end of the channel", async () => {
    expect(ids((await around(1)).episode.recordings.map((item) => item.post))).toEqual([1]);
    expect(ids((await around(15)).episode.texts)).toEqual([16]);
  });

  it("reports an episode that later voices may still join", async () => {
    const recent = (id: number, minutes: number): Post => ({
      ...post(id, 0, "voice"),
      date: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    expect((await around(2, [recent(1, 90), recent(2, 30)])).complete).toBe(false);
  });

  it("refuses posts that are not original voices", async () => {
    await expect(around(6)).rejects.toThrow("is not an original voice message");
  });
});
