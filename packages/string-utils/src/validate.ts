/**
 * String validation utilities
 */

// Pre-compiled regex patterns for performance
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([\/\w .-]*)*\/?$/i;
const NUMERIC_REGEX = /^\d+$/;
const ALPHA_REGEX = /^[a-zA-Z]+$/;
const ALPHANUMERIC_REGEX = /^[a-zA-Z0-9]+$/;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates if a string is a valid email address
 * @param str - Input string to validate
 * @returns true if valid email, false otherwise
 * @example isEmail("test@example.com") // true
 * @example isEmail("invalid-email") // false
 */
export function isEmail(str: string): boolean {
  if (!str) return false;
  return EMAIL_REGEX.test(str.trim());
}

/**
 * Validates if a string is a valid URL
 * @param str - Input string to validate
 * @returns true if valid URL, false otherwise
 * @example isUrl("https://example.com") // true
 * @example isUrl("not-a-url") // false
 */
export function isUrl(str: string): boolean {
  if (!str) return false;
  return URL_REGEX.test(str.trim());
}

/**
 * Validates if a string contains only numeric characters
 * @param str - Input string to validate
 * @returns true if only numeric, false otherwise
 * @example isNumeric("12345") // true
 * @example isNumeric("12a34") // false
 */
export function isNumeric(str: string): boolean {
  if (!str) return false;
  return NUMERIC_REGEX.test(str);
}

/**
 * Validates if a string contains only alphabetic characters
 * @param str - Input string to validate
 * @returns true if only alphabetic, false otherwise
 * @example isAlpha("hello") // true
 * @example isAlpha("hello1") // false
 */
export function isAlpha(str: string): boolean {
  if (!str) return false;
  return ALPHA_REGEX.test(str);
}

/**
 * Validates if a string contains only alphanumeric characters
 * @param str - Input string to validate
 * @returns true if only alphanumeric, false otherwise
 * @example isAlphanumeric("hello123") // true
 * @example isAlphanumeric("hello world") // false
 */
export function isAlphanumeric(str: string): boolean {
  if (!str) return false;
  return ALPHANUMERIC_REGEX.test(str);
}

/**
 * Validates if a string is empty
 * @param str - Input string to validate
 * @returns true if empty string, false otherwise
 * @example isEmpty("") // true
 * @example isEmpty("   ") // false
 * @example isEmpty("hello") // false
 */
export function isEmpty(str: string | null | undefined): boolean {
  return str === null || str === undefined || str.length === 0;
}

/**
 * Validates if a string contains only whitespace
 * @param str - Input string to validate
 * @returns true if only whitespace, false otherwise
 * @example isWhitespace("   ") // true
 * @example isWhitespace("") // true
 * @example isWhitespace("hello") // false
 */
export function isWhitespace(str: string | null | undefined): boolean {
  if (str === null || str === undefined) return true;
  return str.trim().length === 0;
}

/**
 * Validates if a string contains at least one uppercase letter
 * @param str - Input string to validate
 * @returns true if contains uppercase, false otherwise
 * @example hasUppercase("Hello") // true
 * @example hasUppercase("hello") // false
 */
export function hasUppercase(str: string): boolean {
  if (!str) return false;
  return /[A-Z]/.test(str);
}

/**
 * Validates if a string contains at least one lowercase letter
 * @param str - Input string to validate
 * @returns true if contains lowercase, false otherwise
 * @example hasLowercase("Hello") // true
 * @example hasLowercase("HELLO") // false
 */
export function hasLowercase(str: string): boolean {
  if (!str) return false;
  return /[a-z]/.test(str);
}

/**
 * Validates if a string contains at least one number
 * @param str - Input string to validate
 * @returns true if contains number, false otherwise
 * @example hasNumber("Hello123") // true
 * @example hasNumber("Hello") // false
 */
export function hasNumber(str: string): boolean {
  if (!str) return false;
  return /\d/.test(str);
}

/**
 * Validates if a string is a valid URL slug
 * @param str - Input string to validate
 * @returns true if valid slug, false otherwise
 * @example isSlug("hello-world") // true
 * @example isSlug("Hello-World") // false
 * @example isSlug("hello_world") // false
 */
export function isSlug(str: string): boolean {
  if (!str) return false;
  return SLUG_REGEX.test(str.trim());
}