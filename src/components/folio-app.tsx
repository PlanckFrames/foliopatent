import { useRef, useState, type ReactNode } from "react";
import {
  Calendar,
  FileUp,
  FlaskConical,
  Globe2,
  Languages,
  Layers,
  Link2,
  Loader2,
  Microscope,
  ScrollText,
  Search,
  Users,
} from "lucide-react";
import { explainPatent, lookupPatent } from "@/lib/patent/server-fns";
import { biblioFromPdf, extractPdfText, findPublicationId } from "@/lib/patent/pdf";
import { detectLanguage, scanText } from "@/lib/patent/scan";
import { patentUrl } from "@/lib/patent/text";
import type { Brief, OfficialRecord, Scan } from "@/lib/patent/types";

const SAMPLES = [
  { id: "US6285999B1", label: "PageRank" },
  { id: "US4683202A", label: "PCR" },
];

const LANGUAGES = ["Spanish", "French", "German", "Chinese", "Japanese", "English"];

const SECTIONS = [
  "People",
  "Companies",
  "Purpose",
  "Technologies",
  "Chemicals",
  "Organisms",
  "Materials",
  "Citations",
  "Dates",
  "Office",
  "Filed elsewhere",
  "Related cases",
  "Language",
];

const FEATURES = [
  "Patent lookup",
  "Publication IDs",
  "Authors",
  "Owners",
  "Claims",
  "Chemical compounds",
  "Polymers",
  "Organisms",
  "Cited patents",
  "Filing dates",
  "Where it was filed",
  "Related cases",
  "Text language translator",
];

type Report = {
  record: OfficialRecord | null;
  scan: Scan;
  brief: Brief;
  languageLabel: string;
  note: string;
  abstract: string;
  writtenClaims: { number: string; text: string; independent: boolean }[];
};

