/**
 * Sensitive-content scan. Secrets and personal data must never be auto-saved
 * as durable memory — a matched candidate is forced into the review queue,
 * flagged, so a human decides. This is a conservative detector: false positives
 * (an extra review item) are acceptable; false negatives (a leaked key in
 * committed Markdown) are not.
 */

export type SensitivityResult = {
  sensitive: boolean;
  reasons: string[];
};

const PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "private-key", regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  { label: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "hf-token", regex: /\bhf_[A-Za-z0-9]{16,}\b/ },
  { label: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._-]{12,}\b/ },
  {
    // Catches `password: x`, `api_key = x`, and the prose form `password is x`.
    // Deliberately eager — an over-flagged review item is cheaper than a leak.
    label: "credential-assignment",
    regex:
      /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\b\s*(?:[:=]|\bis\b|\bwas\b|\bequals\b)\s*\S{6,}/i,
  },
  { label: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

export function scanSensitive(text: string): SensitivityResult {
  const reasons: string[] = [];
  for (const { label, regex } of PATTERNS) {
    if (regex.test(text) && !reasons.includes(label)) reasons.push(label);
  }
  return { sensitive: reasons.length > 0, reasons };
}
