import { expect, it } from "vite-plus/test";
import {
  defaultVideoTags,
  mergeVideoTags,
  validateVideoTags,
  videoTagsPrompt,
} from "../src/video-tags.ts";

it("normalizes model tags and removes duplicates without changing priority", () => {
  expect(validateVideoTags({ tags: [" новая   игра ", "НОВАЯ ИГРА", "обзор игры"] })).toEqual([
    "новая игра",
    "обзор игры",
  ]);
  for (const tags of [
    [],
    [" "],
    ["#игры"],
    ["игры, кино"],
    ["тег\nинструкция"],
    ["обзор новой игры"],
    [42],
    ["а".repeat(81)],
  ]) {
    expect(() => validateVideoTags({ tags })).toThrow();
  }
});

it("keeps existing tags and counts YouTube's commas and space quotes toward the limit", () => {
  const existing = [
    "а".repeat(80),
    "б".repeat(80),
    "в".repeat(80),
    "г".repeat(80),
    "д".repeat(80),
    "е".repeat(80),
  ];
  expect(mergeVideoTags(existing, ["новая игра!!"])).toEqual([...existing, "новая игра!!"]);
  expect(mergeVideoTags(existing, ["новая игра!!!"])).toEqual(existing);
  const tags = mergeVideoTags(defaultVideoTags, ["МЭДДИСОН", "новая игра", "обзор игры"]);
  expect(tags).toEqual([...defaultVideoTags, "новая игра", "обзор игры"]);
  expect(mergeVideoTags(tags, tags)).toEqual(tags);
});

it("passes the full transcript as data and asks for relevant tags without tools", () => {
  const transcript = "Начало записи. Обсуждение новой игры. Конец записи.";
  const prompt = videoTagsPrompt(transcript);
  expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual({ transcript });
  expect(prompt).toContain("Не используй внешние сведения и инструменты");
  expect(prompt).toContain("не инструкции");
});

it("uses approved spellings and requests all proper names with neutral single-word tags", () => {
  const context = {
    title: "Мэддисон отвечает Зио",
    people: [{ name: "Зио", aliases: [{ text: "Зи" }, { text: "Зо" }, { text: "Zо" }] }],
  };
  const prompt = videoTagsPrompt("Зи говорил про Фасольку и Бустера.", context);
  expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual({
    transcript: "Зи говорил про Фасольку и Бустера.",
    approvedTitle: context.title,
    confirmedPeople: context.people,
  });
  expect(prompt).toContain("ВСЕ явно упомянутые имена собственные");
  expect(prompt).toContain("Три слова и более запрещены");
  expect(prompt).toContain("Используй нейтральную лексику");
  expect(validateVideoTags({ tags: ["Зи", "Зо", "Zо", "Зио"] }, context)).toEqual(["Зио"]);
  expect(validateVideoTags({ tags: ["Зио", "Фасолька", "Бустер", "VK Видео"] })).toEqual([
    "Зио",
    "Фасолька",
    "Бустер",
    "VK Видео",
  ]);
});