export function FolioApp() {
  const [publicationId, setPublicationId] = useState("");
  const [phase, setPhase] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [translateTo, setTranslateTo] = useState("Spanish");
  const [translating, setTranslating] = useState(false);
  const runId = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  async function buildReport(options: { id?: string; file?: File }) {
    const token = ++runId.current;
    setPhase("working");
    setError("");
    setReport(null);
    try {
      let pdfText = "";
      let pdfNote = "";
      let id = options.id?.trim() ?? "";
      if (options.file) {
        if (options.file.size > 30 * 1024 * 1024) throw new Error("That PDF is over 30 MB. Try a smaller file.");
        setStatus("Reading the PDF in this browser…");
        const extracted = await extractPdfText(options.file, (message) => {
          if (token !== runId.current) return;
          setStatus(message);
        });
        if (token !== runId.current) return;
        pdfText = extracted.text;
        if (!pdfText.trim()) {
          throw new Error("This PDF could not be read. Type the publication number, or upload a clearer file.");
        }
        const where = extracted.scanned ? "scan" : "PDF";
        pdfNote = extracted.truncated
          ? `Read the first ${extracted.scanned ? 24 : 50} pages of the ${where} in this browser. The file was not uploaded.`
          : `Read the uploaded ${where} in this browser. The file was not uploaded.`;
        id = id || findPublicationId(pdfText);
      }

      let record: OfficialRecord | null = null;
      if (id) {
        setStatus("Opening the public patent record…");
        const looked = await lookupPatent({ data: { id } });
        if (token !== runId.current) return;
        if (looked.ok) record = looked.record;
        else if (!pdfText) throw new Error(looked.error);
        else pdfNote = `${pdfNote} The publication number in the file did not match a public record, so bibliographic fields come only from the PDF.`;
      } else if (!pdfText) {
        throw new Error("Enter a publication number or upload a patent PDF.");
      }

      const pdfBiblio = pdfText ? biblioFromPdf(pdfText) : { abstract: "", claims: [] };
      const abstract = record?.abstract || pdfBiblio.abstract;
      const writtenClaims =
        record && record.claims.length > 0
          ? record.claims.map((claim) => ({ number: claim.number, text: claim.text, independent: claim.independent }))
          : pdfBiblio.claims.map((text, index) => ({ number: String(index + 1), text, independent: true }));
      const scanSource = [pdfText, record?.excerpt ?? ""].filter(Boolean).join("\n").slice(0, 180_000);
      const language = detectLanguage(abstract || scanSource.slice(0, 2000));
      const scan = scanText(scanSource, {
        classifications: record?.classifications,
        keywords: record?.keywords,
      });

      setStatus("Writing a plain-language brief…");
      const brief = await explainPatent({
        data: {
          title: record?.title || "Uploaded patent",
          abstract,
          claims: writtenClaims.map((claim) => claim.text),
          language: language.code,
          targetLanguage: "",
        },
      });
      if (token !== runId.current) return;

      setReport({
        record,
        scan,
        brief,
        languageLabel: language.label,
        note: [pdfNote, ...(record?.sourceNotes ?? [])].filter(Boolean).join(" · "),
        abstract,
        writtenClaims,
      });
      setPhase("ready");
      setStatus("");
      if (record?.id) setPublicationId(record.id);
    } catch (caught) {
      if (token !== runId.current) return;
      setPhase("error");
      setStatus("");
      setError(caught instanceof Error ? caught.message : "The patent could not be read.");
    }
  }

  async function translateAbstract() {
    if (!report?.abstract) return;
    setTranslating(true);
    try {
      const brief = await explainPatent({
        data: {
          title: report.record?.title || "Patent",
          abstract: report.abstract,
          claims: [],
          language: "en",
          targetLanguage: translateTo,
        },
      });
      setReport({ ...report, brief: { ...report.brief, translation: brief.translation || brief.purpose } });
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between gap-4 px-4 py-3">
          <p className="font-serif text-2xl leading-none tracking-tight">FolioPatent</p>
          <p className="text-sm text-muted">One patent at a time</p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <section className="max-w-3xl">
          <h1 className="font-serif text-4xl leading-tight tracking-tight sm:text-5xl">Full patent analysis</h1>
          <p className="mt-4 text-lg leading-relaxed text-muted">Analyze any patent. Features include:</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {FEATURES.map((feature) => (
              <li key={feature} className="rounded-full border border-line bg-card px-3 py-1.5 text-sm">
                {feature}
              </li>
            ))}
          </ul>
        </section>

        <form
          className="mt-8 grid gap-4 rounded-2xl border border-line bg-card p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void buildReport({ id: publicationId });
          }}
        >
          <label className="grid gap-2">
            <span className="text-sm font-semibold">Publication number</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={publicationId}
                onChange={(event) => setPublicationId(event.target.value)}
                placeholder="US6285999B1"
                className="h-12 flex-1 rounded-xl border border-line bg-paper px-4 font-mono text-base"
              />
              <button
                type="submit"
                disabled={phase === "working"}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-copper px-5 font-semibold text-copper-ink disabled:opacity-60"
              >
                {phase === "working" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                Analyze patent
              </button>
            </div>
          </label>

          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                type="button"
                className="h-10 rounded-full border border-line bg-paper px-3 text-sm"
                onClick={() => {
                  setPublicationId(sample.id);
                  void buildReport({ id: sample.id });
                }}
              >
                {sample.label}
                <span className="ml-2 font-mono text-muted">{sample.id}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex min-h-16 items-center gap-3 rounded-xl border border-dashed border-line bg-wash px-4 text-left"
            >
              <FileUp className="size-5 shrink-0" />
              <span>
                <span className="block font-semibold">Upload the PDF instead</span>
                <span className="block text-sm text-muted">The file stays in this browser, including scans. FolioPatent reads the pages here, then looks up the number printed on them.</span>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void buildReport({ id: publicationId, file });
              }}
            />
          </div>
        </form>

        {phase === "working" ? (
          <p className="mt-6 flex items-center gap-2 text-sm font-semibold">
            <Loader2 className="size-4 animate-spin" />
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="mt-6 rounded-xl border border-line bg-wash px-4 py-3 text-sm leading-relaxed">{error}</p>
        ) : null}

        {report ? <ReportView report={report} translateTo={translateTo} translating={translating} onLanguage={setTranslateTo} onTranslate={() => void translateAbstract()} /> : null}

        <footer className="mt-16 border-t border-line pt-6 text-sm leading-relaxed text-muted">
          PDFs and scans stay on this device. Lookup uses the configured patent services, then the public patent page. The
          plain-language brief sends only the title, abstract, and a few claims.
        </footer>
      </main>
    </div>
  );
}

