function wordForms(word: string) {
  const match = /^(.*?)([а-яё]+)$/u.exec(word);
  if (!match) return [word];
  const letters = match[2]!;
  const stem = word.slice(0, -1);
  if (/[бвгджзклмнпрстфхцчшщ]$/u.test(letters))
    return [word, ...["а", "у", "ом", "е"].map((ending) => word + ending)];
  if (/[йь]$/u.test(letters))
    return [word, ...["я", "ю", "ем", "ём", "е", "и", "ью"].map((ending) => stem + ending)];
  if (letters.endsWith("а"))
    return [word, ...["ы", "и", "е", "у", "ой", "ою"].map((ending) => stem + ending)];
  if (letters.endsWith("я"))
    return [word, ...["и", "е", "ю", "ей", "ею"].map((ending) => stem + ending)];
  return [word];
}

export function titleNameForms(name: string) {
  const words = name.normalize("NFKC").toLocaleLowerCase("ru-RU").trim().split(/\s+/u);
  // Each word declines on its own: «Алина Рин» appears as «Алины Рин». Longer names keep
  // all but the last word fixed to bound the combinations.
  const options = words.map((word, index) =>
    words.length <= 3 || index === words.length - 1 ? wordForms(word) : [word],
  );
  const [first, ...rest] = options;
  return rest.reduce(
    (names, forms) => names.flatMap((prefix) => forms.map((form) => `${prefix} ${form}`)),
    first!,
  );
}

export function sameTitleName(left: string, right: string) {
  const forms = new Set(titleNameForms(left));
  return titleNameForms(right).some((form) => forms.has(form));
}
