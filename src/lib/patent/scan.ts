import type { ChemicalHit, NamedLink, Scan } from "./types";
import { escapeRegExp, wikiSearch, wikiUrl } from "./text";

type Chemical = {
  name: string;
  formula?: string;
  smiles?: string;
  cas?: string;
  wiki: string;
};

type Term = { name: string; wiki: string; acronym?: boolean };

const CHEMICALS: Chemical[] = [
  { name: "acetylsalicylic acid", wiki: "Aspirin", formula: "C9H8O4", smiles: "CC(=O)Oc1ccccc1C(=O)O", cas: "50-78-2" },
  { name: "aspirin", wiki: "Aspirin", formula: "C9H8O4", smiles: "CC(=O)Oc1ccccc1C(=O)O", cas: "50-78-2" },
  { name: "ibuprofen", wiki: "Ibuprofen", formula: "C13H18O2", smiles: "CC(C)Cc1ccc(cc1)C(C)C(=O)O", cas: "15687-27-1" },
  { name: "paracetamol", wiki: "Paracetamol", formula: "C8H9NO2", smiles: "CC(=O)Nc1ccc(O)cc1", cas: "103-90-2" },
  { name: "acetaminophen", wiki: "Paracetamol", formula: "C8H9NO2", smiles: "CC(=O)Nc1ccc(O)cc1", cas: "103-90-2" },
  { name: "caffeine", wiki: "Caffeine", formula: "C8H10N4O2", smiles: "Cn1c(=O)c2c(ncn2C)n(C)c1=O", cas: "58-08-2" },
  { name: "paclitaxel", wiki: "Paclitaxel", formula: "C47H51NO14", cas: "33069-62-4" },
  { name: "doxorubicin", wiki: "Doxorubicin", formula: "C27H29NO11", cas: "23214-92-8" },
  { name: "cisplatin", wiki: "Cisplatin", formula: "Pt(NH3)2Cl2", cas: "15663-27-1" },
  { name: "glucose", wiki: "Glucose", formula: "C6H12O6", cas: "50-99-7" },
  { name: "ethanol", wiki: "Ethanol", formula: "C2H6O", smiles: "CCO", cas: "64-17-5" },
  { name: "methanol", wiki: "Methanol", formula: "CH4O", smiles: "CO", cas: "67-56-1" },
  { name: "acetone", wiki: "Acetone", formula: "C3H6O", smiles: "CC(=O)C", cas: "67-64-1" },
  { name: "ethylene carbonate", wiki: "Ethylene carbonate", formula: "C3H4O3", smiles: "C1COC(=O)O1", cas: "96-49-1" },
  { name: "dimethyl carbonate", wiki: "Dimethyl carbonate", formula: "C3H6O3", smiles: "COC(=O)OC", cas: "616-38-6" },
  { name: "lithium carbonate", wiki: "Lithium carbonate", formula: "Li2CO3", cas: "554-13-2" },
  { name: "lithium cobalt oxide", wiki: "Lithium cobalt oxide", formula: "LiCoO2", cas: "12190-79-3" },
  { name: "lithium iron phosphate", wiki: "Lithium iron phosphate", formula: "LiFePO4", cas: "15365-14-7" },
  { name: "polyethylene glycol", wiki: "Polyethylene glycol", cas: "25322-68-3" },
  { name: "sodium chloride", wiki: "Sodium chloride", formula: "NaCl", cas: "7647-14-5" },
  { name: "magnesium chloride", wiki: "Magnesium chloride", formula: "MgCl2", cas: "7786-30-3" },
  { name: "silicon dioxide", wiki: "Silicon dioxide", formula: "SiO2", cas: "7631-86-9" },
  { name: "titanium dioxide", wiki: "Titanium dioxide", formula: "TiO2", cas: "13463-67-7" },
  { name: "graphene", wiki: "Graphene" },
  { name: "carbon nanotube", wiki: "Carbon nanotube" },
  { name: "heparin", wiki: "Heparin", cas: "9005-49-6" },
  { name: "insulin", wiki: "Insulin" },
  { name: "oligonucleotide", wiki: "Oligonucleotide" },
  { name: "deoxyribonucleotide", wiki: "Nucleotide" },
  { name: "nucleotide", wiki: "Nucleotide" },
  { name: "Taq polymerase", wiki: "Taq polymerase" },
  { name: "DNA polymerase", wiki: "DNA polymerase" },
];

