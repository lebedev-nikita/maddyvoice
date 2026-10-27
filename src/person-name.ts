export function titleNameForms(name: string) {
  const normalized = name.normalize("NFKC").toLocaleLowerCase("ru-RU");
  const match = /^(.*?)([а-яё]+)$/u.exec(normalized);
  if (!match) return [normalized];
  const word = match[2]!;
  const stem = normalized.slice(0, -1);
  if (/[бвгджзклмнпрстфхцчшщ]$/u.test(word))
    return [normalized, ...["а", "у", "ом", "е"].map((ending) => normalized + ending)];
  if (/[йь]$/u.test(word))
    return [normalized, ...["я", "ю", "ем", "ём", "е", "и", "ью"].map((ending) => stem + ending)];
  if (word.endsWith("а"))
    return [normalized, ...["ы", "и", "е", "у", "ой", "ою"].map((ending) => stem + ending)];
  if (word.endsWith("я"))
    return [normalized, ...["и", "е", "ю", "ей", "ею"].map((ending) => stem + ending)];
  return [normalized];
}

export function sameTitleName(left: string, right: string) {
  const forms = new Set(titleNameForms(left));
  return titleNameForms(right).some((form) => forms.has(form));
}
