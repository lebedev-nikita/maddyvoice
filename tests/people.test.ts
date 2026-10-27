import { afterEach, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "../src/core.ts";
import {
  decodePeople,
  peopleForTranscript,
  readPeople,
  recordPeopleCandidates,
  resolvePeopleTopic,
} from "../src/people.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const evidence = "В записи обсуждают Зи и совместную игру с Фасолькой.";
const person = {
  id: "zio",
  name: "Зио",
  aliases: [
    { text: "Зи", context: ["фасольк"] },
    { text: "Зио", context: [] },
  ],
  sources: ["User correction"],
  verifiedAt: "2026-10-27",
};
const people = decodePeople([person]);
const draft = {
  topic: "попытки восстановить репутацию после спора",
  subjects: ["zio"],
  candidates: [],
};

it("uses the confirmed spelling for the real Зи → Зио regression", async () => {
  const registry = await Effect.runPromise(readPeople(Paths.people));
  const result = resolvePeopleTopic(draft, evidence, registry);
  expect(result.topic).toBe("о Зио: попытки восстановить репутацию после спора");
});

it("does not substitute a short alias without its context or inside another word", () => {
  for (const quote of ["В записи обсуждают Зи и новую игру.", "Зимой играют с Фасолькой."]) {
    expect(() => resolvePeopleTopic(draft, quote, people)).toThrow("contextual evidence");
  }
});

it("provides bounded exact evidence for known aliases and excludes unsupported people", () => {
  const transcript = "Вступление. ".repeat(60) + evidence + " Продолжение записи.".repeat(60);
  const context = peopleForTranscript(people, transcript);
  expect(context.map((entry) => entry.id)).toEqual(["zio"]);
  for (const quote of context[0]!.evidence) {
    expect(quote.length).toBeLessThanOrEqual(600);
    expect(transcript).toContain(quote);
    expect(resolvePeopleTopic(draft, transcript, people).topic).toMatch(/^о Зио:/);
  }
  expect(peopleForTranscript(people, "Зи обсуждает игры без контекстных подсказок.")).toEqual([]);
  expect(peopleForTranscript(people, "Зимой играют с Фасолькой.")).toEqual([]);
});

it("requires transcript evidence and rejects ambiguous or invented identities", () => {
  expect(() =>
    resolvePeopleTopic(draft, "Совсем другая запись без нужной цитаты.", people),
  ).toThrow("contextual evidence");
  expect(() => resolvePeopleTopic({ ...draft, subjects: ["unknown"] }, evidence, people)).toThrow(
    "unknown, ambiguous",
  );
  const ambiguous = decodePeople([person, { ...person, id: "another-zio" }]);
  expect(() => resolvePeopleTopic(draft, evidence, ambiguous)).toThrow("unknown, ambiguous");
});

it("accepts the full nickname without a contextual hint", () => {
  const quote = "Сегодня Зио обсуждает выбор игр для эфира.";
  expect(resolvePeopleTopic(draft, quote, people).topic).toMatch(/^о Зио:/);
});

it("allows distinct people in one quote while rejecting duplicate subjects", () => {
  const quote = "Зио и ДругойСтример обсуждают совместную игру.";
  const registry = decodePeople([
    person,
    {
      ...person,
      id: "other",
      name: "ДругойСтример",
      aliases: [{ text: "ДругойСтример", context: [] }],
    },
  ]);
  const subjects = ["zio", "other"];
  expect(resolvePeopleTopic({ ...draft, subjects }, quote, registry).topic).toMatch(
    /^о Зио и ДругойСтример:/,
  );
  expect(() => resolvePeopleTopic({ ...draft, subjects: ["zio", "zio"] }, quote, registry)).toThrow(
    "Duplicate title subject",
  );
});

it("rejects literal ASR nicknames, repeated authors and overlong titles", () => {
  expect(() =>
    resolvePeopleTopic({ ...draft, topic: "Попытки Зи восстановить репутацию" }, evidence, people),
  ).toThrow("literal person name");
  expect(() =>
    resolvePeopleTopic(
      { ...draft, topic: "Мэддисон обсуждает восстановление репутации" },
      evidence,
      people,
    ),
  ).toThrow("author");
  expect(() =>
    resolvePeopleTopic({ ...draft, topic: "Очень длинная тема ".repeat(8) }, evidence, people),
  ).toThrow();
});

it("keeps unconfirmed people in proposals and never inserts them into the title", () => {
  const quote = "Новыйстример обсуждает выбор игры для эфира.";
  const candidate = {
    observed: "Новыйстример",
    suggested: "НовыйСтример",
    evidence: quote,
    sources: [],
  };
  const result = resolvePeopleTopic(
    { ...draft, topic: "выборе игры для эфира", subjects: [], candidates: [candidate] },
    quote,
    people,
  );
  expect(result.topic).toBe("о выборе игры для эфира");
  expect(
    resolvePeopleTopic(
      { ...draft, topic: "о выборе игры для эфира", subjects: [], candidates: [] },
      quote,
      people,
    ).topic,
  ).toBe("о выборе игры для эфира");
  expect(result.candidates).toEqual([candidate]);
  expect(() =>
    resolvePeopleTopic(
      { ...draft, subjects: [], candidates: [{ ...candidate, evidence }] },
      quote,
      people,
    ),
  ).toThrow("Candidate evidence");
  expect(() =>
    resolvePeopleTopic(
      { ...draft, subjects: [], candidates: [{ ...candidate, sources: ["file:///secret"] }] },
      quote,
      people,
    ),
  ).toThrow("HTTPS");
});

it("reloads registry edits and fails on malformed or conflicting registry data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maddyvoice-people-test-"));
  temporary.push(directory);
  const path = join(directory, "people.json");
  await writeFile(path, JSON.stringify([person]));
  expect((await Effect.runPromise(readPeople(path)))[0]?.name).toBe("Зио");
  await writeFile(path, JSON.stringify([{ ...person, name: "Подтверждённый ник" }]));
  expect((await Effect.runPromise(readPeople(path)))[0]?.name).toBe("Подтверждённый ник");
  expect(() => decodePeople([person, person])).toThrow("duplicate IDs");
  await writeFile(path, "not json");
  await expect(Effect.runPromise(readPeople(path))).rejects.toThrow(
    "Read confirmed people registry",
  );
});

it("persists a bounded proposal atomically and deduplicates a retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maddyvoice-people-test-"));
  const workspace = await mkdtemp(join(directory, ".topic-"));
  temporary.push(directory);
  const candidate = {
    observed: "Новыйстример",
    suggested: "НовыйСтример",
    evidence: "Новыйстример выбирает игры.",
    sources: ["https://example.com/profile"],
  };
  await Effect.runPromise(recordPeopleCandidates([candidate], directory, workspace));
  await Effect.runPromise(recordPeopleCandidates([candidate], directory, workspace));
  const files = await readdir(join(directory, "people-candidates"));
  expect(files).toHaveLength(1);
  const saved = JSON.parse(await readFile(join(directory, "people-candidates", files[0]!), "utf8"));
  expect(saved).toMatchObject(candidate);
  expect(saved.id).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await readdir(workspace)).toEqual([]);
});
