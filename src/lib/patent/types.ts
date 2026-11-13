export type DatedFact = {
  label: string;
  value: string;
};

export type NamedParty = {
  name: string;
  role: string;
};

export type ClaimText = {
  number: string;
  text: string;
  independent: boolean;
};

export type Citation = {
  number: string;
  title: string;
  assignee: string;
};

export type FamilyMember = {
  number: string;
  date: string;
  country: string;
};

export type RelatedCase = {
  number: string;
  relationship: string;
  title: string;
};

export type Classification = {
  code: string;
  description: string;
};

export type PatentNumber = {
  label: string;
  value: string;
};

export type OfficialRecord = {
  id: string;
  title: string;
  status: string;
  inventors: string[];
  assignees: NamedParty[];
  abstract: string;
  claims: ClaimText[];
  excerpt: string;
  dates: DatedFact[];
  numbers: PatentNumber[];
  officeCode: string;
  officeName: string;
  citations: Citation[];
  family: FamilyMember[];
  related: RelatedCase[];
  classifications: Classification[];
  keywords: string[];
  language: string;
  sourceNotes: string[];
};

export type ChemicalHit = {
  name: string;
  formula: string;
  smiles: string;
  cas: string;
  links: { label: string; href: string }[];
};

export type NamedLink = {
  name: string;
  href: string;
  note: string;
};

export type ClaimNote = {
  number: string;
  bullets: string[];
};

export type Brief = {
  abstractSummary: string;
  backgroundSummary: string;
  patentSummary: string;
  claimNotes: ClaimNote[];
  source: "brief" | "extract";
};

export type Scan = {
  technologies: NamedLink[];
  chemicals: ChemicalHit[];
  organisms: NamedLink[];
  materials: NamedLink[];
};

export type LookupInput = {
  id: string;
};
