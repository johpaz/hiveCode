/**
 * String and Number manipulation utilities for hivecode
 *
 * Provides common transformation functions:
 * - String Capitalization (capitalize, titleCase, uppercase, lowercase)
 * - String Case conversion (camelCase, snake_case, kebab-case, PascalCase)
 * - String Truncation (truncate, truncateWords)
 * - String Validation (isEmail, isUrl, isNumeric, isAlpha, isAlphanumeric)
 * - Number Formatting (formatCurrency, formatPercent, formatNumber, formatCompact)
 */

// Re-export all utilities
export {
  capitalize,
  titleCase,
  uppercase,
  lowercase,
  reverse,
  slugify,
} from "./capitalize";

export {
  camelCase,
  snakeCase,
  kebabCase,
  PascalCase,
  dotCase,
  pathCase,
  CONSTANT_CASE,
} from "./casing";

export {
  truncate,
  truncateWords,
  padStart,
  padEnd,
  padCenter,
} from "./truncate";

export {
  isEmail,
  isUrl,
  isNumeric,
  isAlpha,
  isAlphanumeric,
  isEmpty,
  isWhitespace,
  hasUppercase,
  hasLowercase,
  hasNumber,
  isSlug,
} from "./validate";

export {
  formatCurrency,
  formatPercent,
  formatNumber,
  formatCompact,
  parseFormattedNumber,
  round,
  padNumber,
  format,
  type CurrencyOptions,
  type PercentOptions,
  type NumberOptions,
} from "./format";

// Type definitions
export interface StringUtils {
  capitalize(str: string): string;
  camelCase(str: string): string;
  snakeCase(str: string): string;
  kebabCase(str: string): string;
  truncate(str: string, maxLen: number, suffix?: string): string;
  isEmail(str: string): boolean;
  isUrl(str: string): boolean;
}

// Export all functions as a single object for convenience
import * as capitalize from "./capitalize";
import * as casing from "./casing";
import * as truncate from "./truncate";
import * as validate from "./validate";
import * as format from "./format";

export const stringUtils = {
  ...capitalize,
  ...casing,
  ...truncate,
  ...validate,
  ...format,
};