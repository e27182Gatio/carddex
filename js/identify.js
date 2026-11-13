// Identify a card from on-device OCR or optional AI reading.
// Fast path: filter TCGdex by *both* name and collector number first.
// Only fall back to multi-set lookups when that inexpensive search is inconclusive.

import { getCard, getSetCard, getSets, pool, searchCards } from "./api.js";
import { nameScore, nameTokens, parseHp, parseNumbers, rankCandidates, sameNumber } from "./match.js";

const MAX_SET_LOOKUPS = 8;
const MAX_DETAIL = 6;

export async function identify(read, onStep = () => {}) {
  const nums = parseNumbers(`${read.numberText || ""}\n${read.fullText || ""}`);
  const best = nums[0] || null;
  const parsed = {
    nameText: read.nameText || "",
    number: best?.number || "",
    total: best?.total || null,
    hp: parseHp(read.hpText),
    setName: read.setName || "",
  };
  const found = new Map();
  const add = (cards) => {
    for (const c of cards) if (c?.id) found.set(c.id, c);
  };
  const ranked = () => rankCandidates([...found.values()], parsed).slice(0, 8);
  const strongMatch = (c) => !!c &&
    nameScore(c.name, parsed.nameText) >= 0.78 &&
    (!parsed.number || sameNumber(c.localId, parsed.number)) &&
    (!parsed.total || c.set?.official === parsed.total || c.set?.total === parsed.total);

  const tokens = nameTokens(parsed.nameText);
  const first = tokens[0] || "";

  // 1) Name+number is typically a single small list request, followed by
  //    just a few full card requests. No need to download all sets first.
  if (first) {
    onStep("Buscando nombre y número de carta…");
    try {
      const localId = parsed.number.replace(/^0+(?=\d)/, "");
      const briefs = await searchCards({
        name: first, localId, perPage: 100,
      });
      const plausible = parsed.number
        ? briefs.filter((c) => sameNumber(c.localId, parsed.number))
        : briefs;
      const shortlist = rankCandidates(plausible, parsed).slice(0, MAX_DETAIL);
      const details = await pool(shortlist, 5, (c) => getCard(c.id));
      add(details);
      if (ranked().some(strongMatch)) return { read: parsed, matches: ranked() };
    } catch {
      // Network/lookup problems should not block the fallback search.
    }
  }

  // 2) Fall back to printed set totals for OCR errors or missing names.
  if (nums.length && !ranked().some(strongMatch)) {
    onStep("Comprobando colecciones alternativas…");
    try {
      const sets = await getSets();
      const jobs = [];
      for (const nr of nums.slice(0, 2)) {
        const matching = sets.filter((s) => s.official === nr.total || s.total === nr.total);
        if (parsed.setName) {
          const want = parsed.setName.toLowerCase();
          matching.sort((a, b) => Number(b.name.toLowerCase() === want) - Number(a.name.toLowerCase() === want));
        }
        for (const s of matching) jobs.push([s.id, nr.number]);
      }
      const cards = await pool(jobs.slice(0, MAX_SET_LOOKUPS), 5,
        ([setId, number]) => getSetCard(setId, number));
      add(cards);
    } catch { /* Keep the candidates already found. */ }
  }

  // 3) Last resort when the collector number was misread: name-only search.
  if (first && !ranked().some(strongMatch)) {
    onStep("Buscando por nombre como alternativa…");
    try {
      const lists = await pool(tokens.slice(0, 2), 2,
        (token) => searchCards({ name: token, perPage: 60 }));
      const briefs = lists.flat().filter(Boolean);
      const shortlist = rankCandidates(briefs, parsed).slice(0, MAX_DETAIL);
      const details = await pool(shortlist.filter((c) => !found.has(c.id)), 5, (c) => getCard(c.id));
      add(details);
    } catch { /* The user can still inspect the previous candidates. */ }
  }

  return { read: parsed, matches: ranked() };
}
