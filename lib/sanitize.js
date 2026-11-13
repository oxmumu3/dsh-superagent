// S6 C: the one place that redacts obviously secret-looking text before it is
// stored in the ledger. S5 may bring its own version; this file is deliberately
// small so the final integration can swap it without touching the vent logic.

const RULES = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
]

export function sanitizeText(value) {
  let text = String(value ?? '')
  for (const pattern of RULES) text = text.replace(pattern, '***')
  return text
}
