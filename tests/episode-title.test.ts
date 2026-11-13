import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import {
  chapterLines,
  chapterTime,
  EpisodeTitler,
  episodeTitlePrompt,
  validateEpisodeDraft,
} from "../src/episode-title.ts";
import { ModelProxy, type ModelRequest } from "../src/model.ts";

const voices = [
  { start: 0, transcript: "Короче, по Давгу возможна отмена голосования." },
  { start: 10.7, transcript: "Решение по Озону и VJLink ставится на паузу." },
  { start: 328.1, transcript: "Мы нашли решение: кандидаты пройдут Baby Steps за один стрим." },
  { start: 3725, transcript: "Давг прошёл Baby Steps, Озон тоже неплохо играет." },
];

describe("episode title and chapters", () => {
  it("passes every transcript with its start and asks for the main topic", () => {
    const prompt = episodeTitlePrompt(voices);
    const data = JSON.parse(prompt.split("\n").at(-1)!);
    expect(data.voices.map((voice: { start: string }) => voice.start)).toEqual([
      "0:00",
      "0:10",
      "5:28",
      "1:02:05",
    ]);
    expect(prompt).toContain("основной теме");
    expect(prompt).toContain("Не перечисляй темы");
  });

  it("gives every voice its own chapter", () => {
    const titles = [
      "Отмена для Давга",
      "Пауза в решении",
      "Испытание Baby Steps",
      "Итоги прохождения",
    ];
    const draft = validateEpisodeDraft(
      { topic: "о голосовании за участников ивента", chapters: titles },
      voices,
    );
    expect(draft.chapters).toEqual(
      titles.map((title, index) => ({ start: voices[index]!.start, title })),
    );
    for (const chapters of [titles.slice(1), [...titles, "Лишняя"], [...titles.slice(0, 3), "Я"]])
      expect(() =>
        validateEpisodeDraft({ topic: "о голосовании за участников", chapters }, voices),
      ).toThrow();
  });

  it("writes YouTube chapter lines and lets a voice under ten seconds open the next", () => {
    const chapters = [
      { start: 0, title: "Отмена для Давга" },
      { start: 10.7, title: "Пауза в решении" },
      { start: 328.1, title: "Испытание Baby Steps" },
    ];
    expect(chapterLines(chapters, 400)).toEqual([
      "0:00 Отмена для Давга",
      "0:10 Пауза в решении",
      "5:28 Испытание Baby Steps",
    ]);
    expect(chapterLines(chapters.slice(0, 2), 400)).toEqual([]);
    expect(
      chapterLines(
        [{ start: 0, title: "Короткое" }, { start: 5, title: "Начало" }, ...chapters.slice(1)],
        335,
      ),
      // The short last voice joins the one before, leaving two chapters: too few for YouTube.
    ).toEqual([]);
    expect(
      chapterLines(
        [{ start: 0, title: "Короткое" }, { start: 5, title: "Начало" }, ...chapters.slice(1)],
        400,
      ),
    ).toEqual(["0:00 Начало", "0:10 Пауза в решении", "5:28 Испытание Baby Steps"]);
    expect(chapterTime(3725.9)).toBe("1:02:05");
  });

  it("returns the reviewed title with the chapters of the same draft", async () => {
    const requests: ModelRequest[] = [];
    const drafts = [
      { topic: "о первом черновике", chapters: ["Первый", "Первый", "Первый", "Первый"] },
      { topic: "о голосовании за участников", chapters: ["Отмена", "Пауза", "Проверка", "Итоги"] },
    ];
    const proxy = Layer.succeed(
      ModelProxy,
      ModelProxy.of({
        model: "test",
        json: (request) => {
          requests.push(request);
          if (request.prompt.startsWith("Ниже расшифровки")) return Effect.succeed(drafts.shift());
          const supported = requests.length > 2;
          return Effect.succeed({
            supported,
            claims: [{ claim: "Речь о голосовании", quote: supported ? "Решение по Озону" : null }],
            reason: "Проверено по расшифровке",
          });
        },
      }),
    );
    const result = await Effect.runPromise(
      EpisodeTitler.use((titler) => titler.title(voices)).pipe(
        Effect.provide(EpisodeTitler.layer.pipe(Layer.provide(proxy))),
      ),
    );
    expect(result).toEqual({
      topic: "о голосовании за участников",
      title: "Мэддисон о голосовании за участников",
      chapters: ["Отмена", "Пауза", "Проверка", "Итоги"].map((title, index) => ({
        start: voices[index]!.start,
        title,
      })),
    });
    expect(requests).toHaveLength(4);
  });
});
