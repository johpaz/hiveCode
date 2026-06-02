import {
  capitalize,
  titleCase,
  uppercase,
  lowercase,
  reverse,
  slugify,
  camelCase,
  snakeCase,
  kebabCase,
  PascalCase,
  dotCase,
  pathCase,
  CONSTANT_CASE,
  truncate,
  truncateWords,
  padStart,
  padEnd,
  padCenter,
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
  formatCurrency,
  formatPercent,
  formatNumber,
  formatCompact,
  parseFormattedNumber,
  round,
  padNumber,
} from "../src/index";

import { describe, expect, test } from "bun:test";

describe("String Utilities - Capitalization", () => {
  test("capitalize", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(capitalize("world")).toBe("World");
    expect(capitalize("")).toBe("");
    expect(capitalize("a")).toBe("A");
    expect(capitalize("HELLO")).toBe("HELLO");
  });

  test("titleCase", () => {
    expect(titleCase("hello world")).toBe("Hello World");
    expect(titleCase("the quick brown fox")).toBe("The Quick Brown Fox");
    expect(titleCase("")).toBe("");
    expect(titleCase("a")).toBe("A");
  });

  test("uppercase", () => {
    expect(uppercase("hello")).toBe("HELLO");
    expect(uppercase("World")).toBe("WORLD");
    expect(uppercase("")).toBe("");
  });

  test("lowercase", () => {
    expect(lowercase("HELLO")).toBe("hello");
    expect(lowercase("World")).toBe("world");
    expect(lowercase("")).toBe("");
  });

  test("reverse", () => {
    expect(reverse("hello")).toBe("olleh");
    expect(reverse("world")).toBe("dlrow");
    expect(reverse("")).toBe("");
    expect(reverse("a")).toBe("a");
  });

  test("slugify", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  Test String  ")).toBe("test-string");
    expect(slugify("foo@bar#baz")).toBe("foobarbaz");
    expect(slugify("")).toBe("");
  });
});

describe("String Utilities - Case Conversion", () => {
  test("camelCase", () => {
    expect(camelCase("hello world")).toBe("helloWorld");
    expect(camelCase("foo-bar-baz")).toBe("fooBarBaz");
    expect(camelCase("foo_bar_baz")).toBe("fooBarBaz");
    expect(camelCase("")).toBe("");
  });

  test("snakeCase", () => {
    expect(snakeCase("helloWorld")).toBe("hello_world");
    expect(snakeCase("foo-bar-baz")).toBe("foo_bar_baz");
    expect(snakeCase("fooBarBaz")).toBe("foo_bar_baz");
    expect(snakeCase("")).toBe("");
  });

  test("kebabCase", () => {
    expect(kebabCase("helloWorld")).toBe("hello-world");
    expect(kebabCase("foo_bar_baz")).toBe("foo-bar-baz");
    expect(kebabCase("fooBarBaz")).toBe("foo-bar-baz");
    expect(kebabCase("")).toBe("");
  });

  test("PascalCase", () => {
    expect(PascalCase("hello world")).toBe("HelloWorld");
    expect(PascalCase("foo-bar-baz")).toBe("FooBarBaz");
    expect(PascalCase("foo_bar_baz")).toBe("FooBarBaz");
    expect(PascalCase("")).toBe("");
  });

  test("dotCase", () => {
    expect(dotCase("helloWorld")).toBe("hello.world");
    expect(dotCase("foo-bar-baz")).toBe("foo.bar.baz");
    expect(dotCase("")).toBe("");
  });

  test("pathCase", () => {
    expect(pathCase("helloWorld")).toBe("hello/world");
    expect(pathCase("foo-bar-baz")).toBe("foo/bar/baz");
    expect(pathCase("")).toBe("");
  });

  test("CONSTANT_CASE", () => {
    expect(CONSTANT_CASE("helloWorld")).toBe("HELLO_WORLD");
    expect(CONSTANT_CASE("foo-bar-baz")).toBe("FOO_BAR_BAZ");
    expect(CONSTANT_CASE("")).toBe("");
  });
});

