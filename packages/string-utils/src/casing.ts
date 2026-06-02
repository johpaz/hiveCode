/**
 * Case conversion utilities
 */

/**
 * Converts a string to camelCase
 * @param str - Input string
 * @returns String in camelCase
 * @example camelCase("hello world") // "helloWorld"
 * @example camelCase("foo-bar-baz") // "fooBarBaz"
 */
export function camelCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/[-_\s]+(.)?/g, (_, char) => (char ? char.toUpperCase() : ""))
    .replace(/^(.)/, (char) => char.toLowerCase());
}

/**
 * Converts a string to snake_case
 * @param str - Input string
 * @returns String in snake_case
 * @example snakeCase("helloWorld") // "hello_world"
 * @example snakeCase("foo-bar-baz") // "foo_bar_baz"
 */
export function snakeCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Converts a string to kebab-case
 * @param str - Input string
 * @returns String in kebab-case
 * @example kebabCase("helloWorld") // "hello-world"
 * @example kebabCase("foo_bar_baz") // "foo-bar-baz"
 */
export function kebabCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/**
 * Converts a string to PascalCase
 * @param str - Input string
 * @returns String in PascalCase
 * @example PascalCase("hello world") // "HelloWorld"
 * @example PascalCase("foo-bar-baz") // "FooBarBaz"
 */
export function PascalCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/[-_\s]+(.)?/g, (_, char) => (char ? char.toUpperCase() : ""))
    .replace(/^(.)/, (char) => char.toUpperCase());
}

/**
 * Alias for PascalCase
 */
export { PascalCase as pascalCase };

/**
 * Converts a string to dot.case
 * @param str - Input string
 * @returns String in dot.case
 * @example dotCase("helloWorld") // "hello.world"
 * @example dotCase("foo-bar-baz") // "foo.bar.baz"
 */
export function dotCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/([a-z])([A-Z])/g, "$1.$2")
    .replace(/[-_\s]+/g, ".")
    .toLowerCase()
    .replace(/^\.|\.$/g, "");
}

/**
 * Converts a string to path/case
 * @param str - Input string
 * @returns String in path/case
 * @example pathCase("helloWorld") // "hello/world"
 * @example pathCase("foo-bar-baz") // "foo/bar/baz"
 */
export function pathCase(str: string): string {
  if (!str) return "";
  return str
    .replace(/([a-z])([A-Z])/g, "$1/$2")
    .replace(/[-_\s]+/g, "/")
    .toLowerCase()
    .replace(/^\/|\/$/g, "");
}

/**
 * Converts a string to CONSTANT_CASE
 * @param str - Input string
 * @returns String in CONSTANT_CASE
 * @example CONSTANT_CASE("helloWorld") // "HELLO_WORLD"
 * @example CONSTANT_CASE("foo-bar-baz") // "FOO_BAR_BAZ"
 */
export const CONSTANT_CASE = (() => {
  const fn = (str: string): string => {
    if (!str) return "";
    return snakeCase(str).toUpperCase();
  };
  return fn;
})();