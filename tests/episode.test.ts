import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { groupEpisodes, type Recording } from "../src/episode.ts";
import { episodeAround } from "../src/episode-preview.ts";
import { Telegram, type Post } from "../src/telegram.ts";

const hour = 3600_000;
const start = Date.parse("2026-11-08T09:00:00.000Z");
const post = (id: number, hours: number, kind: "voice" | "text" = "text"): Post => ({
  id,
  url: `https://t.me/maddysontg/${id}`,
  date: new Date(start + hours * hour).toISOString(),
  text: kind === "voice" ? "" : "Пост",
  audio: kind === "voice" ? [`https://cdn4.telesco.pe/${id}.ogg`] : [],
  images: [],
  forwarded: false,
});
const ids = (recordings: readonly Recording[]) => recordings.map((item) => item.post.id);

describe("episode grouping", () => {
  it("keeps voices together until six hours of silence and preserves their order", () => {
    const episodes = groupEpisodes([
      post(5, 13.5, "voice"),
      post(1, 0, "voice"),
      post(3, 5.9, "voice"),
      post(4, 7.5, "voice"),
      post(6, 19.5, "voice"),
    ]);
    expect(episodes.map(ids)).toEqual([[1, 3, 4], [5], [6]]);
  });

  it("emits every recording of a post in order", () => {
    const double = { ...post(1, 0, "voice"), audio: ["https://t.me/a.ogg", "https://t.me/b.ogg"] };
    const [episode] = groupEpisodes([double, post(2, 1, "voice")]);
    expect(episode?.map((item) => [item.post.id, item.audioIndex])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
  });

  it("leaves out forwarded voices and text posts", () => {
    const episodes = groupEpisodes([
      post(1, 0, "voice"),
      { ...post(2, 0.1, "voice"), forwarded: true },
      post(3, 0.2),
      post(4, 7),
      post(5, 8, "voice"),
    ]);
    expect(episodes.map(ids)).toEqual([[1], [5]]);
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
    const { episode, nearby, complete } = await around(7);
    expect(ids(episode)).toEqual([5, 7, 9]);
    // Text posts from three hours before the first voice to three hours after the last.
    expect(nearby).toHaveLength(5);
    expect(complete).toBe(true);
  });

  it("stops at either end of the channel", async () => {
    expect(ids((await around(1)).episode)).toEqual([1]);
    expect(ids((await around(15)).episode)).toEqual([15]);
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
