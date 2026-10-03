// Patterns for credentials that must never be written into the repository.
// Placeholders such as <TOKEN>, secret://env/X or "redacted" never match.

export const SECRET_PATTERNS = [
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Atlassian API token", re: /\bATATT3[A-Za-z0-9_=-]{30,}\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI-style API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}={0,2}/ },
  {
    name: "JSON Web Token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/**
 * Finds credential-looking strings in text.
 * @param {string} text
 * @returns {string[]} Names of the patterns that matched (deduplicated).
 */
export function findSecrets(text) {
  if (!text) return [];
  const hits = new Set();
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) hits.add(name);
  }
  return [...hits];
}
