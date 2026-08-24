/**
 * Sensitive-content scan. Secrets and personal data must never be auto-saved
 * as durable memory — a matched candidate is forced into the review queue,
 * flagged, so a human decides. This is a conservative detector: false positives
 * (an extra review item) are acceptable; false negatives (a leaked key in
 * committed Markdown) are not.
 *
 * The scan only ever *routes to review* — it never blocks a turn, deletes
 * content, or rejects on its own. Adding a reason at most moves a candidate from
 * "auto-save" to "human decides".
 */

export type SensitivityResult = {
  sensitive: boolean;
  reasons: string[];
};

const PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "private-key", regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  { label: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "hf-token", regex: /\bhf_[A-Za-z0-9]{16,}\b/ },
  { label: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  // GitHub fine-grained personal access tokens.
  {
    label: "github-fine-grained-pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}_[A-Za-z0-9]{22,255}\b/,
  },
  { label: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._-]{12,}\b/ },
  // Vendor API keys with distinctive, low-false-positive prefixes.
  { label: "openai-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "stripe-key", regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // A JWT: three base64url segments. Common in auth-related pastes.
  { label: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // Credentials embedded in a connection URL: scheme://user:password@host.
  {
    label: "connection-string-credentials",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i,
  },
  {
    // Catches `password: x`, `api_key = x`, and the prose form `password is x`.
    // Deliberately eager — an over-flagged review item is cheaper than a leak.
    label: "credential-assignment",
    regex:
      /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|authorization|auth[_-]?token|credential[s]?)\b\s*(?:[:=]|\bis\b|\bwas\b|\bequals\b)\s*\S{6,}/i,
  },
  // HTTP Basic-auth style inline credentials outside a URL scheme
  // (`Authorization: Basic dXNlcjpwYXNz`).
  {
    label: "basic-auth-header",
    regex: /\bAuthorization\s*[:=]\s*Basic\s+[A-Za-z0-9+/=]{8,}/i,
  },
  { label: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

/**
 * Deterministic, review-oriented high-entropy heuristic. Flags a token that
 * looks like a random secret — long, mixed character classes, high Shannon
 * entropy — that the prefix-based patterns above wouldn't catch. Tuned to stay
 * quiet on ordinary code and prose: identifiers are usually low-entropy words
 * (`camelCase`, `snake_case`), and hex hashes / SHAs lack the required mix of
 * upper, lower, and digit. Never a hard block; at most one extra review item.
 */
export function hasHighEntropyToken(text: string): boolean {
  for (const token of text.split(/[^A-Za-z0-9+/_=-]+/)) {
    if (token.length < 24 || token.length > 200) continue;
    if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (shannonEntropy(token) >= 3.5) return true;
  }
  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function scanSensitive(text: string): SensitivityResult {
  const reasons: string[] = [];
  for (const { label, regex } of PATTERNS) {
    if (regex.test(text) && !reasons.includes(label)) reasons.push(label);
  }
  if (hasHighEntropyToken(text)) reasons.push("high-entropy-string");
  return { sensitive: reasons.length > 0, reasons };
}
