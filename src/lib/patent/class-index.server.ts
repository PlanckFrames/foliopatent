import { gunzipSync } from "node:zlib";
import { classTitles } from "./data/class-titles";

type Entry = { title: string; ipc: boolean };

let table: Map<string, Entry> | null = null;

function loadTitles(): Map<string, Entry> {
  if (table) return table;
  const text = gunzipSync(Buffer.from(classTitles, "base64")).toString("utf8");
  const map = new Map<string, Entry>();
  for (const line of text.split("\n")) {
    const [code, flag, title] = line.split("\t");
    if (!code || !title) continue;
    map.set(code, { title, ipc: flag === "I" });
  }
  table = map;
  return map;
}

export function normalizeClassCode(value: string): string {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  const match = compact.match(/^([A-HY]\d{2}[A-Z])(\d+)\/(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return compact;
  return `${match[1]}${Number(match[2])}/${match[3]}`;
}

export function displayClassCode(code: string): string {
  const match = code.match(/^([A-HY]\d{2}[A-Z])(\d+)\/(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return code;
  return `${match[1]} ${match[2]}/${match[3]}`;
}

function parents(code: string): string[] {
  const match = code.match(/^([A-HY]\d{2}[A-Z])(\d+)\/(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return [];
  const out: string[] = [];
  let digits = match[3];
  while (digits.length > 2) {
    digits = digits.slice(0, -1);
    out.push(`${match[1]}${match[2]}/${digits}`);
  }
  if (match[3] !== "00") out.push(`${match[1]}${match[2]}/00`);
  out.push(match[1], match[1].slice(0, 3), match[1].slice(0, 1));
  return out;
}

function useful(title: string): boolean {
  return title.length > 18 && /^[A-Z0-9]/.test(title) && !/takes precedence$/i.test(title) && !/^covered by group\b/i.test(title);
}

function meaning(map: Map<string, Entry>, code: string): string {
  const entry = map.get(code);
  if (!entry) return "";
  const title = entry.title;
  if (useful(title)) return title;
  for (const parent of parents(code)) {
    const up = map.get(parent);
    if (!up || !useful(up.title)) continue;
    const rest = title.charAt(0).toLowerCase() + title.slice(1);
    return `${up.title.replace(/[.;\s]+$/, "")}; ${rest}`;
  }
  return title;
}

function pickDescription(given: string, official: string): string {
  const placeholder = /printed on the patent|code printed/i.test(given);
  if (!given || placeholder) return official;
  if (!official) return given;
  if (useful(official) && !useful(given)) return official;
  if (useful(given) && !useful(official)) return given;
  return given.length >= official.length ? given : official;
}

export type ClassQuery = { code: string; scheme?: string; description?: string };

export function describeClassList(items: ClassQuery[]): { code: string; scheme: string; description: string }[] {
  const map = loadTitles();
  const merged = new Map<string, { schemes: Set<string>; given: string }>();
  for (const item of items) {
    const key = normalizeClassCode(item.code);
    if (!/^[A-HY]\d{2}[A-Z]\d+\/\d+$/.test(key)) continue;
    const current = merged.get(key) ?? { schemes: new Set<string>(), given: "" };
    for (const scheme of (item.scheme ?? "").split(",")) {
      const clean = scheme.trim();
      if (clean) current.schemes.add(clean);
    }
    const given = (item.description ?? "").replace(/\s+/g, " ").trim();
    if (given.length > current.given.length) current.given = given;
    merged.set(key, current);
  }
  return [...merged.entries()].map(([key, item]) => {
    const entry = map.get(key);
    const official = meaning(map, key);
    const order = ["IPC", "CPC", "USPC", "FI", "F-term", "Locarno"];
    const schemes = [...item.schemes].sort((a, b) => {
      const left = order.indexOf(a);
      const right = order.indexOf(b);
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
    });
    if (schemes.length === 0) schemes.push(entry?.ipc ? "IPC" : "CPC");
    return {
      code: displayClassCode(key),
      scheme: schemes.join(", "),
      description: pickDescription(item.given, official),
    };
  }).filter((item) => item.description);
}
