/**
 * String manipulation utilities
 * Common functions for string formatting, conversion, and sanitization
 */

// ─── Capitalize ─────────────────────────────────────────────────────────────

/**
 * Capitalize the first letter of a string
 * @example capitalize("hello world") → "Hello world"
 */
export function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Slugify ─────────────────────────────────────────────────────────────────

/**
 * Convert string to URL-safe slug
 * @example slugify("Hello World!") → "hello-world"
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ─── Truncate ────────────────────────────────────────────────────────────────

/**
 * Truncate string to max length with optional suffix
 * @example truncate("Hello World", 8, "...") → "Hello..."
 */
export function truncate(str: string, maxLen: number, suffix = "..."): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - suffix.length) + suffix;
}

// ─── camelCase ────────────────────────────────────────────────────────────────

/**
 * Convert string to camelCase
 * @example camelCase("hello_world") → "helloWorld"
 */
export function camelCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^(.)/, (c) => c.toLowerCase());
}

// ─── snakeCase ───────────────────────────────────────────────────────────────

/**
 * Convert string to snake_case
 * @example snakeCase("HelloWorld") → "hello_world"
 */
export function snakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

// ─── kebabCase ───────────────────────────────────────────────────────────────

/**
 * Convert string to kebab-case
 * @example kebabCase("hello_world") → "hello-world"
 */
export function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

// ─── removeAccents ───────────────────────────────────────────────────────────

/**
 * Remove accent marks from string
 * @example removeAccents("café") → "cafe"
 */
export function removeAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ─── isEmpty ─────────────────────────────────────────────────────────────────

/**
 * Check if string is empty, null, or undefined
 * @example isEmpty("") → true
 * @example isEmpty(null) → true
 * @example isEmpty("  ") → false (whitespace is not empty)
 */
export function isEmpty(str: string | null | undefined): boolean {
  return str === null || str === undefined || str === "";
}

// ─── stripHtml ───────────────────────────────────────────────────────────────

/**
 * Remove HTML tags from string
 * @example stripHtml("<p>Hello <b>World</b></p>") → "Hello World"
 */
export function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, "");
}

// ─── camelToSnake ────────────────────────────────────────────────────────────

/**
 * Convert camelCase string to snake_case
 * @example camelToSnake("helloWorld") → "hello_world"
 */
export function camelToSnake(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

// ─── snakeToCamel ────────────────────────────────────────────────────────────

/**
 * Convert snake_case string to camelCase
 * @example snakeToCamel("hello_world") → "helloWorld"
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_+(.)/g, (_, c) => c.toUpperCase());
}

// ─── kebabToCamel ────────────────────────────────────────────────────────────

/**
 * Convert kebab-case string to camelCase
 * @example kebabToCamel("hello-world") → "helloWorld"
 */
export function kebabToCamel(str: string): string {
  return str.replace(/-+(.)/g, (_, c) => c.toUpperCase());
}

// ─── trimLines ───────────────────────────────────────────────────────────────

/**
 * Remove leading/trailing whitespace from each line
 * @example trimLines("  hello  \n  world  ") → "hello\nworld"
 */
export function trimLines(str: string): string {
  return str
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

// ─── wordCount ───────────────────────────────────────────────────────────────

/**
 * Count words in a string
 * @example wordCount("Hello world!") → 2
 */
export function wordCount(str: string): number {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// ─── randomString ────────────────────────────────────────────────────────────

/**
 * Generate random string of specified length
 * @example randomString(16) → "aZ3xK9mP2qLnR7yT"
 */
export function randomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ─── padStart ─────────────────────────────────────────────────────────────────

/**
 * Pad string on the left to reach target length
 * @example padStart("42", 5, "0") → "00042"
 */
export function padStart(str: string, len: number, char = " "): string {
  return str.padStart(len, char);
}

// ─── padEnd ──────────────────────────────────────────────────────────────────

/**
 * Pad string on the right to reach target length
 * @example padEnd("Hi", 5, ".") → "Hi..."
 */
export function padEnd(str: string, len: number, char = " "): string {
  return str.padEnd(len, char);
}

// ─── Number Formatting ───────────────────────────────────────────────────────

/**
 * Format number with locale-aware thousands separator
 * @example formatNumber(1234567) → "1,234,567"
 * @example formatNumber(1234567.89, 'de-DE') → "1.234.567,89"
 */
export function formatNumber(num: number, locale = "en"): string {
  return new Intl.NumberFormat(locale).format(num);
}

/**
 * Format number as currency with locale-aware symbol and separators
 * @example formatCurrency(1234.56) → "$1,234.56"
 * @example formatCurrency(1234.56, 'EUR', 'de-DE') → "1.234,56 €"
 */
export function formatCurrency(
  num: number,
  currency = "USD",
  locale = "en"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(num);
}

/**
 * Format number as percentage with locale-aware separators
 * @example formatPercent(0.1234) → "12.34%"
 * @example formatPercent(0.5, 0) → "50%"
 */
export function formatPercent(
  num: number,
  decimals = 2,
  locale = "en"
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}