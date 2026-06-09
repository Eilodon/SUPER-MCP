import type { ToolResult } from "../core/registrar.js";

const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GITHUB_TOKEN", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { label: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
];

const PROMPT_INJECTION_MARKERS: RegExp[] = [
  /ignore (all )?(previous|prior) instructions/gi,
  /reveal (the )?(system|developer) (prompt|message)/gi,
  /BEGIN SYSTEM PROMPT/gi,
  /do not tell (the )?user/gi,
];

export interface OutputFirewallResult {
  result: ToolResult;
  violations: string[];
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function redactCardNumbers(text: string, violations: Set<string>): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, match => {
    if (!luhnValid(match)) return match;
    violations.add("PAYMENT_CARD");
    return "[REDACTED:PAYMENT_CARD]";
  });
}

function redactPromptInjectionMarkers(text: string, violations: Set<string>): string {
  let redacted = text;
  for (const pattern of PROMPT_INJECTION_MARKERS) {
    redacted = redacted.replace(pattern, match => {
      violations.add("PROMPT_INJECTION_MARKER");
      return `[REDACTED:PROMPT_INJECTION_MARKER:${match.length}]`;
    });
  }
  return redacted;
}

function redactSensitiveText(text: string, violations: Set<string>): string {
  let redacted = redactCardNumbers(text, violations);
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      violations.add(label);
      return `[REDACTED:${label}]`;
    });
  }
  return redactPromptInjectionMarkers(redacted, violations);
}

export function scanToolOutput(result: ToolResult): OutputFirewallResult {
  const violations = new Set<string>();
  const content = result.content.map(item => {
    if (item.type !== "text") return item;
    return { ...item, text: redactSensitiveText(item.text, violations) };
  });

  return {
    result: { content },
    violations: [...violations].sort(),
  };
}
