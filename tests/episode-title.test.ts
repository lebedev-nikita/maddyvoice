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

  it("starts chapters at the first voice and keeps them in order", () => {
    const draft = validateEpisodeDraft(
      {
        topic: "о голосовании за участников ивента",
        chapters: [
          { voice: 0, title: "Отмена для Давга" },
          { voice: 2, title: "Испытание Baby Steps" },
        ],
      },
      voices,
    );
    expect(draft.chapters).toEqual([
      { start: 0, title: "Отмена для Давга" },
      { start: 328.1, title: "Испытание Baby Steps" },
    ]);
    for (const chapters of [
      [{ voice: 1, title: "Начало" }],
      [
        { voice: 0, title: "Начало" },
        { voice: 0, title: "Повтор" },
      ],
      [
        { voice: 0, title: "Начало" },
        { voice: 4, title: "Нет такого" },
      ],
    ])
      expect(() =>
        validateEpisodeDraft({ topic: "о голосовании за участников", chapters }, voices),
      ).toThrow();
  });

  it("writes YouTube chapter lines only when YouTube would show them", () => {
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
      chapterLines([{ start: 0, title: "А" }, { start: 5, title: "Б" }, chapters[2]!], 400),
    ).toEqual([]);
    expect(chapterTime(3725.9)).toBe("1:02:05");
  });

  it("returns the reviewed title with the chapters of the same draft", async () => {
    const requests: ModelRequest[] = [];
    const drafts = [
      { topic: "о первом черновике", chapters: [{ voice: 0, title: "Первый" }] },
      { topic: "о голосовании за участников", chapters: [{ voice: 0, title: "Второй" }] },
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
      title: "Мэддисон о голосовании за участников",
      chapters: [{ start: 0, title: "Второй" }],
    });
    expect(requests).toHaveLength(4);
  });
});
