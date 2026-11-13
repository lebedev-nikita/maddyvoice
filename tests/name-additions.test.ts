import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attempt, Paths, Settings } from "../src/core.ts";
import { Store } from "../src/database.ts";
import { ModelProxy } from "../src/model.ts";
import {
  extractionPrompt,
  foundNames,
  mergeAdditions,
  mergeAdditionsFile,
  NameAdditions,
  readRejectedNames,
} from "../src/name-additions.ts";
import { decodeNames, dictionaryKeys, keywordsFor, normalize } from "../src/names.ts";
import type { Post } from "../src/telegram.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const post = (id: number, text: string, date = `2026-11-${10 + id}T10:00:00.000Z`): Post => ({
  id,
  date,
  text,
  forwarded: false,
  images: [],
  audio: [],
  url: `https://t.me/maddysontg/${id}`,
});

describe("names found in posts", () => {
  const texts = ["Вчера заходил к Ксюше Шкреб и Сасавоту", "Ничего особенного"];

  it("keeps only names that the post mentions, in any Russian case", () => {
    expect(
      foundNames(
        {
          posts: [
            { id: 1, names: [] },
            {
              id: 0,
              names: ["Ксюша Шкреб", "Сасавот", "  Сасавот ", "Шкреб  Ксюша", "Москва", "<b>"],
            },
          ],
        },
        texts,
      ),
    ).toEqual([["Ксюша Шкреб", "Сасавот"], []]);
  });

  it("requires one answer for every post", () => {
    expect(() => foundNames({ posts: [{ id: 0, names: [] }] }, texts)).toThrow("exactly once");
    expect(() =>
      foundNames(
        {
          posts: [
            { id: 0, names: [] },
            { id: 0, names: [] },
          ],
        },
        texts,
      ),
    ).toThrow("exactly once");
  });
});

describe("keywords with additions", () => {
  const names = decodeNames([
    { name: "Сасавот", aliases: ["Сосавот"] },
    { name: "VJLink", aliases: ["Виджелинк"] },
  ]);

  it("hints additions after the file's names unless nearby posts mention them", () => {
    expect(keywordsFor(names, [], ["Шкреб", "сосавот", "Клюква"])).toEqual([
      "Сасавот",
      "VJLink",
      "Шкреб",
      "Клюква",
    ]);
    expect(keywordsFor(names, ["Клюкву и Виджелинка видели"], ["Шкреб", "Клюква"])).toEqual([
      "VJLink",
      "Клюква",
      "Сасавот",
      "Шкреб",
    ]);
  });

  it("caps the hints at a hundred names", () => {
    const additions = Array.from({ length: 200 }, (_, index) => `Имя${index}`);
    const keywords = keywordsFor(names, ["Пишу про Имя150"], additions);
    expect(keywords).toHaveLength(100);
    expect(keywords.slice(0, 3)).toEqual(["Имя150", "Сасавот", "VJLink"]);
  });
});

