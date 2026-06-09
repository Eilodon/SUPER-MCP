const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeJsonValue(item));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sanitized: Record<string, unknown> = Object.create(null);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_JSON_KEYS.has(key)) continue;
    sanitized[key] = sanitizeJsonValue(nested);
  }
  return sanitized;
}