const ORGANISMS: Term[] = [
  { name: "Escherichia coli", wiki: "Escherichia coli" },
  { name: "Saccharomyces cerevisiae", wiki: "Saccharomyces cerevisiae" },
  { name: "Staphylococcus aureus", wiki: "Staphylococcus aureus" },
  { name: "Bacillus subtilis", wiki: "Bacillus subtilis" },
  { name: "Pseudomonas aeruginosa", wiki: "Pseudomonas aeruginosa" },
  { name: "Thermus aquaticus", wiki: "Thermus aquaticus" },
  { name: "Mycobacterium tuberculosis", wiki: "Mycobacterium tuberculosis" },
  { name: "Salmonella enterica", wiki: "Salmonella enterica" },
  { name: "Helicobacter pylori", wiki: "Helicobacter pylori" },
  { name: "Streptococcus pneumoniae", wiki: "Streptococcus pneumoniae" },
  { name: "Lactobacillus acidophilus", wiki: "Lactobacillus acidophilus" },
  { name: "Homo sapiens", wiki: "Human" },
  { name: "Mus musculus", wiki: "House mouse" },
  { name: "Arabidopsis thaliana", wiki: "Arabidopsis thaliana" },
  { name: "Cannabis sativa", wiki: "Cannabis sativa" },
  { name: "Plasmodium falciparum", wiki: "Plasmodium falciparum" },
  { name: "SARS-CoV-2", wiki: "SARS-CoV-2" },
  { name: "HIV-1", wiki: "HIV", acronym: true },
  { name: "influenza virus", wiki: "Influenza virus" },
  { name: "hepatitis B virus", wiki: "Hepatitis B virus" },
  { name: "hepatitis C virus", wiki: "Hepatitis C virus" },
  { name: "human papillomavirus", wiki: "Human papillomavirus" },
  { name: "herpes simplex virus", wiki: "Herpes simplex virus" },
  { name: "adenovirus", wiki: "Adenoviridae" },
  { name: "bacteriophage", wiki: "Bacteriophage" },
];

const EPITHET_STOP = new Set([
  "responsible", "method", "process", "which", "wherein", "comprising", "sequence", "nucleic", "acid", "using", "from",
  "with", "that", "this", "into", "such", "under", "after", "before", "between", "within", "without", "during", "about",
  "their", "there", "these", "those", "other", "first", "second", "having", "being", "including", "according", "following",
  "present", "invention", "polymerase", "virus", "bacteria", "species", "strain", "basis", "crisis", "thesis", "analysis",
  "synthesis", "previous", "various", "numerous", "obvious", "aqueous", "organic", "formula", "plasma", "media", "data",
  "extra", "alpha", "beta", "gamma", "delta", "supra", "infra", "via", "above", "below", "group", "groups", "form",
  "forms", "type", "dose", "range", "level", "blood", "cells", "peptide", "protein", "hormone", "agent", "salt", "ester",
  "treatment", "composition", "compound", "device", "system", "example", "figure", "table", "claim", "step", "shown",
  "described", "disclosed", "provided", "obtained", "prepared", "preferred", "suitable", "available", "particular",
]);

const GENUS_STOP = new Set([
  "the", "this", "that", "these", "those", "said", "such", "each", "both", "when", "where", "after", "before", "during",
  "using", "having", "being", "other", "from", "with", "into", "over", "under", "about", "between", "within", "without",
  "against", "among", "patent", "claim", "example", "figure", "table", "step", "method", "process", "composition",
  "compound", "invention", "present", "following", "above", "below", "further", "first", "second", "third", "amino",
  "acid", "fatty", "nucleic", "human", "mouse", "type", "group", "form", "dose", "range", "level", "blood", "cell",
  "virus", "peptide", "protein", "hormone", "agent", "salt", "ester", "base", "metal", "water", "buffer", "solution",
  "mixture", "material", "polymer", "solvent", "reagent", "substance", "device", "system", "apparatus", "injection",
  "treatment", "diabetes", "obesity", "glucose", "insulin", "according", "wherein", "comprising", "including", "preferred",
  "embodiment", "description", "abstract", "background", "summary", "claimed", "what", "some", "many", "more", "most",
  "only", "also", "then", "than", "into", "upon", "once", "week", "weekly", "said", "herein", "thereof", "thereby",
]);

const MATERIALS: Term[] = [
  { name: "epoxy resin", wiki: "Epoxy" },
  { name: "carbon fiber", wiki: "Carbon-fiber reinforced polymer" },
  { name: "carbon-fiber", wiki: "Carbon-fiber reinforced polymer" },
  { name: "glass fiber", wiki: "Glass fiber" },
  { name: "fiberglass", wiki: "Fiberglass" },
  { name: "aramid", wiki: "Aramid" },
  { name: "Kevlar", wiki: "Kevlar" },
  { name: "polyurethane", wiki: "Polyurethane" },
  { name: "polycarbonate", wiki: "Polycarbonate" },
  { name: "polyethylene terephthalate", wiki: "Polyethylene terephthalate" },
  { name: "polyvinyl chloride", wiki: "Polyvinyl chloride" },
  { name: "polyethylene", wiki: "Polyethylene" },
  { name: "polypropylene", wiki: "Polypropylene" },
  { name: "stainless steel", wiki: "Stainless steel" },
  { name: "aluminum alloy", wiki: "Aluminium alloy" },
  { name: "concrete", wiki: "Concrete" },
  { name: "Portland cement", wiki: "Portland cement" },
  { name: "ceramic", wiki: "Ceramic" },
  { name: "silicone rubber", wiki: "Silicone rubber" },
  { name: "plywood", wiki: "Plywood" },
  { name: "gypsum", wiki: "Gypsum" },
];

