import { DateTime, Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attempt } from "./core.ts";
import { validateTopic } from "./topic.ts";

const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/),
);
const Evidence = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(600));
const Sources = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
).check(Schema.isMaxLength(8));
const Person = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  name: Name,
  aliases: Schema.Array(Schema.Struct({ text: Name, context: Schema.Array(Name) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(30),
  ),
  sources: Sources.check(Schema.isMinLength(1)),
  verifiedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});
const Registry = Schema.Array(Person).check(Schema.isMaxLength(1000));
type Person = typeof Person.Type;

const Candidate = Schema.Struct({
  observed: Name,
  suggested: Name,
  evidence: Evidence,
  sources: Sources,
});
type Candidate = typeof Candidate.Type;
const Draft = Schema.Struct({
  topic: Schema.String,
  subjects: Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
  candidates: Schema.Array(Candidate).check(Schema.isMaxLength(8)),
});

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ru-RU");

function namePattern(name: string, global = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, global ? "giu" : "iu");
}

function containsName(text: string, name: string) {
  return namePattern(normalize(name)).test(normalize(text));
}

export function decodePeople(value: unknown) {
  const people = Schema.decodeUnknownSync(Registry)(value);
  if (new Set(people.map((person) => person.id)).size !== people.length)
    throw new Error("People registry contains duplicate IDs");
  return people;
}

export const readPeople = Effect.fn("readPeople")(function* (path: string) {
  return yield* attempt("Read confirmed people registry", async () =>
    decodePeople(JSON.parse(await readFile(path, "utf8"))),
  );
});

function matchesAlias(alias: Person["aliases"][number], evidence: string) {
  return (
    containsName(evidence, alias.text) &&
    (alias.context.length === 0 ||
      alias.context.some((hint) => normalize(evidence).includes(normalize(hint))))
  );
}

export function peopleForTranscript(people: readonly Person[], transcript: string) {
  return people.flatMap((person) => {
    const evidence = new Set<string>();
    for (const alias of person.aliases) {
      for (const match of transcript.matchAll(namePattern(alias.text, true))) {
        const start = Math.max(0, match.index - 250);
        const quote = transcript.slice(start, start + 600);
        if (matchesAlias(alias, quote)) evidence.add(quote);
        if (evidence.size >= 3) break;
      }
      if (evidence.size >= 3) break;
    }
    return evidence.size ? [{ ...person, evidence: [...evidence] }] : [];
  });
}

function registryTopic(topic: string, names: readonly string[]) {
  if (names.length) return `о ${names.join(" и ")}: ${topic}`;
  if (/^(?:о|об|обо)\s/iu.test(topic)) return topic;
  return `о ${topic}`;
}

export function resolvePeopleTopic(value: unknown, transcript: string, people: readonly Person[]) {
  const draft = Schema.decodeUnknownSync(Draft)(value);
  const names: string[] = [];
  const ids = new Set<string>();
  const available = peopleForTranscript(people, transcript);
  for (const id of draft.subjects) {
    if (ids.has(id)) throw new Error("Duplicate title subject");
    ids.add(id);
    const person = available.find((entry) => entry.id === id);
    const supported = person?.evidence.some((quote) =>
      person.aliases.some(
        (alias) =>
          matchesAlias(alias, quote) &&
          !people.some(
            (other) =>
              other.id !== id &&
              other.aliases.some(
                (otherAlias) =>
                  normalize(otherAlias.text) === normalize(alias.text) &&
                  matchesAlias(otherAlias, quote),
              ),
          ),
      ),
    );
    if (!person || !supported)
      throw new Error("Title person is unknown, ambiguous or lacks contextual evidence");
    names.push(person.name);
  }
  for (const candidate of draft.candidates) {
    if (
      !transcript.includes(candidate.evidence) ||
      !containsName(candidate.evidence, candidate.observed)
    )
      throw new Error("Candidate evidence is not in transcript");
    if (candidate.sources.some((source) => !source.startsWith("https://")))
      throw new Error("Candidate source must be an HTTPS URL");
  }
  // Names are inserted from the registry, never copied from a model's spelling.
  const spellings = [
    ...people.flatMap((person) => [person.name, ...person.aliases.map((alias) => alias.text)]),
    ...draft.candidates.flatMap((candidate) => [candidate.observed, candidate.suggested]),
  ];
  if (spellings.some((name) => containsName(draft.topic, name)))
    throw new Error("Topic contains a literal person name; use the subjects field");
  const topic = validateTopic({
    topic: registryTopic(draft.topic, names),
  });
  return { topic, candidates: draft.candidates };
}

export const recordPeopleCandidates = Effect.fn("recordPeopleCandidates")(function* (
  candidates: readonly Candidate[],
  directory: string,
  workspace: string,
) {
  if (candidates.length === 0) return;
  const lastSeenAt = DateTime.formatIso(yield* DateTime.now);
  yield* attempt("Save unconfirmed people candidates", async () => {
    const destination = join(directory, "people-candidates");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const candidate of candidates) {
      const id = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
      const filename = `${id}.json`;
      const temporary = join(workspace, filename);
      await writeFile(temporary, JSON.stringify({ id, lastSeenAt, ...candidate }, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, join(destination, filename));
    }
  });
});