function ReportView({
  report,
  translateTo,
  translating,
  onLanguage,
  onTranslate,
}: {
  report: Report;
  translateTo: string;
  translating: boolean;
  onLanguage: (value: string) => void;
  onTranslate: () => void;
}) {
  const record = report.record;
  return (
    <article className="mt-10">
      <p className="font-mono text-sm text-copper">{record?.id ?? "Uploaded document"}</p>
      <h2 className="mt-2 font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
        {record?.title ?? "Text from the uploaded PDF"}
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
        {record?.status ? <span className="rounded-full bg-wash px-3 py-1 font-semibold text-ink">{record.status}</span> : null}
        {record ? (
          <a className="underline decoration-line underline-offset-4" href={patentUrl(record.id)} target="_blank" rel="noreferrer">
            Public record
          </a>
        ) : null}
      </div>
      {report.note ? <p className="mt-3 text-sm text-muted">{report.note}</p> : null}

      <nav className="mt-6 flex gap-2 overflow-x-auto pb-2" aria-label="Report sections">
        {SECTIONS.map((section, index) => (
          <a
            key={section}
            href={`#folio-${index + 1}`}
            className="shrink-0 rounded-full border border-line bg-card px-3 py-2 text-sm"
          >
            <span className="mr-2 font-mono text-copper">{String(index + 1).padStart(2, "0")}</span>
            {section}
          </a>
        ))}
      </nav>

      <div className="mt-6 grid gap-4">
        <Section n={1} title="Inventors" icon={<Users className="size-4" />}>
          <NameList items={record?.inventors ?? []} empty="No inventors were listed on the public record or the PDF front page." />
        </Section>
        <Section n={2} title="Companies" icon={<Layers className="size-4" />}>
          {record && record.assignees.length > 0 ? (
            <ul className="grid gap-2">
              {record.assignees.map((party) => (
                <li key={`${party.role}-${party.name}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2">
                  <span className="font-semibold">{party.name}</span>
                  <span className="text-sm text-muted">{party.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No assignee or applicant was identified.</Empty>
          )}
        </Section>
        <Section n={3} title="Purpose and claims" icon={<ScrollText className="size-4" />}>
          <p className="text-sm font-semibold text-copper">
            {report.brief.source === "brief" ? "Plain-language brief" : "Quoted from the document"}
          </p>
          <p className="mt-2 text-lg leading-relaxed">{report.brief.purpose}</p>
          <ul className="mt-4 grid gap-3">
            {report.brief.claims.map((claim) => (
              <li key={claim} className="rounded-xl bg-wash px-4 py-3 leading-relaxed">
                {claim}
              </li>
            ))}
          </ul>
          {report.writtenClaims.length > 0 ? (
            <div className="mt-5">
              <p className="text-sm font-semibold text-muted">Claims, as written</p>
              <ol className="mt-2 grid gap-3">
                {report.writtenClaims.map((claim) => (
                  <li key={`${claim.number}-${claim.text.slice(0, 24)}`} className="leading-relaxed">
                    <span className="mr-2 font-mono text-sm text-copper">{claim.number}</span>
                    {claim.text}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </Section>
        <Section n={4} title="Technologies" icon={<Search className="size-4" />}>
          <LinkList items={report.scan.technologies} empty="No familiar technology terms or classification leaves were found." />
        </Section>
        <Section n={5} title="Chemicals" icon={<FlaskConical className="size-4" />}>
          {report.scan.chemicals.length > 0 ? (
            <ul className="grid gap-4">
              {report.scan.chemicals.map((item) => (
                <li key={`${item.name}-${item.cas}`} className="border-b border-line pb-3">
                  <p className="font-semibold">{item.name}</p>
                  <p className="mt-1 font-mono text-sm text-muted">
                    {[item.formula && `Formula ${item.formula}`, item.smiles && `SMILES ${item.smiles}`, item.cas && `CAS ${item.cas}`]
                      .filter(Boolean)
                      .join(" · ") || "Name only"}
                  </p>
                  <p className="mt-2 flex flex-wrap gap-3 text-sm">
                    {item.links.map((link) => (
                      <a key={link.label} className="underline decoration-line underline-offset-4" href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No listed compounds, CAS numbers, or SMILES strings were found in the text that was read.</Empty>
          )}
        </Section>
        <Section n={6} title="Organisms" icon={<Microscope className="size-4" />}>
          <LinkList items={report.scan.organisms} empty="No bacteria, viruses, or binomial names from the watch list were found." />
        </Section>
        <Section n={7} title="Materials" icon={<Layers className="size-4" />}>
          <LinkList items={report.scan.materials} empty="No composites, resins, or construction materials from the watch list were found." />
        </Section>
        <Section n={8} title="Cited patents" icon={<Link2 className="size-4" />}>
          {record && record.citations.length > 0 ? (
            <ul className="grid gap-3">
              {record.citations.map((citation) => (
                <li key={citation.number}>
                  <a className="font-mono text-sm underline decoration-line underline-offset-4" href={patentUrl(citation.number)} target="_blank" rel="noreferrer">
                    {citation.number}
                  </a>
                  <p className="leading-snug">{citation.title}</p>
                  {citation.assignee ? <p className="text-sm text-muted">{citation.assignee}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No backward patent citations were listed.</Empty>
          )}
        </Section>
        <Section n={9} title="Dates" icon={<Calendar className="size-4" />}>
          {record && record.dates.length > 0 ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {record.dates.map((date) => (
                <div key={date.label} className="rounded-xl bg-wash px-3 py-3">
                  <dt className="text-sm text-muted">{date.label}</dt>
                  <dd className="mt-1 font-mono text-sm font-medium">{date.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>Filing, publication, and grant dates were not in the record.</Empty>
          )}
        </Section>
        <Section n={10} title="Where it was filed" icon={<Globe2 className="size-4" />}>
          {record ? (
            <p className="text-lg">
              <span className="font-mono">{record.officeCode}</span>
              <span className="text-muted"> · {record.officeName}</span>
            </p>
          ) : (
            <Empty>The filing office is taken from the publication number, which this PDF did not yield.</Empty>
          )}
        </Section>
        <Section n={11} title="Filed elsewhere" icon={<Globe2 className="size-4" />}>
          {record && record.family.length > 0 ? (
            <ul className="grid gap-2">
              {record.family.map((member) => (
                <li key={`${member.country}-${member.number}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2">
                  <span>
                    {member.number ? (
                      <a className="font-mono underline decoration-line underline-offset-4" href={patentUrl(member.number)} target="_blank" rel="noreferrer">
                        {member.number}
                      </a>
                    ) : (
                      <span className="font-semibold">{member.country}</span>
                    )}
                  </span>
                  <span className="text-sm text-muted">{[member.country, member.date].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No foreign family members were listed. This publication may exist only in one office.</Empty>
          )}
        </Section>
        <Section n={12} title="Part of another case" icon={<Link2 className="size-4" />}>
          {record && record.related.length > 0 ? (
            <ul className="grid gap-3">
              {record.related.map((item) => (
                <li key={`${item.relationship}-${item.number}`}>
                  <p className="text-sm text-muted">{item.relationship}</p>
                  {item.number ? (
                    <a className="font-mono text-sm underline decoration-line underline-offset-4" href={patentUrl(item.number)} target="_blank" rel="noreferrer">
                      {item.number}
                    </a>
                  ) : null}
                  {item.title ? <p>{item.title}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No continuation, division, or later family application was listed.</Empty>
          )}
        </Section>
        <Section n={13} title="Language" icon={<Languages className="size-4" />}>
          <p>
            Detected language: <span className="font-semibold">{report.languageLabel}</span>
          </p>
          {report.brief.translation ? (
            <p className="mt-3 leading-relaxed">{report.brief.translation}</p>
          ) : (
            <p className="mt-2 text-sm text-muted">Ask for a translation of the abstract. This is a separate brief, not a full-document translation.</p>
          )}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <select
              value={translateTo}
              onChange={(event) => onLanguage(event.target.value)}
              className="h-11 rounded-xl border border-line bg-paper px-3"
            >
              {LANGUAGES.map((language) => (
                <option key={language}>{language}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={translating || !report.abstract}
              onClick={onTranslate}
              className="h-11 rounded-xl bg-ink px-4 font-semibold text-paper disabled:opacity-60"
            >
              {translating ? "Translating…" : `Translate abstract to ${translateTo}`}
            </button>
          </div>
        </Section>
      </div>
    </article>
  );
}

function Section({ n, title, icon, children }: { n: number; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section id={`folio-${n}`} className="scroll-mt-24 rounded-2xl border border-line bg-card p-4 sm:p-5">
      <h3 className="flex items-center gap-2 font-serif text-2xl tracking-tight">
        <span className="font-mono text-sm text-copper">{String(n).padStart(2, "0")}</span>
        <span className="text-copper">{icon}</span>
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function NameList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item} className="rounded-full bg-wash px-3 py-1 font-semibold">
          {item}
        </li>
      ))}
    </ul>
  );
}

function LinkList({ items, empty }: { items: { name: string; href: string; note: string }[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="grid gap-2">
      {items.map((item) => (
        <li key={item.name} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2">
          <a className="font-semibold underline decoration-line underline-offset-4" href={item.href} target="_blank" rel="noreferrer">
            {item.name}
          </a>
          <span className="text-sm text-muted">{item.note}</span>
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted">{children}</p>;
}
