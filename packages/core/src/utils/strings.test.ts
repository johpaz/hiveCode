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
  camelToSnake,
  snakeToCamel,
  kebabToCamel,
  trimLines,
  wordCount,
  randomString,
  padStart,
  padEnd,
  formatNumber,
  formatCurrency,
  formatPercent,
} from "./strings.ts";
import { describe, test, expect } from "bun:test";

describe("capitalize", () => {
  test("capitalizes first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(capitalize("hello world")).toBe("Hello world");
  });

  test("handles empty string", () => {
    expect(capitalize("")).toBe("");
  });

  test("handles single character", () => {
    expect(capitalize("a")).toBe("A");
  });
});

describe("slugify", () => {
  test("converts to lowercase slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("removes special characters", () => {
    expect(slugify("Hello! World?")).toBe("hello-world");
  });

  test("handles accents", () => {
    expect(slugify("café")).toBe("cafe");
  });

  test("handles multiple spaces", () => {
    expect(slugify("hello   world")).toBe("hello-world");
  });
});

describe("truncate", () => {
  test("truncates string with suffix", () => {
    expect(truncate("Hello World", 8, "...")).toBe("Hello...");
  });

  test("returns original if shorter than max", () => {
    expect(truncate("Hi", 10)).toBe("Hi");
  });

  test("uses default suffix", () => {
    expect(truncate("Hello World", 8)).toBe("Hello...");
  });

  test("handles exact length", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });
});

describe("camelCase", () => {
  test("converts snake_case to camelCase", () => {
    expect(camelCase("hello_world")).toBe("helloWorld");
  });

  test("converts kebab-case to camelCase", () => {
    expect(camelCase("hello-world")).toBe("helloWorld");
  });

  test("handles multiple underscores", () => {
    expect(camelCase("hello_world_test")).toBe("helloWorldTest");
  });
});

describe("snakeCase", () => {
  test("converts camelCase to snake_case", () => {
    expect(snakeCase("helloWorld")).toBe("hello_world");
  });

  test("converts kebab-case to snake_case", () => {
    expect(snakeCase("hello-world")).toBe("hello_world");
  });
});

describe("kebabCase", () => {
  test("converts camelCase to kebab-case", () => {
    expect(kebabCase("helloWorld")).toBe("hello-world");
  });

  test("converts snake_case to kebab-case", () => {
    expect(kebabCase("hello_world")).toBe("hello-world");
  });
});

describe("removeAccents", () => {
  test("removes accent marks", () => {
    expect(removeAccents("café")).toBe("cafe");
    expect(removeAccents("naïve")).toBe("naive");
  });

  test("handles string without accents", () => {
    expect(removeAccents("hello")).toBe("hello");
  });
});

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

describe("stripHtml", () => {
  test("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>World</b></p>")).toBe("Hello World");
  });

  test("handles string without tags", () => {
    expect(stripHtml("Hello World")).toBe("Hello World");
  });
});

describe("camelToSnake", () => {
  test("converts camelCase to snake_case", () => {
    expect(camelToSnake("helloWorld")).toBe("hello_world");
  });

  test("handles multiple caps", () => {
    expect(camelToSnake("helloWorldAgain")).toBe("hello_world_again");
  });
});

describe("snakeToCamel", () => {
  test("converts snake_case to camelCase", () => {
    expect(snakeToCamel("hello_world")).toBe("helloWorld");
  });
});

describe("kebabToCamel", () => {
  test("converts kebab-case to camelCase", () => {
    expect(kebabToCamel("hello-world")).toBe("helloWorld");
  });
});

describe("trimLines", () => {
  test("trims each line", () => {
    expect(trimLines("  hello  \n  world  ")).toBe("hello\nworld");
  });

  test("handles single line", () => {
    expect(trimLines("  hello  ")).toBe("hello");
  });
});

describe("wordCount", () => {
  test("counts words correctly", () => {
    expect(wordCount("Hello world!")).toBe(2);
    expect(wordCount("one two three four")).toBe(4);
  });

  test("handles empty string", () => {
    expect(wordCount("")).toBe(0);
  });

  test("handles whitespace only", () => {
    expect(wordCount("   ")).toBe(0);
  });
});

describe("randomString", () => {
  test("generates string of correct length", () => {
    expect(randomString(16).length).toBe(16);
    expect(randomString(32).length).toBe(32);
  });

  test("generates different strings", () => {
    const s1 = randomString(16);
    const s2 = randomString(16);
    expect(s1).not.toBe(s2);
  });
});

describe("padStart", () => {
  test("pads string with default space", () => {
    expect(padStart("42", 5)).toBe("   42");
  });

  test("pads string with custom character", () => {
    expect(padStart("42", 5, "0")).toBe("00042");
  });
});

describe("padEnd", () => {
  test("pads string with default space", () => {
    expect(padEnd("Hi", 5)).toBe("Hi   ");
  });

  test("pads string with custom character", () => {
    expect(padEnd("Hi", 5, ".")).toBe("Hi...");
  });
});

describe("formatNumber", () => {
  test("formats number with thousands separator", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

describe("formatCurrency", () => {
  test("formats as USD by default", () => {
    expect(formatCurrency(1234.56)).toContain("1,234.56");
  });
});

describe("formatPercent", () => {
  test("formats as percentage", () => {
    expect(formatPercent(0.1234)).toBe("12.34%");
  });
});