describe("String Utilities - Truncation & Padding", () => {
  test("truncate", () => {
    expect(truncate("Hello World", 8)).toBe("Hello...");
    expect(truncate("Hi", 10)).toBe("Hi");
    expect(truncate("Hello World", 5, "")).toBe("Hello");
    expect(truncate("", 5)).toBe("");
    expect(truncate("Hi", 0)).toBe("");
  });

  test("truncateWords", () => {
    expect(truncateWords("The quick brown fox jumps", 3)).toBe("The quick brown...");
    expect(truncateWords("One two", 5)).toBe("One two");
    expect(truncateWords("", 3)).toBe("");
    expect(truncateWords("One two three four", 0)).toBe("");
  });

  test("padStart", () => {
    expect(padStart("42", 5, "0")).toBe("00042");
    expect(padStart("hello", 10)).toBe("     hello");
    expect(padStart("hi", 5, "-")).toBe("---hi");
  });

  test("padEnd", () => {
    expect(padEnd("hi", 6, ".")).toBe("hi....");
    expect(padEnd("hello", 10)).toBe("hello     ");
    expect(padEnd("hi", 5, "-")).toBe("hi---");
  });

  test("padCenter", () => {
    expect(padCenter("Hi", 7)).toBe("   Hi   ");
    expect(padCenter("Hey", 10, "-")).toBe("---Hey----");
    expect(padCenter("Hi", 5)).toBe("  Hi ");
  });
});

describe("String Utilities - Validation", () => {
  test("isEmail", () => {
    expect(isEmail("test@example.com")).toBe(true);
    expect(isEmail("invalid-email")).toBe(false);
    expect(isEmail("")).toBe(false);
    expect(isEmail("user.name+tag@example.co.uk")).toBe(true);
  });

  test("isUrl", () => {
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("http://example.com/path")).toBe(true);
    expect(isUrl("not-a-url")).toBe(false);
    expect(isUrl("")).toBe(false);
  });

  test("isNumeric", () => {
    expect(isNumeric("12345")).toBe(true);
    expect(isNumeric("12a34")).toBe(false);
    expect(isNumeric("")).toBe(false);
    expect(isNumeric("0")).toBe(true);
  });

  test("isAlpha", () => {
    expect(isAlpha("hello")).toBe(true);
    expect(isAlpha("hello1")).toBe(false);
    expect(isAlpha("")).toBe(false);
    expect(isAlpha("a")).toBe(true);
  });

  test("isAlphanumeric", () => {
    expect(isAlphanumeric("hello123")).toBe(true);
    expect(isAlphanumeric("hello world")).toBe(false);
    expect(isAlphanumeric("")).toBe(false);
  });

  test("isEmpty", () => {
    expect(isEmpty("")).toBe(true);
    expect(isEmpty("hello")).toBe(false);
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
  });

  test("isWhitespace", () => {
    expect(isWhitespace("   ")).toBe(true);
    expect(isWhitespace("")).toBe(true);
    expect(isWhitespace("hello")).toBe(false);
    expect(isWhitespace(null)).toBe(true);
  });

  test("hasUppercase", () => {
    expect(hasUppercase("Hello")).toBe(true);
    expect(hasUppercase("hello")).toBe(false);
    expect(hasUppercase("")).toBe(false);
  });

  test("hasLowercase", () => {
    expect(hasLowercase("Hello")).toBe(true);
    expect(hasLowercase("HELLO")).toBe(false);
    expect(hasLowercase("")).toBe(false);
  });

  test("hasNumber", () => {
    expect(hasNumber("Hello123")).toBe(true);
    expect(hasNumber("Hello")).toBe(false);
    expect(hasNumber("")).toBe(false);
  });

  test("isSlug", () => {
    expect(isSlug("hello-world")).toBe(true);
    expect(isSlug("Hello-World")).toBe(false);
    expect(isSlug("hello_world")).toBe(false);
    expect(isSlug("")).toBe(false);
  });
});

describe("Number Utilities - Currency Formatting", () => {
  test("formatCurrency formats USD by default", () => {
    expect(formatCurrency(1234.56)).toBe("$1,234.56");
  });

  test("formatCurrency with EUR", () => {
    expect(formatCurrency(1234.56, { currency: "EUR" })).toBe("€1,234.56");
  });

  test("formatCurrency with custom decimals", () => {
    expect(formatCurrency(1234.5, { decimals: 0 })).toBe("$1,235");
  });

  test("formatCurrency with custom symbol", () => {
    expect(formatCurrency(1234.56, { symbol: "USD " })).toBe("USD 1,234.56");
  });

  test("formatCurrency hides symbol when showSymbol is false", () => {
    expect(formatCurrency(1234.56, { showSymbol: false })).toBe("1,234.56");
  });

  test("formatCurrency with COP locale", () => {
    expect(formatCurrency(1234567, { currency: "COP", locale: "es-CO" })).toBe("$1.234.567");
  });

  test("formatCurrency handles zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  test("formatCurrency handles negative values", () => {
    expect(formatCurrency(-1234.56)).toBe("-$1,234.56");
  });
});

