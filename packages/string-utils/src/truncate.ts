/**
 * Truncation and padding utilities
 */

const DEFAULT_TRUNCATE_SUFFIX = "...";

/**
 * Truncates a string to a maximum length, adding a suffix if truncated
 * @param str - Input string
 * @param maxLen - Maximum length of the output string (including suffix)
 * @param suffix - Suffix to add when truncated (default: "...")
 * @returns Truncated string
 * @example truncate("Hello World", 8) // "Hello..."
 * @example truncate("Hi", 10) // "Hi"
 */
export function truncate(
  str: string,
  maxLen: number,
  suffix: string = DEFAULT_TRUNCATE_SUFFIX
): string {
  if (!str || maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  
  const availableLength = maxLen - suffix.length;
  if (availableLength <= 0) return suffix.slice(0, maxLen);
  
  return str.slice(0, availableLength) + suffix;
}

/**
 * Truncates a string to a maximum number of words
 * @param str - Input string
 * @param maxWords - Maximum number of words
 * @param suffix - Suffix to add when truncated (default: "...")
 * @returns Truncated string
 * @example truncateWords("The quick brown fox jumps", 3) // "The quick brown..."
 * @example truncateWords("One two", 5) // "One two"
 */
export function truncateWords(
  str: string,
  maxWords: number,
  suffix: string = DEFAULT_TRUNCATE_SUFFIX
): string {
  if (!str || maxWords <= 0) return "";
  
  const words = str.trim().split(/\s+/);
  if (words.length <= maxWords) return str;
  
  return words.slice(0, maxWords).join(" ") + suffix;
}

/**
 * Pads a string on the left to a specified length
 * @param str - Input string
 * @param length - Target length
 * @param char - Character to pad with (default: " ")
 * @returns Padded string
 * @example padStart("42", 5, "0") // "00042"
 * @example padStart("hello", 10) // "     hello"
 */
export function padStart(
  str: string,
  length: number,
  char: string = " "
): string {
  if (!str) str = "";
  return str.padStart(length, char);
}

/**
 * Pads a string on the right to a specified length
 * @param str - Input string
 * @param length - Target length
 * @param char - Character to pad with (default: " ")
 * @returns Padded string
 * @example padEnd("hi", 6, ".") // "hi...."
 * @example padEnd("hello", 10) // "hello     "
 */
export function padEnd(
  str: string,
  length: number,
  char: string = " "
): string {
  if (!str) str = "";
  return str.padEnd(length, char);
}

/**
 * Pads a string on both sides to center it
 * @param str - Input string
 * @param length - Target length
 * @param char - Character to pad with (default: " ")
 * @returns Centered string
 * @example padCenter("Hi", 7) // "   Hi   "
 * @example padCenter("Hey", 10, "-") // "---Hey----"
 */
export function padCenter(
  str: string,
  length: number,
  char: string = " "
): string {
  if (!str) str = "";
  const totalPadding = length - str.length;
  if (totalPadding <= 0) return str;
  
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  
  return char.repeat(leftPadding) + str + char.repeat(rightPadding);
}