async function fixture(answer: (texts: readonly string[]) => unknown) {
  const dataDir = await mkdtemp(join(tmpdir(), "maddyvoice-names-test-"));
  temporary.push(dataDir);
  const prompts: string[] = [];
  const settings = Layer.succeed(
    Settings,
    Settings.of({
      channel: "maddysontg",
      dataDir,
      pollSeconds: 300,
      privacy: "public",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      chromium: "chromium",
      expectedChannel: "",
    }),
  );
  const proxy = Layer.succeed(
    ModelProxy,
    ModelProxy.of({
      model: "test",
      json: (request) =>
        Effect.sync(() => {
          prompts.push(request.prompt);
          const { posts } = Schema.decodeUnknownSync(
            Schema.Struct({ posts: Schema.Array(Schema.Struct({ text: Schema.String })) }),
          )(JSON.parse(request.prompt.slice(request.prompt.indexOf("\n{") + 1)));
          const texts = posts.map((item) => item.text);
          return answer(texts);
        }),
    }),
  );
  const layer = NameAdditions.database.pipe(
    Layer.provide(proxy),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(settings),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { prompts, run, dataDir };
}

// The fake model names every capitalised word of a post except the first.
const capitalised = (texts: readonly string[]) => ({
  posts: texts.map((text, id) => ({
    id,
    names: [...text.matchAll(/(?<=\s)\p{Lu}\p{L}+/gu)].map((match) => match[0]),
  })),
});

describe("name additions in the worker's database", () => {
  it("adds new names from each post once and orders them by mentions and recency", async () => {
    const f = await fixture(capitalised);
    const list = await f.run(
      Effect.gen(function* () {
        const additions = yield* NameAdditions;
        yield* additions.learn([
          post(1, "Вчера Клюква и Сасавот"),
          post(2, "Опять Клюква, а ещё Шкреб"),
          post(3, "Там были Сосавот и Путин"),
          { ...post(4, "Чужой пост про Форвард"), forwarded: true },
        ]);
        // Read posts are not sent again; a new one is.
        yield* additions.learn([post(2, "Опять Клюква, а ещё Шкреб"), post(5, "Вот Шкреб")]);
        return yield* additions.list();
      }),
    );
    expect(f.prompts).toHaveLength(2);
    const names = decodeNames(JSON.parse(await readFile(Paths.names, "utf8")));
    expect(f.prompts[0]).toBe(
      extractionPrompt(
        ["Вчера Клюква и Сасавот", "Опять Клюква, а ещё Шкреб", "Там были Сосавот и Путин"],
        names.map((entry) => entry.name),
      ),
    );
    // Сасавот and Сосавот are in the file, Путин in names-rejected.json.
    expect(list).toEqual([
      {
        name: "Шкреб",
        posts: 2,
        firstPost: "https://t.me/maddysontg/2",
        lastSeen: "2026-11-15T10:00:00.000Z",
      },
      {
        name: "Клюква",
        posts: 2,
        firstPost: "https://t.me/maddysontg/1",
        lastSeen: "2026-11-12T10:00:00.000Z",
      },
    ]);
  });

  it("never adds a rejected name again and drops names that leave the file", async () => {
    const f = await fixture(capitalised);
    const list = await f.run(
      Effect.gen(function* () {
        const additions = yield* NameAdditions;
        yield* additions.learn([post(1, "Вчера Клюква и Шкреб")]);
        yield* additions.reject(["клюква"]);
        // The deployed file used to hold Ларек and an addition that it now holds as well.
        const { db } = yield* Store;
        yield* attempt("Pretend an older dictionary", async () => {
          await db.query`INSERT INTO name_dictionary(key, name) VALUES ('ларек', 'Ларёк')`.run();
          await db.query`INSERT INTO name_additions(key, name, posts, created_at, updated_at)
            VALUES ('сасавот', 'Сасавот', 3, '', '')`.run();
        });
        yield* additions.learn([post(2, "Снова Клюква, Ларёк и Шкреб")]);
        const statuses = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String })),
        )(
          yield* attempt(
            "Read statuses",
            async () =>
              db.query`SELECT key, status FROM name_additions
              WHERE key IN ('клюква', 'ларек', 'сасавот', 'шкреб') ORDER BY key`,
          ),
        );
        expect(statuses).toEqual([
          { key: "клюква", status: "rejected" },
          { key: "ларек", status: "rejected" },
          { key: "сасавот", status: "moved" },
          { key: "шкреб", status: "added" },
        ]);
        return yield* additions.list();
      }),
    );
    expect(list.map((addition) => [addition.name, addition.posts])).toEqual([["Шкреб", 2]]);
  });

  it("keeps posts unread when the model's answer is invalid", async () => {
    const f = await fixture(() => ({ posts: [] }));
    const result = await f.run(
      NameAdditions.use((additions) => additions.learn([post(1, "Вчера Клюква")])).pipe(
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
    const again = await f.run(
      NameAdditions.use((additions) => additions.learn([post(1, "Вчера Клюква")])).pipe(
        Effect.result,
      ),
    );
    expect(again._tag).toBe("Failure");
    expect(f.prompts).toHaveLength(2);
  });

  it("splits many posts into several calls", async () => {
    const f = await fixture(capitalised);
    await f.run(
      NameAdditions.use((additions) =>
        additions.learn(Array.from({ length: 45 }, (_, index) => post(index + 1, `Пост ${index}`))),
      ),
    );
    expect(f.prompts).toHaveLength(3);
  });
});

describe("moving additions into the file", () => {
  const dictionary = `[
  { "name": "Сасавот", "aliases": ["Сосавот"] },
  { "name": "VJLink" }
]
`;

  it("appends new names after the file's own and keeps the rest of it", () => {
    const { text, added } = mergeAdditions(
      dictionary,
      ["Шкреб", "сосавот", "Путин", "Клюква", "шкреб"],
      ["Путин"],
    );
    expect(added).toEqual(["Шкреб", "Клюква"]);
    expect(text).toBe(`[
  { "name": "Сасавот", "aliases": ["Сосавот"] },
  { "name": "VJLink" },
  { "name": "Шкреб" },
  { "name": "Клюква" }
]
`);
    expect(mergeAdditions(dictionary, ["VJLink"], []).text).toBe(dictionary);
  });

  it("merges an export file into the dictionary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maddyvoice-merge-test-"));
    temporary.push(directory);
    const source = join(directory, "additions.json");
    const target = join(directory, "names.json");
    await writeFile(
      source,
      JSON.stringify([
        { name: "Шкреб", posts: 2, firstPost: "https://t.me/maddysontg/2", lastSeen: null },
      ]),
    );
    await writeFile(target, dictionary);
    expect(await Effect.runPromise(mergeAdditionsFile(source, target))).toEqual(["Шкреб"]);
    expect(decodeNames(JSON.parse(await readFile(target, "utf8"))).at(-1)).toEqual({
      name: "Шкреб",
    });
  });

  it("ships rejected names that the dictionary does not hold", async () => {
    const names = decodeNames(JSON.parse(await readFile(Paths.names, "utf8")));
    const rejected = await Effect.runPromise(readRejectedNames);
    const keys = dictionaryKeys(names);
    expect(rejected.filter((name) => keys.has(normalize(name)))).toEqual([]);
  });
});
