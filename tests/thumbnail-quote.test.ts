import { expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { AppError } from "../src/core.ts";
import {
  reviewedThumbnailQuote,
  thumbnailQuotePrompt,
  thumbnailReviewPrompt,
  validateThumbnailQuote,
  validateThumbnailReview,
} from "../src/thumbnail-quote.ts";
import { maskObscenities, thumbnailLines, thumbnailText } from "../src/thumbnail.ts";

const transcript = "Вы просто супер. Я просто в шоке, на самом деле. Спасибо вам большое.";

it("accepts only short consecutive original words, preserving punctuation and case", () => {
  expect(validateThumbnailQuote({ thumbnailQuote: "Вы просто супер." }, transcript)).toBe(
    "Вы просто супер.",
  );
  for (const quote of [
    "Вы вообще не спите?",
    "Вы супер",
    "вы просто супер.",
    "про",
    "Вы просто супер. Я просто",
    "[фыркает]",
  ])
    expect(() => validateThumbnailQuote({ thumbnailQuote: quote }, transcript)).toThrow();
  expect(validateThumbnailQuote({ thumbnailQuote: "Какая-то радость!" }, "Какая-то радость!")).toBe(
    "Какая-то радость!",
  );
});

it("requires reviewer context to be literal and to contain the chosen quote", () => {
  const review = {
    supported: true,
    contextQuote: "Вы просто супер.",
    reason: "Автор благодарит зрителей.",
  };
  expect(validateThumbnailReview(review, transcript, "Вы просто супер.")).toEqual(review);
  expect(() => validateThumbnailReview(review, transcript, "Спасибо вам большое.")).toThrow(
    "context",
  );
  expect(() =>
    validateThumbnailReview(
      { ...review, contextQuote: "Несуществующая речь" },
      transcript,
      "Вы просто супер.",
    ),
  ).toThrow("context");
});

it("regenerates a literal but tonally misleading excerpt after independent rejection", async () => {
  const drafts = ["Я просто в шоке,", "Вы просто супер."];
  let calls = 0;
  const checked: string[] = [];
  const result = await Effect.runPromise(
    reviewedThumbnailQuote(
      transcript,
      () => Effect.succeed({ thumbnailQuote: drafts[calls++] }),
      (quote) => {
        checked.push(quote);
        return Effect.succeed({
          supported: quote === drafts[1],
          contextQuote: transcript,
          reason: "Общий тон речи — благодарность и радость, без тревоги.",
        });
      },
    ),
  );
  expect(result).toBe(drafts[1]);
  expect(checked).toEqual(drafts);
  expect(JSON.parse(thumbnailQuotePrompt(transcript).split("\n").at(-1)!)).toEqual({ transcript });
  expect(JSON.parse(thumbnailReviewPrompt(transcript, result).split("\n").at(-1)!)).toEqual({
    transcript,
    thumbnailQuote: result,
  });
});

it("fails closed on repeated invalid drafts and propagates model failures without immediate retries", async () => {
  let calls = 0;
  await expect(
    Effect.runPromise(
      reviewedThumbnailQuote(
        transcript,
        () => {
          calls++;
          return Effect.succeed({ thumbnailQuote: "Придуманный текст" });
        },
        () => Effect.die("Invalid quotes must not reach the reviewer"),
      ),
    ),
  ).rejects.toThrow("3 independent attempts");
  expect(calls).toBe(3);
  calls = 0;
  await expect(
    Effect.runPromise(
      reviewedThumbnailQuote(
        transcript,
        () => {
          calls++;
          return Effect.fail(new AppError({ message: "Model usage limit" }));
        },
        () => Effect.die("Generation failed"),
      ),
    ),
  ).rejects.toThrow("usage limit");
  expect(calls).toBe(1);
});

it("wraps text without dropping words or evaluating FFmpeg expansions", () => {
  expect(thumbnailLines("Вы просто супер.").join(" ")).toBe("Вы просто супер");
  expect(thumbnailLines("Это 100%: %{n}!").join(" ")).toBe("Это 100%: %{n}");
});

it.each([
  ["Вы просто супер.", "Вы просто супер"],
  ["Спасибо вам!", "Спасибо вам"],
  ["Я просто в шоке,", "Я просто в шоке"],
  ["Я решил…", "Я решил"],
  ["Вот так...", "Вот так"],
  ["Ну и что?!", "Ну и что?"],
  ["Это вопрос?", "Это вопрос?"],
  ["Это вопрос???", "Это вопрос?"],
  ["Что, правда?  ", "Что, правда?"],
  ["Как-то так;", "Как-то так"],
  ["Выбор:", "Выбор"],
  ["Ну —", "Ну"],
  ["Это 100%", "Это 100%"],
  ["%{n}!", "%{n}"],
  ["Без пунктуации", "Без пунктуации"],
])("formats the thumbnail ending while preserving the excerpt: %s", (quote, expected) => {
  expect(thumbnailText(quote)).toBe(expected);
  expect(thumbnailLines(quote).join(" ")).toBe(expected);
});

it.each([
  ["Я пиздеть не буду,", "Я п*здеть не буду"],
  ["Ну нахуй", "Ну нах*й"],
  ["Охуенно!", "Ох*енно"],
  ["Хули ты", "Х*ли ты"],
  ["Блядь, опять", "Бл*дь, опять"],
  ["Ебать копать", "Е*ать копать"],
  ["Заебал уже", "Зае*ал уже"],
  ["Долбоёб", "Долбоё*"],
  ["Распиздяй", "Расп*здяй"],
  ["Сука", "С*ка"],
  ["Мудак", "М*дак"],
  ["Пидорас", "П*дорас"],
  ["Надрочил", "Надр*чил"],
])("stars obscenities in the thumbnail text: %s", (quote, expected) => {
  expect(thumbnailText(quote)).toBe(expected);
  expect(thumbnailText(expected)).toBe(expected);
});

it("keeps ordinary words that resemble obscenities", () => {
  const text =
    "Себе небо хлеб ребёнок сабля рубля бляха страхуй хулиган художник хуже сукно сучок мудрый мандарин";
  expect(maskObscenities(text)).toBe(text);
});
