import { describe, test, expect } from "bun:test";
import {
  capitalize,
  slugify,
  truncate,
  camelCase,
  snakeCase,
  kebabCase,
  removeAccents,
  isEmpty,
  stripHtml,
} from "../../packages/core/src/utils/strings.ts";

// ─── capitalize ─────────────────────────────────────────────────────────────

describe("capitalize", () => {
  test("capitalizes first letter", () => {
    expect(capitalize("hello world")).toBe("Hello world");
  });

  test("handles empty string", () => {
    expect(capitalize("")).toBe("");
  });

  test("handles already capitalized string", () => {
    expect(capitalize("HELLO")).toBe("HELLO");
  });

  test("handles single character", () => {
    expect(capitalize("a")).toBe("A");
  });
});

// ─── slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("converts to lowercase slug", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });

  test("removes accents", () => {
    expect(slugify("café crème")).toBe("cafe-creme");
  });

  test("collapses multiple spaces", () => {
    expect(slugify("  multiple   spaces  ")).toBe("multiple-spaces");
  });

  test("removes special characters", () => {
    expect(slugify("Hello@#$%World")).toBe("helloworld");
  });
});

// ─── truncate ────────────────────────────────────────────────────────────────

describe("truncate", () => {
  test("truncates with suffix", () => {
    expect(truncate("Hello World", 8, "...")).toBe("Hello...");
  });

  test("returns original when shorter than maxLen", () => {
    expect(truncate("Hello", 10)).toBe("Hello");
  });

  test("handles exact length", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });

  test("uses default suffix '...'", () => {
    expect(truncate("Hello World", 8)).toBe("Hello...");
  });

  test("handles edge case where maxLen equals suffix length", () => {
    expect(truncate("Hello World", 3, "...")).toBe("...");
  });
});

// ─── camelCase ───────────────────────────────────────────────────────────────

describe("camelCase", () => {
  test("converts snake_case", () => {
    expect(camelCase("hello_world")).toBe("helloWorld");
  });

  test("converts kebab-case", () => {
    expect(camelCase("hello-world")).toBe("helloWorld");
  });

  test("converts space-separated", () => {
    expect(camelCase("Hello World")).toBe("helloWorld");
  });

  test("handles already camelCase", () => {
    expect(camelCase("helloWorld")).toBe("helloWorld");
  });
});

// ─── snakeCase ───────────────────────────────────────────────────────────────

describe("snakeCase", () => {
  test("converts camelCase", () => {
    expect(snakeCase("HelloWorld")).toBe("hello_world");
  });

  test("converts kebab-case", () => {
    expect(snakeCase("hello-world")).toBe("hello_world");
  });

  test("converts space-separated", () => {
    expect(snakeCase("Hello World")).toBe("hello_world");
  });

  test("handles already snake_case", () => {
    expect(snakeCase("hello_world")).toBe("hello_world");
  });
});

// ─── kebabCase ───────────────────────────────────────────────────────────────

describe("kebabCase", () => {
  test("converts camelCase", () => {
    expect(kebabCase("HelloWorld")).toBe("hello-world");
  });

  test("converts snake_case", () => {
    expect(kebabCase("hello_world")).toBe("hello-world");
  });

  test("converts space-separated", () => {
    expect(kebabCase("Hello World")).toBe("hello-world");
  });

  test("handles already kebab-case", () => {
    expect(kebabCase("hello-world")).toBe("hello-world");
  });
});

// ─── removeAccents ───────────────────────────────────────────────────────────

describe("removeAccents", () => {
  test("removes acute accents", () => {
    expect(removeAccents("café")).toBe("cafe");
  });

  test("removes diaeresis", () => {
    expect(removeAccents("naïve")).toBe("naive");
  });

  test("removes tilde", () => {
    expect(removeAccents("ñoño")).toBe("nono");
  });

  test("handles string without accents", () => {
    expect(removeAccents("hello")).toBe("hello");
  });
});

// ─── isEmpty ─────────────────────────────────────────────────────────────────

describe("isEmpty", () => {
  test("returns true for empty string", () => {
    expect(isEmpty("")).toBe(true);
  });

  test("returns true for null", () => {
    expect(isEmpty(null)).toBe(true);
  });

  test("returns true for undefined", () => {
    expect(isEmpty(undefined)).toBe(true);
  });

  test("returns false for whitespace", () => {
    expect(isEmpty("  ")).toBe(false);
  });

  test("returns false for non-empty string", () => {
    expect(isEmpty("hello")).toBe(false);
  });
});

// ─── stripHtml ───────────────────────────────────────────────────────────────

describe("stripHtml", () => {
  test("removes basic HTML tags", () => {
    expect(stripHtml("<p>Hello <b>World</b></p>")).toBe("Hello World");
  });

  test("removes script tags but keeps content", () => {
    expect(stripHtml("<script>alert('xss')</script>")).toBe("alert('xss')");
  });

  test("handles string without tags", () => {
    expect(stripHtml("No tags")).toBe("No tags");
  });

  test("removes nested tags", () => {
    expect(stripHtml("<div><span><p>text</p></span></div>")).toBe("text");
  });
});
