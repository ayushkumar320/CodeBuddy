import type { IncidentSeverity } from "../core/memory-file-store.js";
import type { ExtractionInput, MemoryCandidate, MemoryClass } from "./types.js";

/**
 * Deterministic, no-LLM extraction. This is the always-available baseline
 * (offline mode) and the fallback when LLM extraction fails validation. It
 * segments the turn summary into sentences and classifies each with ordered
 * keyword rules. The same input always yields the same candidates, which keeps
 * capture predictable and auditable.
 *
 * Rule order matters: a "TODO: fix the crash" is a note, not an incident, so
 * note markers are checked before incident markers.
 */

type Rule = {
  class: MemoryClass;
  regex: RegExp;
  confidence: number;
  predicate: string;
  subject: string;
};

const RULES: Rule[] = [
  {
    class: "note",
    subject: "note",
    predicate: "todo",
    confidence: 0.4,
    regex:
      /\b(todo|to-do|follow[- ]?up|later|remember to|revisit|temporary|tmp|next time|should probably)\b/i,
  },
  {
    class: "decision",
    subject: "decision",
    predicate: "made",
    confidence: 0.8,
    regex:
      /\b(decided|chose|choose|we will|going with|switched to|switch to|adopt(?:ed)?|agreed|settled on|opt(?:ed)? for)\b/i,
  },
  {
    class: "incident",
    subject: "incident",
    predicate: "occurred",
    confidence: 0.75,
    regex:
      /\b(bug|regression|broke|broken|crash(?:ed)?|outage|incident|root cause|failure|failed|null pointer|race condition|deadlock)\b/i,
  },
  {
    class: "fact",
    subject: "project",
    predicate: "fact",
    confidence: 0.55,
    regex:
      /\b(uses?|is|are|requires?|depends on|stores?|returns?|implemented|added|supports?|configured|lives in|located|handles?)\b/i,
  },
];

const SEVERITY_MARKERS: Array<{ severity: IncidentSeverity; regex: RegExp }> = [
  { severity: "critical", regex: /\b(critical|outage|data loss|corruption|security)\b/i },
  {
    severity: "high",
    regex: /\b(high severity|regression|crash(?:ed)?|deadlock|broke production)\b/i,
  },
  { severity: "low", regex: /\b(minor|cosmetic|typo|trivial)\b/i },
];

export function deterministicExtract(input: ExtractionInput): MemoryCandidate[] {
  const changedFiles = (input.changedFiles ?? []).filter(Boolean);
  const candidates: MemoryCandidate[] = [];

  for (const sentence of splitSentences(input.summary)) {
    const rule = classify(sentence);
    if (!rule) {
      candidates.push(ignoredCandidate(sentence));
      continue;
    }

    const isIncident = rule.class === "incident";
    let confidence = rule.confidence;
    if (isIncident && /\broot cause\b/i.test(sentence)) confidence = Math.min(1, confidence + 0.1);

    candidates.push({
      class: rule.class,
      content: sentence,
      subject: rule.subject,
      predicate: rule.predicate,
      object: sentence,
      confidence,
      // Incidents and decisions carry the change set so recall can link them to
      // the files they concern (the risk incident signal matches on paths).
      paths: rule.class === "incident" || rule.class === "decision" ? changedFiles : [],
      severity: isIncident ? guessSeverity(sentence) : null,
    });
  }

  return candidates;
}

function classify(sentence: string): Rule | null {
  for (const rule of RULES) {
    if (rule.regex.test(sentence)) return rule;
  }
  return null;
}

function ignoredCandidate(sentence: string): MemoryCandidate {
  return {
    class: "ignored",
    content: sentence,
    subject: "chatter",
    predicate: "ignored",
    object: sentence,
    confidence: 0.2,
    paths: [],
    severity: null,
  };
}

function guessSeverity(sentence: string): IncidentSeverity {
  for (const marker of SEVERITY_MARKERS) {
    if (marker.regex.test(sentence)) return marker.severity;
  }
  return "medium";
}

/** Split into trimmed sentences on terminators and newlines; drop tiny fragments. */
export function splitSentences(summary: string): string[] {
  return summary
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/^[-*•]\s*/, ""))
    .filter((sentence) => sentence.length > 3);
}