const TECHNOLOGIES: Term[] = [
  { name: "polymerase chain reaction", wiki: "Polymerase chain reaction" },
  { name: "PCR", wiki: "Polymerase chain reaction", acronym: true },
  { name: "CRISPR", wiki: "CRISPR", acronym: true },
  { name: "CRISPR-Cas9", wiki: "CRISPR gene editing" },
  { name: "monoclonal antibody", wiki: "Monoclonal antibody" },
  { name: "mRNA vaccine", wiki: "mRNA vaccine" },
  { name: "lithium-ion battery", wiki: "Lithium-ion battery" },
  { name: "lithium ion battery", wiki: "Lithium-ion battery" },
  { name: "solid-state battery", wiki: "Solid-state battery" },
  { name: "solar cell", wiki: "Solar cell" },
  { name: "photovoltaic", wiki: "Photovoltaics" },
  { name: "perovskite", wiki: "Perovskite solar cell" },
  { name: "fuel cell", wiki: "Fuel cell" },
  { name: "medical device", wiki: "Medical device" },
  { name: "stent", wiki: "Stent" },
  { name: "catheter", wiki: "Catheter" },
  { name: "pacemaker", wiki: "Artificial cardiac pacemaker" },
  { name: "biosensor", wiki: "Biosensor" },
  { name: "immunoassay", wiki: "Immunoassay" },
  { name: "neural network", wiki: "Neural network (machine learning)" },
  { name: "machine learning", wiki: "Machine learning" },
  { name: "semiconductor", wiki: "Semiconductor" },
  { name: "transistor", wiki: "Transistor" },
  { name: "OLED", wiki: "OLED", acronym: true },
  { name: "lidar", wiki: "Lidar" },
  { name: "quantum computing", wiki: "Quantum computing" },
  { name: "microfluidic", wiki: "Microfluidics" },
  { name: "nanoparticle", wiki: "Nanoparticle" },
  { name: "drug delivery", wiki: "Drug delivery" },
  { name: "additive manufacturing", wiki: "3D printing" },
  { name: "carbon capture", wiki: "Carbon capture and storage" },
  { name: "wind turbine", wiki: "Wind turbine" },
];

