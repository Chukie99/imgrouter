export interface ParsedKey {
  label: string;
  apiKey: string;
  dayLimit?: number;
}

export interface ParseResult {
  entries: ParsedKey[];
  invalid: string[];
}

const GEMINI_KEY_RE = /^AIza[0-9A-Za-z_-]{20,}$/;

function looksLikeKey(token: string): boolean {
  return GEMINI_KEY_RE.test(token) || (token.length >= 30 && !/\s/.test(token));
}

function autoLabel(index: number, apiKey: string): string {
  return `key-${String(index + 1).padStart(3, "0")}-${apiKey.slice(-4)}`;
}

/**
 * Parse a pasted blob of keys, one per line. Accepts:
 *   AIza...                 (key only)
 *   label,AIza...           (label first or key first — auto-detected)
 *   label,AIza...,5         (optional daily limit)
 * Separators: comma, semicolon, tab, pipe, or a single space. Blank lines and
 * lines starting with '#' are ignored.
 */
export function parseKeys(input: string): ParseResult {
  const entries: ParsedKey[] = [];
  const invalid: string[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let parts = line.split(/[,;\t|]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      const spaced = line.split(/\s+/).filter(Boolean);
      if (spaced.length >= 2) parts = spaced;
    }
    if (parts.length === 0) continue;

    let label: string | undefined;
    let apiKey: string | undefined;
    let dayLimit: number | undefined;

    if (parts.length === 1) {
      apiKey = parts[0];
    } else if (parts.length === 2) {
      if (looksLikeKey(parts[0]!) && !looksLikeKey(parts[1]!)) {
        apiKey = parts[0];
        label = parts[1];
      } else {
        label = parts[0];
        apiKey = parts[1];
      }
    } else {
      label = parts[0];
      apiKey = parts[1];
      const parsedLimit = Number(parts[2]);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) dayLimit = Math.floor(parsedLimit);
    }

    if (!apiKey || apiKey.length < 8 || /\s/.test(apiKey)) {
      invalid.push(line);
      continue;
    }
    entries.push({ label: label || autoLabel(entries.length, apiKey), apiKey, dayLimit });
  }

  return { entries, invalid };
}
