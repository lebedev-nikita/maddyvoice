import { expect, it } from "vite-plus/test";
import {
  assessGeneratedTopic,
  finalizeCommentTopic,
  mergeCommentCandidates,
  commentBodies,
  extractionPrompt,
  titlePrompt,
  validateCandidates,
  validateGeneratedTopic,
  selectedComments,
  filterPrompt,
  validateExtractedNames,
} from "../src/comment-topics.ts";

const comments = [
  { id: "c1", text: "Ворон вернулся к обсуждению игры." },
  { id: "c2", text: "Похоже, это снова Ворон." },
];
const candidate = {
  nick: "Ворон",
  mentions: comments.map((comment) => ({ commentId: comment.id, quote: comment.text })),
};

it("derives literal evidence in code and excludes invented names, substrings and copied bodies", () => {
  const bodies = [
    ...comments,
    { id: "copy", text: comments[0]!.text },
    { id: "substring", text: "Ворона каркает" },
  ];
  const result = validateExtractedNames({ nicks: ["Ворон", "Неведомый"] }, bodies);
  expect(result.candidates).toEqual([candidate]);
  expect(result.rejectedCandidates).toBe(1);
});

it("keeps original comment bodies and order after filtering, rejecting invented or duplicate IDs", () => {
  expect(selectedComments({ keepIds: ["c2", "c1"] }, comments)).toEqual(comments);
  expect(selectedComments({ keepIds: [] }, comments)).toEqual([]);
  expect(() => selectedComments({ keepIds: ["unknown"] }, comments)).toThrow("unknown IDs");
  expect(() => selectedComments({ keepIds: ["c1", "c1"] }, comments)).toThrow("duplicate");
  expect(
    filterPrompt("Речь о новой игре", [
      { id: "1", text: "Ворон", sender_name: "private-author" } as (typeof comments)[number],
    ]),
  ).not.toContain("private-author");
});

it("removes author names and other metadata before extraction, and ignores empty bodies", () => {
  const raw = [
    {
      id: "1",
      text: "Обычный комментарий.",
      sender: { name: "СекретныйНик" },
      username: "ИмяАвтора",
    },
    { id: "2", text: "  " },
  ];
  expect(commentBodies(raw)).toEqual([{ id: "1", text: "Обычный комментарий." }]);
  expect(extractionPrompt(raw)).not.toContain("СекретныйНик");
  expect(extractionPrompt(raw)).not.toContain("ИмяАвтора");
});

it("accepts only nicknames supported by exact body quotes, without substring matches", () => {
  expect(validateCandidates({ candidates: [candidate] }, comments).candidates).toEqual([candidate]);
  expect(
    validateCandidates({ candidates: [{ ...candidate, nick: "Другой" }] }, comments),
  ).toMatchObject({ candidates: [], rejectedCandidates: 1, rejectedMentions: 2 });
  expect(
    validateCandidates(
      { candidates: [{ nick: "Ворон", mentions: [{ commentId: "c3", quote: "Ворон здесь" }] }] },
      comments,
    ),
  ).toMatchObject({ candidates: [], rejectedCandidates: 1 });
  expect(
    validateCandidates(
      {
        candidates: [{ nick: "Ворон", mentions: [{ commentId: "c1", quote: "Ворона каркает." }] }],
      },
      [{ id: "c1", text: "Ворона каркает." }],
    ),
  ).toMatchObject({ candidates: [], rejectedCandidates: 1 });
});

it("does not count duplicated IDs or copied comment bodies as independent mentions", () => {
  const duplicates = [...comments, { id: "c3", text: comments[0]!.text }];
  const mentions = [
    ...candidate.mentions,
    candidate.mentions[0]!,
    { commentId: "c3", quote: comments[0]!.text },
  ];
  expect(
    validateCandidates({ candidates: [{ ...candidate, mentions }] }, duplicates).candidates[0]
      ?.mentions,
  ).toHaveLength(2);
  const repeated = validateCandidates({ candidates: [candidate, candidate] }, duplicates);
  expect(repeated.candidates).toHaveLength(1);
  expect(repeated.candidates[0]?.mentions).toHaveLength(2);
});