function mentioned(text: string, term: string, acronym = false): boolean {
  if (acronym) return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`).test(text);
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, "i").test(text);
}

function linkFor(name: string, wiki: string, note = ""): NamedLink {
  return { name, href: wikiUrl(wiki), note };
}

const CHEMICAL_CLASS =
  "(?:acid|oxide|dioxide|chloride|hydrochloride|sulfate|sulphate|phosphate|carbonate|hydroxide|nitrate|acetate|bromide|iodide|fluoride|ether|ester|amide|amine|ketone|alcohol|anhydride|hydrate|hydrobromide|mesylate|citrate|tartrate|maleate|fumarate|succinate|sulfonate|sulphonate|glycol)";
const CHEMICAL_NAME = new RegExp(
  `\\b([A-Za-z][a-z]{2,}(?:[- ](?:[A-Za-z][a-z]{2,}|[0-9]+)){0,4}[- ]${CHEMICAL_CLASS})\\b`,
  "gi",
);
const DRUG_STEM =
  /\b([A-Za-z][a-z]{2,}(?:olol|sartan|vastatin|statin|cillin|mycin|cycline|prazole|dipine|azepam|oxetine|gliptin|flozin|lukast|profen|navir|ciclib|tinib|setron|conazole|thiazide|fibrate|barbital|caine|tidine|afil|mustine|rubicin|taxel|platin|glutide|natide|paratide|zenatide))\b/g;
const FRAGMENT_NAME =
  /^(?:methyl|ethyl|propyl|butyl|pentyl|hexyl|heptyl|octyl|phenyl|vinyl|allyl|least|most|between|about|alpha|beta|gamma|carbon|group|component|polymer)-\d+$/i;
const GENERIC_CHEMICAL = new Set([
  "amino acid", "nucleic acid", "fatty acid", "organic acid", "inorganic acid", "the acid", "said acid", "an acid",
  "the oxide", "the salt", "said salt", "the ester", "the amide", "the amine", "the alcohol", "the ether",
]);
const CHEMICAL_HEAD_STOP = new Set([
  "the", "said", "such", "this", "that", "any", "each", "organic", "inorganic", "fatty", "amino", "nucleic", "dilute",
  "concentrated", "aqueous", "strong", "weak", "suitable", "preferred", "corresponding", "respective", "optional",
]);

function parseChemicals(text: string): { name: string; formula: string; cas: string; note: string }[] {
  const found: { name: string; formula: string; cas: string; note: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, formula = "", cas = "", note = "Named in the text") => {
    const clean = trimChemicalName(name);
    const key = clean.toLowerCase();
    if (clean.length < 3 || seen.has(key) || GENERIC_CHEMICAL.has(key) || VAGUE.has(key)) return;
    if (!plausibleChemicalName(clean) && !cas && !isChemicalFormula(formula || clean)) return;
    if (CHEMICAL_HEAD_STOP.has(key.split(/[\s-]/)[0] ?? "")) return;
    seen.add(key);
    found.push({ name: clean, formula, cas, note });
  };
  for (const match of text.matchAll(/\b(\d{2,7}-\d{2}-\d)\b/g)) {
    const cas = match[1] ?? "";
    if (!casChecksum(cas)) continue;
    add(`CAS ${cas}`, "", cas, "CAS number in the text");
  }
  for (const match of text.matchAll(CHEMICAL_NAME)) add(match[1] ?? "");
  for (const match of text.matchAll(DRUG_STEM)) add(match[1] ?? "");
  for (const smiles of explicitSmiles(text)) add(`SMILES ${smiles}`, "", "", "SMILES string in the text");
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]{1,24})\b/g)) {
    const formula = match[1] ?? "";
    if (!isChemicalFormula(formula)) continue;
    add(formula, formula, "", "Formula in the text");
  }
  return found;
}

function trimChemicalName(name: string): string {
  const stop = new Set([...CHEMICAL_HEAD_STOP, "and", "or", "of", "for", "with", "from"]);
  const parts = name.replace(/\s+/g, " ").trim().split(" ");
  while (parts.length > 1 && stop.has((parts[0] ?? "").toLowerCase())) parts.shift();
  return parts.join(" ");
}

function casChecksum(cas: string): boolean {
  const digits = cas.replace(/-/g, "");
  if (!/^\d{5,10}$/.test(digits)) return false;
  const check = Number(digits.slice(-1));
  const body = digits.slice(0, -1).split("").reverse();
  const sum = body.reduce((total, digit, index) => total + Number(digit) * (index + 1), 0);
  return sum % 10 === check;
}

export function isIpcCode(value: string): boolean {
  return /^[A-HY]\d{2}[A-Z](?:\d{1,4}\/\d{2,6})?$/i.test(value.replace(/\s+/g, ""));
}

export function isChemicalFormula(value: string): boolean {
  const clean = value.replace(/\s+/g, "");
  if (clean.length < 2 || clean.length > 30 || isIpcCode(clean) || !/\d/.test(clean)) return false;
  if (/^C\d{1,3}H\d{1,3}[A-Za-z0-9()]*$/.test(clean)) return true;
  if (/^(?:H2O|CO2|NO2|SO2|SO3|NH3|HCl)$/.test(clean)) return true;
  return /[a-z]/.test(clean) && /[A-Z]/.test(clean) && /^[A-Za-z0-9()]+$/.test(clean);
}

export function plausibleChemicalName(name: string): boolean {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length < 3 || FRAGMENT_NAME.test(clean)) return false;
  if (isIpcCode(clean)) return false;
  if (/^[A-Z0-9]{2,6}$/.test(clean) && !isChemicalFormula(clean)) return false;
  return true;
}

export function parseIpcCodes(text: string): { code: string; description: string }[] {
  const found: { code: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b([A-HY]\d{2}[A-Z])(?:\s*(\d{1,4})\s*\/\s*(\d{2,6}))?\b/g)) {
    const main = (match[1] ?? "").toUpperCase();
    const code = match[2] && match[3] ? `${main} ${match[2]}/${match[3]}` : main;
    if (seen.has(code)) continue;
    seen.add(code);
    found.push({ code, description: "" });
  }
  return found;
}

const LATIN_EPITHET = /^(?:[a-z]{4,}(?:ensis|oides|icola|iana|ianus|icus|ica|orum|arum|ens)|[a-z]{3,}(?:ii|iae|ae|us|um|is|i))$/;
const CELL_LINE = /\b(HeLa|HEK-?293|CHO-K1|CHO|Vero|Jurkat|MCF-7|A549|NIH\/3T3|SP2\/0)\b/g;
const VIRUS_NAME = /\b([A-Z][A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){0,3}\s+virus)\b/g;

function parseOrganisms(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const clean = name.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (clean.length < 5 || seen.has(key)) return;
    seen.add(key);
    names.push(clean);
  };
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,})\s+([a-z]{3,})\b/g)) {
    const genus = match[1] ?? "";
    const species = match[2] ?? "";
    if (GENUS_STOP.has(genus.toLowerCase()) || EPITHET_STOP.has(species) || !LATIN_EPITHET.test(species)) continue;
    add(`${genus} ${species}`);
  }
  for (const match of text.matchAll(/\b([A-Z])\.\s*([a-z]{3,})\b/g)) {
    const species = match[2] ?? "";
    if (EPITHET_STOP.has(species) || !LATIN_EPITHET.test(species)) continue;
    add(`${match[1]}. ${species}`);
  }
  for (const match of text.matchAll(VIRUS_NAME)) {
    const name = match[1] ?? "";
    if (GENUS_STOP.has(name.split(" ")[0]?.toLowerCase() ?? "")) continue;
    add(name);
  }
  for (const match of text.matchAll(CELL_LINE)) add(match[1] ?? "");
  for (const match of text.matchAll(/\b(ATCC\s*(?:No\.?\s*)?[A-Z]{0,5}\s*\d{3,8})\b/gi)) add((match[1] ?? "").replace(/\s+/g, " "));
  return names;
}

const MATERIAL_NAME =
  /\b((?:carbon|glass|stainless|portland|epoxy)\s+)?((?:epoxy(?:\s+resin)?|polyurethane|polycarbonate|polyethylene|polypropylene|polystyrene|polyester|polyamide|polyimide|silicone(?:\s+rubber)?|aramid|fiberglass|graphene|ceramic|plywood|gypsum|kevlar|steel|alloy|cement|resin|fiber|fibre))\b/gi;

function parseMaterials(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MATERIAL_NAME)) {
    const prefix = (match[1] ?? "").trim();
    const core = (match[2] ?? "").trim();
    const name = `${prefix} ${core}`.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (name.length < 4 || seen.has(key) || key === prefix.toLowerCase()) continue;
    if (!prefix && /^(?:resin|fiber|fibre|alloy)$/i.test(core)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function chemicalLinks(item: Chemical): ChemicalHit["links"] {
  const links = [
    { label: "Wikipedia", href: wikiUrl(item.wiki) },
    { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(item.name)}` },
  ];
  if (item.cas) links.push({ label: "CAS", href: `https://commonchemistry.cas.org/detail?cas_rn=${item.cas}` });
  return links;
}

