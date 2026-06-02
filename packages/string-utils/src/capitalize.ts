/**
 * Capitalization utilities
 */

/**
 * Capitalizes the first letter of a string
 * @param str - Input string
 * @returns String with first letter capitalized
 * @example capitalize("hello") // "Hello"
 * @example capitalize("world") // "World"
 */
export function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Converts a string to Title Case
 * @param str - Input string
 * @returns String in Title Case
 * @example titleCase("hello world") // "Hello World"
 * @example titleCase("the quick brown fox") // "The Quick Brown Fox"
 */
export function titleCase(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => capitalize(word))
    .join(" ");
}

/**
 * Converts a string to uppercase
 * @param str - Input string
 * @returns String in uppercase
 * @example uppercase("Hello") // "HELLO"
 */
export function uppercase(str: string): string {
  return str.toUpperCase();
}

/**
 * Converts a string to lowercase
 * @param str - Input string
 * @returns String in lowercase
 * @example lowercase("HELLO") // "hello"
 */
export function lowercase(str: string): string {
  return str.toLowerCase();
}

/**
 * Reverses a string
 * @param str - Input string
 * @returns Reversed string
 * @example reverse("hello") // "olleh"
 */
export function reverse(str: string): string {
  return str.split("").reverse().join("");
}

/**
 * Converts a string to a URL-safe slug
 * @param str - Input string
 * @returns URL-safe slug
 * @example slugify("Hello World!") // "hello-world"
 * @example slugify("  Test String  ") // "test-string"
 */
export function slugify(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove non-word chars except spaces and hyphens
    .replace(/[\s_-]+/g, "-") // Replace spaces, underscores, and multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens
}