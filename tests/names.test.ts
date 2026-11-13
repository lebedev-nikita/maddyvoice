import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { Paths } from "../src/core.ts";
import { ModelProxy } from "../src/model.ts";
import {
  autocorrect,
  decodeNames,
  findTriggers,
  keywordsFor,
  NameChecker,
  triggerPrompt,
} from "../src/names.ts";

const names = decodeNames([
  { name: "Сасавот", aliases: ["Сосавот", "Сасыч"] },
  { name: "Галя", aliases: ["Гхаля", "Гхалка"] },
  { name: "Анар Абдулаев", aliases: ["Анал Обдуваев"] },
  { name: "VJLink", aliases: ["Виджелинк", "Виджей Линк", "Рыжий Демон"] },
  { name: "Озон", aliases: ["озон", "Азон"] },
  { name: "Зио", aliases: ["Зива"] },
  { name: "BadComedian", aliases: ["Бед Комедиан"] },
  { name: "Твич", aliases: ["Twitch"] },
  { name: "Давг", aliases: [{ text: "давка", meaning: "Давг — стример" }] },
  { name: "Кологривый", aliases: ["Калогривый"] },
  { name: "Факер", aliases: ["факер", "MistaFaker"] },
  { name: "Человек-паук 2", aliases: ["Человек паук 2"] },
  { name: "Человек-паук", aliases: ["Человек паук"] },
]);

describe("names dictionary", () => {
  it("keeps Russian endings when a declining name is corrected", () => {
    expect(autocorrect("Сосавот сказал Сосавоту и сасычем", names)).toBe(
      "Сасавот сказал Сасавоту и Сасавотом",
    );
    expect(autocorrect("Гхаля, Гхалю, Гхалкой, Гхалку", names)).toBe("Галя, Галю, Галей, Галю");
    expect(autocorrect("у Анала Обдуваева", names)).toBe("у Анара Абдулаева");
  });

  it("writes Latin spellings without endings and Cyrillic ones from Latin", () => {
    expect(autocorrect("по Виджелинку и Виджей Линку на Twitch", names)).toBe(
      "по VJLink и VJLink на Твич",
    );
    expect(autocorrect("у Рыжего Демона и Бед Комедиана, а озоны — это Озон", names)).toBe(
      "у VJLink и BadComedian, а Озоны — это Озон",
    );
  });

  it("declines adjectival surnames and fixes the case of a nickname", () => {
    expect(autocorrect("у Калогривого и Калогривым", names)).toBe("у Кологривого и Кологривым");
    expect(autocorrect("Зива и Зиву, у Азона", names)).toBe("Зио и Зио, у Озона");
    expect(autocorrect("факер и MistaFaker", names)).toBe("Факер и Факер");
  });

  it("turns a common word into a name only where a verdict confirms it", () => {
    const text = "Вот все играют в Baby Steps, давка прошел. В метро была давка.";
    const triggers = findTriggers(text, names);
    expect(triggers.map((trigger) => [trigger.heard, trigger.replacement])).toEqual([
      ["давка", "Давг"],
      ["давка", "Давг"],
    ]);
    expect(autocorrect(text, names)).toBe(text);
    expect(autocorrect(text, names, new Set([triggers[0]!.key]))).toBe(
      "Вот все играют в Baby Steps, Давг прошел. В метро была давка.",
    );
    expect(findTriggers(text, names)[1]!.key).toBe(triggers[1]!.key);
  });

  it("asks the model once for all trigger words and requires a verdict for each", async () => {
    const triggers = findTriggers("давка прошел, а в метро давка", names);
    const prompts: string[] = [];
    const judge = (verdicts: unknown) =>
      Effect.runPromise(
        NameChecker.use((checker) => checker.judge(triggers)).pipe(
          Effect.provide(
            NameChecker.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  ModelProxy,
                  ModelProxy.of({
                    model: "test",
                    json: (request) => {
                      prompts.push(request.prompt);
                      return Effect.succeed(verdicts);
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    const verdicts = await judge({
      verdicts: [
        { id: 0, name: true },
        { id: 1, name: false },
      ],
    });
    expect([...verdicts.values()]).toEqual([true, false]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(triggerPrompt(triggers));
    await expect(judge({ verdicts: [{ id: 0, name: true }] })).rejects.toThrow();
  });

  it("matches whole words and never rewrites a correction", () => {
    expect(autocorrect("Сосавотик и Человек паук 2", names)).toBe("Сосавотик и Человек-паук 2");
    expect(autocorrect("сайт Сосавот.ru и @Сосавот", names)).toBe("сайт Сосавот.ru и @Сосавот");
  });

  it("hints the names of nearby posts first, in any form the dictionary knows", () => {
    expect(keywordsFor(names, ["Сегодня Виджелинку и Сосавоту не до этого", "Озона нет"])).toEqual([
      "Сасавот",
      "VJLink",
      "Озон",
      "Галя",
      "Анар Абдулаев",
      "Зио",
      "BadComedian",
      "Твич",
      "Давг",
      "Кологривый",
      "Факер",
      "Человек-паук 2",
      "Человек-паук",
    ]);
  });

  it("refuses duplicate names and characters the API rejects", () => {
    expect(() => decodeNames([{ name: "Озон" }, { name: "Твич", aliases: ["озон"] }])).toThrow(
      "appears twice",
    );
    expect(() => decodeNames([{ name: "<Озон>" }])).toThrow();
  });

  it("ships a valid dictionary that fits the transcription keyword limit", async () => {
    const shipped = decodeNames(JSON.parse(await readFile(Paths.names, "utf8")));
    expect(shipped.length).toBeLessThanOrEqual(900);
  });
});