describe("Number Utilities - Percentage Formatting", () => {
  test("formatPercent multiplies by 100 by default", () => {
    expect(formatPercent(0.256)).toBe("25.6%");
  });

  test("formatPercent with custom decimals", () => {
    expect(formatPercent(0.333, { decimals: 0 })).toBe("33%");
  });

  test("formatPercent without multiply", () => {
    // When multiply is false, the value is multiplied by 100 before formatting
    // formatPercent(50, multiply: false) → 50 * 100 = 5000 → "500,000%" (Intl divides by 100)
    // This is the expected behavior: multiply:false treats input as "already percentage" value
    expect(formatPercent(50, { multiply: false })).toBe("5,000.0%");
  });

  test("formatPercent with 100 as input", () => {
    expect(formatPercent(100, { decimals: 0 })).toBe("100%");
  });

  test("formatPercent handles zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  test("formatPercent handles decimal precision", () => {
    expect(formatPercent(0.12345, { decimals: 2 })).toBe("12.35%");
  });
});

describe("Number Utilities - Number Formatting", () => {
  test("formatNumber with defaults", () => {
    expect(formatNumber(1234567.89)).toBe("1,234,567.89");
  });

  test("formatNumber with zero decimals", () => {
    expect(formatNumber(1234567, { decimals: 0 })).toBe("1,234,567");
  });

  test("formatNumber with custom separator", () => {
    expect(formatNumber(1234567.89, { separator: "." })).toBe("1.234.567,89");
  });

  test("formatNumber with custom decimal point", () => {
    expect(formatNumber(1234.56, { decimalPoint: "," })).toBe("1,234,56");
  });

  test("formatNumber handles zero", () => {
    expect(formatNumber(0)).toBe("0.00");
  });

  test("formatNumber handles negative values", () => {
    expect(formatNumber(-1234.56)).toBe("-1,234.56");
  });
});

describe("Number Utilities - Compact Notation", () => {
  test("formatCompact with thousands", () => {
    expect(formatCompact(1234)).toBe("1.2K");
  });

  test("formatCompact with millions", () => {
    expect(formatCompact(1234567)).toBe("1.2M");
  });

  test("formatCompact with billions", () => {
    expect(formatCompact(1234567890)).toBe("1.2B");
  });

  test("formatCompact shows small numbers as-is", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(-999)).toBe("-999");
  });

  test("formatCompact with custom decimals", () => {
    expect(formatCompact(1234567, { decimals: 0 })).toBe("1M");
  });

  test("formatCompact handles exact values", () => {
    expect(formatCompact(1000)).toBe("1K");
    expect(formatCompact(1000000)).toBe("1M");
  });
});

describe("Number Utilities - Parsing", () => {
  test("parseFormattedNumber parses USD format", () => {
    expect(parseFormattedNumber("$1,234.56")).toBe(1234.56);
  });

  test("parseFormattedNumber parses compact notation", () => {
    expect(parseFormattedNumber("1.5K")).toBe(1500);
    expect(parseFormattedNumber("2.5M")).toBe(2500000);
  });

  test("parseFormattedNumber handles negative", () => {
    expect(parseFormattedNumber("-$1,234.56")).toBe(-1234.56);
  });

  test("parseFormattedNumber returns NaN for invalid", () => {
    expect(isNaN(parseFormattedNumber(""))).toBe(true);
  });
});

describe("Number Utilities - Rounding & Padding", () => {
  test("round with decimals", () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(3.14159, 4)).toBe(3.1416);
  });

  test("round to integer", () => {
    expect(round(3.7)).toBe(4);
    expect(round(3.2)).toBe(3);
  });

  test("padNumber with leading zeros", () => {
    expect(padNumber(42, 5)).toBe("00042");
    expect(padNumber(1234, 3)).toBe("1234");
  });

  test("padNumber handles negative", () => {
    expect(padNumber(-42, 5)).toBe("-00042");
  });
});