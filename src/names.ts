import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { attempt } from "./core.ts";

// Names are sent as transcription keywords, which may not contain `<`, `>` or line breaks.
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[^<>\r\n]*\S[^<>\r\n]*$/),
);
const Alias = Schema.Union([
  Name,
  Schema.Struct({ text: Name, context: Schema.Array(Name).check(Schema.isMinLength(1)) }),
]);
const Entry = Schema.Struct({
  name: Name,
  aliases: Schema.optionalKey(Schema.Array(Alias)),
});
export type NameEntry = typeof Entry.Type;
type Alias = typeof Alias.Type;

const normalize = (text: string) =>
  text.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
const aliasText = (alias: Alias) => (typeof alias === "string" ? alias : alias.text);

/**
 * The names dictionary in priority order. Every name and alias appears once, so a
 * corrected name never matches another alias.
 */
export function decodeNames(value: unknown) {
  const names = Schema.decodeUnknownSync(Schema.Array(Entry))(value);
  const seen = new Set<string>();
  for (const entry of names)
    for (const text of [entry.name, ...(entry.aliases ?? []).map(aliasText)]) {
      if (seen.has(normalize(text))) throw new Error(`Name or alias "${text}" appears twice`);
      seen.add(normalize(text));
    }
  return names;
}

export const readNames = Effect.fn("readNames")(function* (path: string) {
  return yield* attempt("Read names dictionary", async () =>
    decodeNames(JSON.parse(await readFile(path, "utf8"))),
  );
});

// Russian noun endings, longest first; an alias keeps the ending it was heard with.
const endings =
  "ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ов|ев|ей|ой|ом|ем|ую|юю|а|я|у|ю|е|ы|и|о";
const vowelFinal = (word: string) => /[аяоеьй]$/iu.test(word);
const stem = (word: string) => (vowelFinal(word) ? word.slice(0, -1) : word);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cyrillic = /\p{Script=Cyrillic}/u;

// Endings are spelled after a soft stem (Галя → Галю) or a hush (Сасыч → Сасычем) differently
// from a hard one (Гхалка → Гхалку, Сасавот → Сасавотом).
type Stem = "hard" | "soft" | "hush";
const stemKind = (word: string): Stem =>
  /[яьй]$/iu.test(word) ? "soft" : /[жшчщц]$/iu.test(word) ? "hush" : "hard";
const softer: Record<Exclude<Stem, "hard">, Record<string, string>> = {
  soft: {
    а: "я",
    у: "ю",
    ы: "и",
    ой: "ей",
    ом: "ем",
    ов: "ев",
    ого: "его",
    ому: "ему",
    ам: "ям",
    ах: "ях",
    ами: "ями",
    ую: "юю",
  },
  hush: { ы: "и", ой: "ей", ом: "ем", ов: "ев", ого: "его", ому: "ему" },
};
function respell(ending: string, from: Stem, to: Stem) {
  const lower = ending.toLocaleLowerCase("ru-RU");
  const hard =
    from === "hard"
      ? lower
      : (Object.entries(softer[from]).find(([, soft]) => soft === lower)?.[0] ?? lower);
  return to === "hard" ? hard : (softer[to][hard] ?? hard);
}

/** How one word of an alias is matched and what replaces it. */
function wordRule(heard: string, written: string) {
  // A word declines with its ending only when both spellings decline alike.
  const declines = cyrillic.test(heard) && vowelFinal(heard) === vowelFinal(written);
  if (!declines) return { pattern: `${escape(heard)}()`, replace: () => written };
  return {
    pattern: `${escape(stem(heard))}(${endings})${vowelFinal(heard) ? "" : "?"}`,
    // Latin spellings take no Russian endings.
    replace: (ending: string) =>
      cyrillic.test(written)
        ? stem(written) + respell(ending, stemKind(heard), stemKind(written))
        : written,
  };
}

function aliasRule(alias: Alias, name: string) {
  const heard = aliasText(alias).split(/\s+/);
  const written = name.split(" ");
  const words =
    heard.length === written.length
      ? heard.map((word, index) => wordRule(word, written[index]!))
      : [wordRule(heard.join(" "), name)];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${words.map((word) => word.pattern).join("\\s+")}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const context = typeof alias === "string" ? [] : alias.context.map(normalize);
  return { length: aliasText(alias).length, pattern, words, context };
}

/**
 * Replace names the recogniser got wrong with their dictionary spelling. Russian endings
 * carry over; an alias with context applies only when a hint is within 300 characters.
 */
export function autocorrect(text: string, names: readonly NameEntry[]) {
  const rules = names
    .flatMap((entry) => (entry.aliases ?? []).map((alias) => aliasRule(alias, entry.name)))
    .sort((a, b) => b.length - a.length);
  // Corrected spans are parked behind markers so a later alias cannot rewrite them.
  const corrected: string[] = [];
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, (match, ...groups: unknown[]) => {
      const offset = groups[rule.words.length] as number;
      const input = groups[rule.words.length + 1] as string;
      const nearby = normalize(input.slice(Math.max(0, offset - 300), offset + match.length + 300));
      if (rule.context.length && !rule.context.some((hint) => nearby.includes(hint))) return match;
      corrected.push(
        rule.words.map((word, index) => word.replace((groups[index] as string) ?? "")).join(" "),
      );
      return `\uE000${corrected.length - 1}\uE000`;
    });
  }
  return result.replace(/\uE000(\d+)\uE000/g, (_, index: string) => corrected[Number(index)]!);
}