function explicitSmiles(text: string): string[] {
  return uniqueStrings(
    [...text.matchAll(/\bSMILES[:\s]+([A-Za-z0-9@+\-\[\]()\\/=#$.]{3,80})/g)].map((match) => match[1] ?? ""),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function scanText(text: string, extras?: { classifications?: { code: string; description: string }[]; keywords?: string[] }): Scan {
  const chemicals: ChemicalHit[] = [];
  const seenChem = new Set<string>();
  const addChemical = (hit: ChemicalHit) => {
    const key = hit.cas ? `cas:${hit.cas}` : `name:${hit.name.toLowerCase()}`;
    if (seenChem.has(key)) return;
    seenChem.add(key);
    chemicals.push(hit);
  };
  for (const found of parseChemicals(text)) {
    const known = CHEMICALS.find((item) => item.name.toLowerCase() === found.name.toLowerCase() || (found.cas && item.cas === found.cas));
    if (known) {
      addChemical({
        name: known.name,
        formula: known.formula ?? found.formula,
        smiles: known.smiles ?? "",
        cas: known.cas ?? found.cas,
        links: chemicalLinks(known),
        note: found.note,
      });
      continue;
    }
    addChemical({
      name: found.name,
      formula: found.formula,
      smiles: "",
      cas: found.cas,
      links: looseChemicalLinks(found.name, found.cas),
      note: found.note,
    });
  }

  const organisms: NamedLink[] = [];
  const seenOrg = new Set<string>();
  const addOrganism = (name: string, href: string, note: string) => {
    const key = name.toLowerCase();
    if (seenOrg.has(key)) return;
    seenOrg.add(key);
    organisms.push({ name, href, note });
  };
  for (const item of ORGANISMS) {
    if (!mentioned(text, item.name, item.acronym)) continue;
    addOrganism(item.name, wikiUrl(item.wiki), "Named in the text");
  }
  for (const name of parseOrganisms(text)) addOrganism(name, wikiSearch(name), "Named in the text");

  const materials: NamedLink[] = [];
  const seenMaterial = new Set<string>();
  const addMaterial = (name: string, href: string, note: string) => {
    const key = name.toLowerCase();
    if (seenMaterial.has(key) || VAGUE.has(key)) return;
    seenMaterial.add(key);
    materials.push({ name, href, note });
  };
  for (const item of MATERIALS) {
    if (mentioned(text, item.name)) addMaterial(item.name, wikiUrl(item.wiki), "Named in the text");
  }
  for (const name of parseMaterials(text)) {
    const known = MATERIALS.find((item) => item.name.toLowerCase() === name.toLowerCase());
    addMaterial(name, known ? wikiUrl(known.wiki) : wikiSearch(name), "Named in the text");
  }

  const technologies: NamedLink[] = [];
  const seenTech = new Set<string>();
  const pushTech = (item: NamedLink) => {
    const key = item.name.toLowerCase();
    if (seenTech.has(key)) return;
    seenTech.add(key);
    technologies.push(item);
  };
  for (const item of TECHNOLOGIES) {
    if (mentioned(text, item.name, item.acronym)) pushTech(linkFor(item.name, item.wiki, "Named in the text"));
  }
  for (const keyword of extras?.keywords ?? []) {
    const known = TECHNOLOGIES.find((item) => item.name.toLowerCase() === keyword.toLowerCase());
    if (known) pushTech(linkFor(known.name, known.wiki, "Indexing keyword"));
  }

  const classes = mergeClasses(extras?.classifications ?? [], parseIpcCodes(text));
  for (const material of materials) {
    if (chemicals.some((chemical) => chemical.name.toLowerCase() === material.name.toLowerCase())) continue;
    if (chemicals.some((chemical) => chemical.name.toLowerCase().startsWith(`${material.name.toLowerCase()} `))) continue;
    chemicals.push({
      name: material.name,
      formula: "",
      smiles: "",
      cas: "",
      links: [
        { label: "Wikipedia", href: material.href },
        { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(material.name)}` },
      ],
      note: material.note || "Polymer or material named in the text",
    });
  }
  return {
    technologies: technologies.slice(0, 24),
    chemicals: chemicals.filter((item) => plausibleChemicalName(item.name) || isChemicalFormula(item.formula) || item.cas).slice(0, 80),
    organisms: organisms.slice(0, 40),
    materials: [],
    classes,
  };
}

function mergeClasses(
  listed: { code: string; description: string }[],
  parsed: { code: string; description: string }[],
): { code: string; description: string }[] {
  const found: { code: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const item of [...listed, ...parsed]) {
    const code = item.code.replace(/\s+/g, " ").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    found.push({ code, description: item.description.replace(/\s+/g, " ").trim() });
  }
  const detailed = new Set(found.filter((item) => item.code.includes(" ")).map((item) => item.code.split(" ")[0]));
  return found.filter((item) => item.code.includes(" ") || !detailed.has(item.code)).slice(0, 40);
}

type LatinHint = { code: string; tess: string; label: string; pattern: string };

const LATIN_HINTS: LatinHint[] = [
  { code: "da", tess: "dan", label: "Danish", pattern: "opfinder|patenthaver|ansøger|ansoeger|fremgangsmåde|fremgangsmade|kendetegnet|opfindelsen" },
  { code: "nl", tess: "nld", label: "Dutch", pattern: "octrooi|aanvrager|uitvinder|werkwijze|gekenmerkt|inrichting|octrooiaanvrage" },
  { code: "de", tess: "deu", label: "German", pattern: "vorrichtung|dadurch|gekennzeichnet|erfinder|anmelder|patentinhaber|anspruch|erfindung" },
  { code: "fr", tess: "fra", label: "French", pattern: "procédé|procede|dispositif|caractérisé|caracterise|inventeur|demandeur|revendication|invention" },
  { code: "es", tess: "spa", label: "Spanish", pattern: "dispositivo|caracterizado|reivindicación|reivindicacion|invención|invencion|solicitante|método|metodo" },
  { code: "pt", tess: "por", label: "Portuguese", pattern: "caracterizado|reivindicação|reivindicacao|dispositivo|invenção|invencao|requerente|compreendendo" },
  { code: "it", tess: "ita", label: "Italian", pattern: "caratterizzato|rivendicazione|dispositivo|invenzione|richiedente|comprendente|procedimento" },
  { code: "sv", tess: "swe", label: "Swedish", pattern: "kännetecknad|kannetecknad|uppfinning|anordning|förfarande|forfarande|patentkrav|sökande|sokande" },
  { code: "no", tess: "nor", label: "Norwegian", pattern: "kjennetegnet|oppfinnelse|anordning|oppfinner|patentkrav|søker|soker" },
  { code: "fi", tess: "fin", label: "Finnish", pattern: "tunnettu|keksintö|keksinto|menetelmä|menetelma|patenttivaatimus|laitteisto" },
  { code: "pl", tess: "pol", label: "Polish", pattern: "znamienny|wynalazek|urządzenie|urzadzenie|zastrzeżenie|zastrzezenie|wynalazca|zgłaszający|zglaszajacy" },
  { code: "ro", tess: "ron", label: "Romanian", pattern: "caracterizat|invenție|inventie|revendicare|dispozitiv|solicitant|procedeul" },
  { code: "tr", tess: "tur", label: "Turkish", pattern: "buluş|bulus|istem|cihaz|yöntem|yontem|başvuru|basvuru|mucit" },
  { code: "lt", tess: "lit", label: "Lithuanian", pattern: "išradimas|isradimas|įrenginys|irenginys|apibrėžtas|apibreztas|išradėjas|isradejas" },
  { code: "lv", tess: "lav", label: "Latvian", pattern: "izgudrojums|ierīce|ierice|paņēmiens|panemiens|pretenzija|izgudrotājs|izgudrotajs" },
  { code: "af", tess: "afr", label: "Afrikaans", pattern: "uitvinding|werkwyse|gekenmerk|toestel|aansoeker|uitvinder" },
  { code: "id", tess: "ind", label: "Indonesian", pattern: "penemuan|perangkat|dicirikan|pemohon|penemu" },
  { code: "ms", tess: "msa", label: "Malay", pattern: "ciptaan|peranti|kaedah|dicirikan|pemohon|pereka" },
  { code: "vi", tess: "vie", label: "Vietnamese", pattern: "sáng chế|sang che|thiết bị|thiet bi|phương pháp|phuong phap" },
  { code: "fil", tess: "fil", label: "Filipino", pattern: "imbensyon|pamamaraan|imbentor" },
  { code: "sw", tess: "swa", label: "Swahili", pattern: "uvumbuzi|kifaa|mvumbuzi" },
  { code: "en", tess: "eng", label: "English", pattern: "comprising|wherein|invention|assignee|applicant|claim|device|method" },
];

function countTerms(sample: string, pattern: string): number {
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "giu");
  return sample.match(re)?.length ?? 0;
}

function scriptLanguage(sample: string): { code: string; label: string } | null {
  if (/[\u3040-\u30ff]/.test(sample)) return { code: "ja", label: "Japanese" };
  if (/[\uac00-\ud7af]/.test(sample)) return { code: "ko", label: "Korean" };
  if (/[\u4e00-\u9fff]/.test(sample)) return { code: "zh", label: "Chinese" };
  if (/[\u0590-\u05ff]/.test(sample)) return { code: "he", label: "Hebrew" };
  if (/[\u0600-\u06ff]/.test(sample)) return { code: "ar", label: "Arabic" };
  if (/[\u0e00-\u0e7f]/.test(sample)) return { code: "th", label: "Thai" };
  if (/[\u0900-\u097f]/.test(sample)) return { code: "hi", label: "Hindi" };
  if (/[\u0370-\u03ff]/.test(sample)) return { code: "el", label: "Greek" };
  if (/[\u1780-\u17ff]/.test(sample)) return { code: "km", label: "Khmer" };
  if (/[\u0400-\u04ff]/.test(sample)) {
    if (/[ъьюя]/.test(sample.toLowerCase()) && /[щыэ]/.test(sample.toLowerCase()) === false && /\b(изобретение|устройство|заявител)\b/i.test(sample)) {
      return { code: "bg", label: "Bulgarian" };
    }
    if (/\b(изобретение|заявител|претенц)\b/i.test(sample)) return { code: "bg", label: "Bulgarian" };
    return { code: "ru", label: "Russian" };
  }
  return null;
}

function latinHits(sample: string): { hint: LatinHint; hits: number }[] {
  return LATIN_HINTS.map((hint) => ({ hint, hits: countTerms(sample, hint.pattern) })).sort((a, b) => b.hits - a.hits);
}

export function detectLanguage(text: string): { code: string; label: string } {
  const sample = text.slice(0, 2500);
  const script = scriptLanguage(sample);
  if (script) return script;
  const ranked = latinHits(sample);
  const best = ranked[0];
  if (!best || best.hits < 3) return { code: "en", label: "English" };
  return { code: best.hint.code, label: best.hint.label };
}

export function detectScanLanguage(text: string): { tess: string; label: string } | null {
  const sample = text.slice(0, 2500);
  if (scriptLanguage(sample)) return null;
  const ranked = latinHits(sample);
  const english = ranked.find((item) => item.hint.tess === "eng")?.hits ?? 0;
  const other = ranked.find((item) => item.hint.tess !== "eng");
  if (!other || other.hits < 3 || other.hits < english) return null;
  return { tess: other.hint.tess, label: other.hint.label };
}

export type PageFinding = {
  chemicals: { name: string; formula: string; cas: string; note: string }[];
  organisms: { name: string; note: string }[];
  materials: { name: string; note: string }[];
  technologies: { name: string; note: string }[];
};

const VAGUE = new Set([
  "compound", "compounds", "solution", "solutions", "mixture", "mixtures", "composition", "compositions", "material",
  "materials", "polymer", "polymers", "solvent", "solvents", "reagent", "reagents", "substance", "substances", "agent",
  "agents", "salt", "salts", "acid", "acids", "base", "bases", "metal", "metals", "resin", "organism", "organisms",
  "cell", "cells", "bacteria", "virus", "viruses", "protein", "proteins", "peptide", "peptides", "antibody", "antibodies",
  "gene", "genes", "sequence", "water", "buffer", "excipient", "carrier", "host", "patient", "animal", "mouse", "rat",
  "human", "microorganism", "microorganisms",
]);

export function absorbFindings(base: Scan, found: PageFinding): Scan {
  const chemicals = [...base.chemicals];
  for (const item of found.chemicals) {
    const name = cleanName(item.name, 160);
    const cas = /^\d{2,7}-\d{2}-\d$/.test(item.cas) ? item.cas : "";
    const formula = isChemicalFormula(item.formula) ? cleanFormula(item.formula) : "";
    if (!name || isIpcCode(name) || (!plausibleChemicalName(name) && !cas && !formula)) continue;
    if (VAGUE.has(name.toLowerCase()) && !cas && !formula) continue;
    const key = cas ? `cas:${cas}` : `name:${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    const index = chemicals.findIndex((chemical) => chemicalKey(chemical) === key || chemical.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) {
      const current = chemicals[index];
      if (!current) continue;
      chemicals[index] = {
        ...current,
        name: current.name.startsWith("CAS ") ? name : current.name,
        formula: current.formula || formula,
        cas: current.cas || cas,
        note: joinNote(current.note, item.note),
      };
      continue;
    }
    const known = CHEMICALS.find((chemical) => chemical.name.toLowerCase() === name.toLowerCase());
    chemicals.push(
      known
        ? {
            name: known.name,
            formula: known.formula ?? formula,
            smiles: known.smiles ?? "",
            cas: known.cas ?? cas,
            links: chemicalLinks(known),
            note: item.note,
          }
        : {
            name,
            formula,
            smiles: "",
            cas,
            links: looseChemicalLinks(name, cas),
            note: item.note,
          },
    );
  }

  const organisms = [...base.organisms];
  for (const item of found.organisms) {
    const name = cleanName(item.name);
    if (!name || VAGUE.has(name.toLowerCase())) continue;
    if (organisms.some((organism) => organism.name.toLowerCase() === name.toLowerCase())) {
      const current = organisms.find((organism) => organism.name.toLowerCase() === name.toLowerCase());
      if (current && item.note && !current.note.includes(item.note)) current.note = joinNote(current.note, item.note);
      continue;
    }
    organisms.push({ name, href: wikiSearch(name), note: item.note || "Named in the text" });
  }

  const materials = [...base.materials];
  for (const item of found.materials) {
    const name = cleanName(item.name);
    if (!name || VAGUE.has(name.toLowerCase())) continue;
    if (materials.some((material) => material.name.toLowerCase() === name.toLowerCase())) continue;
    const known = MATERIALS.find((material) => material.name.toLowerCase() === name.toLowerCase());
    materials.push({
      name,
      href: known ? wikiUrl(known.wiki) : wikiSearch(name),
      note: item.note || "Named in the text",
    });
  }
  for (const material of materials) {
    if (chemicals.some((chemical) => chemical.name.toLowerCase() === material.name.toLowerCase())) continue;
    chemicals.push({
      name: material.name,
      formula: "",
      smiles: "",
      cas: "",
      links: [
        { label: "Wikipedia", href: material.href },
        { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(material.name)}` },
      ],
      note: material.note || "Polymer or material named in the text",
    });
  }

  const technologies = [...base.technologies];
  for (const item of found.technologies) {
    const name = cleanName(item.name, 80);
    if (!name || VAGUE.has(name.toLowerCase())) continue;
    if (technologies.some((technology) => technology.name.toLowerCase() === name.toLowerCase())) continue;
    const known = TECHNOLOGIES.find((technology) => technology.name.toLowerCase() === name.toLowerCase());
    technologies.push({
      name,
      href: known ? wikiUrl(known.wiki) : wikiSearch(name),
      note: item.note || "Named in the text",
    });
  }

  return {
    technologies: technologies.slice(0, 24),
    chemicals: chemicals.slice(0, 80),
    organisms: organisms.slice(0, 40),
    materials: [],
    classes: base.classes ?? [],
  };
}

function chemicalKey(item: ChemicalHit): string {
  if (item.cas) return `cas:${item.cas}`;
  return `name:${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
}

function cleanName(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > max) return "";
  if (/[.!?]$/.test(clean) && clean.split(" ").length > 12) return "";
  return clean;
}

function cleanFormula(value: string): string {
  const clean = value.replace(/\s+/g, "").trim();
  if (!clean || clean.length > 40) return "";
  if (!/[A-Za-z]/.test(clean) || !/\d/.test(clean)) return "";
  return clean;
}

function joinNote(left?: string, right?: string): string {
  const parts = [left, right].map((item) => item?.trim() ?? "").filter(Boolean);
  return [...new Set(parts)].join(" · ").slice(0, 160);
}

function looseChemicalLinks(name: string, cas: string): ChemicalHit["links"] {
  const query = cas || name;
  const links = [
    { label: "Wikipedia", href: wikiSearch(name) },
    { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(query)}` },
  ];
  if (cas) links.push({ label: "CAS", href: `https://commonchemistry.cas.org/detail?cas_rn=${cas}` });
  return links;
}