it("requires actual transcript evidence and two valid comment references for an adopted nickname", () => {
  const transcript = "Вор опять спорит о выборе новой игры для эфира.";
  const output = {
    topic: "Ворон спорит о выборе игры для эфира",
    subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["c1", "c2"] }],
  };
  expect(validateGeneratedTopic(output, transcript, [candidate]).topic).toBe(output.topic);
  expect(() =>
    validateGeneratedTopic(output, "Совсем другая расшифровка речи.", [candidate]),
  ).toThrow("transcript evidence");
  expect(() =>
    validateGeneratedTopic(
      { ...output, subjects: [{ ...output.subjects[0]!, commentIds: ["c1", "unknown"] }] },
      transcript,
      [candidate],
    ),
  ).toThrow("supporting comment");
  expect(() =>
    validateGeneratedTopic(
      { ...output, subjects: [{ ...output.subjects[0]!, commentIds: [] }] },
      transcript,
      [candidate],
    ),
  ).toThrow("supporting comment");
  expect(() =>
    validateGeneratedTopic({ ...output, subjects: [] }, transcript, [candidate]),
  ).toThrow("grounded subject");
});

it("builds the same title task with no supplied names in the control condition", () => {
  const transcript = "Длинная расшифровка про выбор компьютерной игры.";
  expect(titlePrompt(transcript, [])).not.toContain("Ворон");
  expect(titlePrompt(transcript, [candidate])).toContain("Ворон");
});

it("allows a supported nickname to decline in a title without relaxing literal comment evidence", () => {
  const transcript = "Вор опять спорит о выборе новой игры для эфира.";
  expect(
    validateGeneratedTopic(
      {
        topic: "О Вороне и выборе игры для эфира",
        subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["c1", "c2"] }],
      },
      transcript,
      [candidate],
    ).topic,
  ).toBe("О Вороне и выборе игры для эфира");
  expect(() =>
    validateGeneratedTopic(
      {
        topic: "О Воронине и выборе игры для эфира",
        subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["c1", "c2"] }],
      },
      transcript,
      [candidate],
    ),
  ).toThrow("absent from title");
  expect(
    validateGeneratedTopic(
      {
        topic: "О разговоре с Жмилём в личных сообщениях",
        subjects: [{ name: "Жмиль", transcriptQuote: transcript, commentIds: ["j1", "j2"] }],
      },
      transcript,
      [
        {
          nick: "Жмиль",
          mentions: [
            { commentId: "j1", quote: "Жмиль снова спорит." },
            { commentId: "j2", quote: "Это Жмиль." },
          ],
        },
      ],
    ).topic,
  ).toBe("О разговоре с Жмилём в личных сообщениях");
});

it("retains the exact model draft when validation rejects an author's repeated name", () => {
  const transcript = "Автор обсуждает выбор новой игры для эфира.";
  const draft = { topic: "Мэддисон обсуждает выбор новой игры", subjects: [] };
  const result = assessGeneratedTopic(draft, transcript, []);
  expect(result.draft).toEqual(draft);
  expect(result.accepted).toBe(false);
  expect(result.validationError).toContain("author");
});

it("retains and accepts a grounded title without changing its wording", () => {
  const transcript = "Вор опять спорит о выборе новой игры для эфира.";
  const draft = {
    topic: "Ворон спорит о выборе игры для эфира",
    subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["c1", "c2"] }],
  };
  expect(assessGeneratedTopic(draft, transcript, [candidate])).toEqual({
    draft,
    accepted: true,
    validationError: null,
  });
});

it("removes only a redundant leading author label, then validates the full supporting evidence", () => {
  const transcript = "Вор опять спорит о выборе новой игры для эфира.";
  const draft = {
    topic: "Илья Мэддисон обсуждает спор с Ворон",
    subjects: [{ name: "Ворон", transcriptQuote: transcript, commentIds: ["c1", "c2"] }],
  };
  expect(finalizeCommentTopic(draft, transcript, [candidate])).toBe("обсуждает спор с Ворон");
  expect(() =>
    finalizeCommentTopic(
      { ...draft, subjects: [{ ...draft.subjects[0]!, commentIds: ["invalid", "c2"] }] },
      transcript,
      [candidate],
    ),
  ).toThrow("supporting comment");
  expect(() =>
    finalizeCommentTopic({ ...draft, topic: "Ответ Мэддисона на спор с Ворон" }, transcript, [
      candidate,
    ]),
  ).toThrow("author");
});

it("merges mentions across extraction batches without counting copied comment bodies twice", () => {
  const first = { nick: "Ворон", mentions: [candidate.mentions[0]!] };
  const second = { nick: "ворон", mentions: [candidate.mentions[1]!, candidate.mentions[0]!] };
  expect(mergeCommentCandidates([[first], [second]], comments)[0]?.mentions).toHaveLength(2);
});
