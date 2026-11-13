import type { Citation, ClaimText, OfficialRecord, PatentNumber, RelatedCase } from "./types";
import { decodeEntities, displayClaimNumber, officeFromId, stripTags } from "./text";

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function blockValues(slice: string, prop: string): string[] {
  const re = new RegExp(`itemprop="${prop}"[^>]*>([\\s\\S]*?)</(?:dd|span|td|div|a|time)>`, "gi");
  return unique([...slice.matchAll(re)].map((match) => stripTags(match[1] ?? "")));
}

function firstDatetime(slice: string, prop: string): string {
  const match = slice.match(new RegExp(`itemprop="${prop}"[^>]*datetime="([^"]+)"`, "i"));
  return match?.[1] ?? "";
}

function sectionAfterHeading(html: string, heading: RegExp, max = 140_000): string {
  const start = html.search(heading);
  if (start < 0) return "";
  const next = html.slice(start + 4).search(/<h2[\s>]/i);
  const end = next < 0 ? start + max : start + 4 + next;
  return html.slice(start, Math.min(end, start + max));
}

function isIndependent(text: string): boolean {
  return !/\b(of|to|in|with|according to)\s+claims?\s+\d+/i.test(text) && !/\bas claimed in\b/i.test(text);
}

function extractClaims(html: string): ClaimText[] {
  const start = html.search(/itemprop="claims"/i);
  if (start < 0) return [];
  const headingRel = html.slice(start).search(/<h2[\s>]/i);
  const from = headingRel >= 0 ? start + headingRel : start;
  const nextRel = html.slice(from + 4).search(/<h2[\s>]/i);
  const end = nextRel < 0 ? Math.min(html.length, from + 180_000) : from + 4 + nextRel;
  const slice = html.slice(start, end);
  const opener =
    /<div\b[^>]*\bnum="(\d+)"[^>]*\bclass="claim"[^>]*>|<div\b[^>]*\bclass="claim"[^>]*\bnum="(\d+)"[^>]*>/gi;
  const marks = [...slice.matchAll(opener)];
  const claims: ClaimText[] = [];
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    if (!mark) continue;
    const number = displayClaimNumber(mark[1] || mark[2] || String(claims.length + 1));
    const bodyStart = (mark.index ?? 0) + mark[0].length;
    const bodyEnd = index + 1 < marks.length ? (marks[index + 1]?.index ?? slice.length) : slice.length;
    const texts = [...slice.slice(bodyStart, bodyEnd).matchAll(/<div\b[^>]*class="claim-text"[^>]*>([\s\S]*?)<\/div>/gi)].map(
      (match) => stripTags(match[1] ?? ""),
    );
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 24) continue;
    claims.push({ number, text: text.slice(0, 2200), independent: isIndependent(text) });
    if (claims.length >= 40) break;
  }
  return claims;
}

function extractCitations(html: string): Citation[] {
  const slice = sectionAfterHeading(html, /<h2>Patent Citations/i, 80_000);
  if (!slice) return [];
  const rows = [...slice.matchAll(/<tr itemprop="backwardReferences"[\s\S]*?<\/tr>/gi)];
  const citations: Citation[] = [];
  for (const row of rows) {
    const chunk = row[0];
    const number = blockValues(chunk, "publicationNumber")[0] ?? "";
    if (!number) continue;
    citations.push({
      number,
      title: blockValues(chunk, "title")[0] ?? "",
      assignee: blockValues(chunk, "assigneeOriginal")[0] ?? "",
    });
    if (citations.length >= 24) break;
  }
  return citations;
}

function extractFamily(html: string, home: string) {
  const rows = [...html.matchAll(/<tr itemprop="docdbFamily"[\s\S]*?<\/tr>/gi)].slice(0, 40);
  const members = rows
    .map((row) => {
      const number = blockValues(row[0], "publicationNumber")[0] ?? "";
      const date = blockValues(row[0], "publicationDate")[0] ?? "";
      const country = number.slice(0, 2);
      return { number, date, country };
    })
    .filter((member) => member.number && member.country && member.country !== home);

  const countries = unique(
    [...html.matchAll(/<tr itemprop="countryStatus"[\s\S]*?<\/tr>/gi)]
      .slice(0, 30)
      .map((row) => blockValues(row[0], "countryCode")[0] ?? "")
      .filter((code) => code && code !== home),
  );

  for (const country of countries) {
    if (!members.some((member) => member.country === country)) {
      members.push({ number: "", date: "", country });
    }
  }
  return members.slice(0, 20);
}

