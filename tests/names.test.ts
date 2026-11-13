import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { Paths } from "../src/core.ts";
import { autocorrect, decodeNames } from "../src/names.ts";

const names = decodeNames([
  { name: "Сасавот", aliases: ["Сосавот", "Сасыч"] },
  { name: "Галя", aliases: ["Гхаля", "Гхалка"] },
  { name: "Анар Абдулаев", aliases: ["Анал Обдуваев"] },
  { name: "VJLink", aliases: ["Виджелинк", "Виджей Линк"] },
  { name: "Твич", aliases: ["Twitch"] },
  { name: "Давг", aliases: [{ text: "давка", context: ["Baby Steps"] }] },
  { name: "Человек-паук 2", aliases: ["Человек паук 2"] },
  { name: "Человек-паук", aliases: ["Человек паук"] },
]);

describe("names dictionary", () => {
  it("keeps Russian endings when a declining name is corrected", () => {
    expect(autocorrect("Сосавот сказал Сосавоту и сасычем", names)).toBe(
      "Сасавот сказал Сасавоту и Сасавотом",
    );
    expect(autocorrect("Гхаля, Гхалю, Гхалкой, Гхалку", names)).toBe("Галя, Галю, Галей, Галю");
    expect(autocorrect("у Анала Обдуваева", names)).toBe("у Анара Абдулаева");
  });

  it("writes Latin spellings without endings and Cyrillic ones from Latin", () => {
    expect(autocorrect("по Виджелинку и Виджей Линку на Twitch", names)).toBe(
      "по VJLink и VJLink на Твич",
    );
  });

  it("applies a contextual alias only near its hint", () => {
    expect(autocorrect("Вот все играют в Baby Steps, давка прошел.", names)).toBe(
      "Вот все играют в Baby Steps, Давг прошел.",
    );
    expect(autocorrect("В метро была давка.", names)).toBe("В метро была давка.");
  });

  it("matches whole words and never rewrites a correction", () => {
    expect(autocorrect("Сосавотик и Человек паук 2", names)).toBe("Сосавотик и Человек-паук 2");
  });

  it("refuses duplicate names and characters the API rejects", () => {
    expect(() => decodeNames([{ name: "Озон" }, { name: "Твич", aliases: ["озон"] }])).toThrow(
      "appears twice",
    );
    expect(() => decodeNames([{ name: "<Озон>" }])).toThrow();
  });

  it("ships a valid dictionary that fits the transcription keyword limit", async () => {
    const shipped = decodeNames(JSON.parse(await readFile(Paths.names, "utf8")));
    expect(shipped.length).toBeLessThanOrEqual(900);
  });
});