function numbersFromGoogle(head: string, id: string): PatentNumber[] {
  const window = head.slice(0, 30_000);
  const numbers: PatentNumber[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    const key = `${label}|${clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
    if (clean.length < 4 || seen.has(key)) return;
    const compact = clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (label !== "Publication" && compact === id.replace(/[^A-Z0-9]/g, "")) return;
    seen.add(key);
    numbers.push({ label, value: clean });
  };
  add("Publication", id);
  const application = blockValues(window, "applicationNumber")[0];
  if (application) add("Application", application);
  const office = id.slice(0, 2);
  for (const publication of blockValues(window, "publicationNumber")) {
    const compact = publication.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const sameOffice = compact.slice(0, 2) === office;
    const pct = compact.startsWith("WO");
    if (!sameOffice && !pct) continue;
    add(pct && office !== "WO" ? "PCT publication" : "Other publication", publication);
    if (numbers.filter((item) => item.label === "Other publication").length >= 6) break;
  }
  for (const match of window.matchAll(/\b(PCT\/[A-Z]{2}\d{2,4}\/\d{3,8})\b/gi)) add("PCT application", (match[1] ?? "").toUpperCase());
  for (const row of window.matchAll(/<tr itemprop="priorityApps"[\s\S]*?<\/tr>/gi)) {
    const priority = blockValues(row[0], "applicationNumber")[0];
    if (priority) add("Priority", priority);
  }
  return numbers;
}

function extractRelated(html: string, selfId: string): RelatedCase[] {
  const related: RelatedCase[] = [];
  const push = (item: RelatedCase) => {
    if (!item.number || item.number === selfId) return;
    if (related.some((entry) => entry.number === item.number && entry.relationship === item.relationship)) return;
    related.push(item);
  };

  for (const row of [...html.matchAll(/<tr itemprop="afterApplications"[\s\S]*?<\/tr>/gi)].slice(0, 12)) {
    push({
      number: blockValues(row[0], "representativePublication")[0] ?? "",
      relationship: "Later application in the same family",
      title: blockValues(row[0], "title")[0] ?? "",
    });
  }

  const eventSlice = html.slice(0, html.search(/itemprop="abstract"|<h2>\s*Abstract/i) || 90_000);
  for (const event of [...eventSlice.matchAll(/<dd itemprop="events"[\s\S]*?<\/dd>/gi)].slice(0, 40)) {
    const title = blockValues(event[0], "title")[0] ?? "";
    if (!/continuation|division|divisional|reissue|continuation-in-part|parent application/i.test(title)) continue;
    const number = title.match(/\b[A-Z]{2}\d{5,14}[A-Z]\d?\b/)?.[0] ?? blockValues(event[0], "documentId")[0] ?? "";
    const cleanNumber = number.replace(/^patent\/|\/en$/g, "");
    push({
      number: cleanNumber,
      relationship: title.replace(/\s+/g, " ").slice(0, 140),
      title: "",
    });
  }
  return related.slice(0, 16);
}

function extractClassifications(html: string) {
  const slice = sectionAfterHeading(html, /<h2>\s*Classifications/i, 80_000);
  if (!slice) return [];
  const items = [...slice.matchAll(/<li itemprop="classifications"[\s\S]*?<\/li>/gi)];
  const pairs = items
    .map((item) => ({
      code: blockValues(item[0], "Code")[0] ?? "",
      description: blockValues(item[0], "Description")[0] ?? "",
      leaf: /itemprop="Leaf"/i.test(item[0]),
    }))
    .filter((item) => item.code.length >= 4 && item.description);
  const uniqueCodes = new Map<string, { code: string; description: string; leaf: boolean }>();
  for (const pair of pairs) uniqueCodes.set(pair.code, pair);
  const all = [...uniqueCodes.values()];
  const useful = all.filter((item) => item.leaf && !item.code.startsWith("Y") && !item.code.startsWith("B01J2219"));
  const pool = useful.length > 0 ? useful : all.filter((item) => !item.code.startsWith("Y"));
  const groups = new Map<string, { code: string; description: string }[]>();
  for (const item of pool) {
    const key = item.code.split("/")[0] ?? item.code;
    const list = groups.get(key) ?? [];
    list.push({ code: item.code, description: item.description });
    groups.set(key, list);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const picked: { code: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const [index, items] of ordered.entries()) {
    if (index > 0 && (picked.length >= 4 || items.length < 2)) break;
    for (const item of items.sort((a, b) => b.code.length - a.code.length)) {
      const key = item.description.toLowerCase().slice(0, 56);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
      if (picked.length >= 5) break;
    }
    if (picked.length >= 5) break;
  }
  return picked;
}

export function parseGooglePatent(html: string, requestedId: string): OfficialRecord | null {
  if (!html || /Error 404 \(Not Found\)/i.test(html.slice(0, 800))) return null;
  const titleTag = stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (!titleTag || /not found/i.test(titleTag)) return null;

  const abstractAt = html.search(/itemprop="abstract"|<h2>\s*Abstract/i);
  const head = abstractAt > 0 ? html.slice(0, abstractAt) : html.slice(0, 90_000);
  const idFromTitle = titleTag.match(/\b[A-Z]{2}\d{5,14}[A-Z]\d?\b/)?.[0] ?? requestedId;
  const office = officeFromId(idFromTitle);
  const title = titleTag
    .replace(/\s+-\s+Google Patents\s*$/i, "")
    .replace(/^[A-Z]{2}\d{4,14}[A-Z]\d?\s+-\s+/, "")
    .trim();

  const abstract = stripTags(html.match(/<div class="abstract">([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const claims = extractClaims(html);
  const description = stripTags(sectionAfterHeading(html, /<h2>\s*Description/i, 160_000)).slice(0, 40_000);
  const claimText = claims.map((claim) => claim.text).join("\n");
  const excerpt = [abstract, claimText, description].filter(Boolean).join("\n\n").slice(0, 80_000);

  const filing = firstDatetime(head, "filingDate");
  const publication = firstDatetime(head, "publicationDate");
  const priority = firstDatetime(head, "priorityDate");
  let granted = "";
  for (const event of [...head.matchAll(/<dd itemprop="events"[\s\S]*?<\/dd>/gi)]) {
    const type = blockValues(event[0], "type")[0] ?? "";
    const eventTitle = blockValues(event[0], "title")[0] ?? "";
    if (/grant/i.test(type) || /granted|issued/i.test(eventTitle)) {
      granted = blockValues(event[0], "date")[0] || firstDatetime(event[0], "date");
      if (granted) break;
    }
  }

  const dates = [
    { label: "Priority", value: priority },
    { label: "Filing", value: filing },
    { label: "Publication", value: publication },
    { label: "Grant", value: granted },
  ].filter((item) => item.value);

  const language = (html.match(/<abstract[^>]*lang="([A-Za-z-]+)"/i)?.[1] ?? "en").toLowerCase();
  const keywords = unique(
    [...html.matchAll(/itemprop="priorArtKeywords"[^>]*>([^<]+)/gi)]
      .slice(0, 12)
      .map((match) => decodeEntities(match[1] ?? ""))
      .filter((word) => word.length > 3 && !/^(method|system|device|data|information|user|document|documents)$/i.test(word)),
  ).slice(0, 8);

  return {
    id: idFromTitle,
    title: title || "Untitled patent",
    status: blockValues(head, "status")[0] ?? "",
    inventors: blockValues(head, "inventor").slice(0, 12),
    assignees: [
      ...blockValues(head, "assigneeOriginal").slice(0, 6).map((name) => ({ name, role: "Original assignee" })),
      ...blockValues(head, "assigneeCurrent").slice(0, 6).map((name) => ({ name, role: "Current assignee" })),
    ],
    abstract,
    claims,
    excerpt,
    dates,
    numbers: numbersFromGoogle(head, idFromTitle),
    officeCode: office.code,
    officeName: office.name,
    citations: extractCitations(html),
    family: extractFamily(html, office.code),
    related: extractRelated(html, idFromTitle),
    classifications: extractClassifications(html),
    keywords,
    language,
    sourceNotes: ["Public patent record"],
  };
}
