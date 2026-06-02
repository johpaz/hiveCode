/**
 * Number formatting utilities for hivecode
 *
 * Provides common number formatting functions:
 * - Currency formatting (formatCurrency)
 * - Percentage formatting (formatPercent)
 * - Number formatting with precision (formatNumber)
 * - Compact notation (formatCompact)
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Options for currency formatting
 */
export interface CurrencyOptions {
  /** ISO 4217 currency code (e.g., 'USD', 'EUR', 'COP') */
  currency?: string;
  /** Locale for formatting (e.g., 'en-US', 'es-CO') */
  locale?: string;
  /** Number of decimal places (default: 2) */
  decimals?: number;
  /** Override the currency symbol */
  symbol?: string;
  /** Whether to show the currency symbol (default: true) */
  showSymbol?: boolean;
}

/**
 * Options for percentage formatting
 */
export interface PercentOptions {
  /** Number of decimal places (default: 1) */
  decimals?: number;
  /** Locale for formatting */
  locale?: string;
  /** If true, divides value by 100 before formatting (e.g., 0.25 → 25%) */
  multiply?: boolean;
}

/**
 * Options for number formatting
 */
export interface NumberOptions {
  /** Number of decimal places (default: 2) */
  decimals?: number;
  /** Locale for formatting */
  locale?: string;
  /** Thousands separator (default: ',') */
  separator?: string;
  /** Decimal point character (default: '.') */
  decimalPoint?: string;
}

// ============================================================================
// Currency Formatting
// ============================================================================

/**
 * Currency symbols by ISO 4217 code
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  INR: "₹",
  BRL: "R$",
  MXN: "$",
  COP: "$",
  ARS: "$",
  CLP: "$",
  PEN: "S/",
  CAD: "C$",
  AUD: "A$",
  CHF: "CHF",
  // Add more as needed
};

/**
 * Default locale per currency
 */
const CURRENCY_LOCALES: Record<string, string> = {
  USD: "en-US",
  EUR: "de-DE",
  GBP: "en-GB",
  JPY: "ja-JP",
  CNY: "zh-CN",
  KRW: "ko-KR",
  INR: "en-IN",
  BRL: "pt-BR",
  MXN: "es-MX",
  COP: "es-CO",
  ARS: "es-AR",
  CLP: "es-CL",
  PEN: "es-PE",
  CAD: "en-CA",
  AUD: "en-AU",
  CHF: "de-CH",
};

/**
 * Formats a number as currency
 *
 * @example
 * formatCurrency(1234.56)           // "$1,234.56"
 * formatCurrency(1234.56, { currency: 'EUR' })  // "€1,234.56"
 * formatCurrency(1234.56, { decimals: 0 })      // "$1,235"
 * formatCurrency(1234.56, { symbol: '$' })       // "$1,234.56"
 * formatCurrency(1234.56, { showSymbol: false }) // "1,234.56"
 */
export function formatCurrency(value: number, options: CurrencyOptions = {}): string {
  const {
    currency = "USD",
    locale = CURRENCY_LOCALES[currency] || "en-US",
    decimals = 2,
    symbol,
    showSymbol = true,
  } = options;

  // Use Intl.NumberFormat for locale-aware formatting
  const formatter = new Intl.NumberFormat(locale, {
    style: "decimal",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const formattedNumber = formatter.format(value);

  if (!showSymbol) {
    return formattedNumber;
  }

  // Use provided symbol or look up from currency code
  const currencySymbol = symbol ?? CURRENCY_SYMBOLS[currency] ?? currency;

  // Position symbol based on locale conventions
  // Most locales put symbol before, some after (e.g., some Arabic locales)
  const symbolPositions: Record<string, "before" | "after"> = {
    "en-US": "before",
    "de-DE": "before",
    "fr-FR": "before",
    "es-ES": "before",
    "ja-JP": "before",
    "zh-CN": "before",
  };

  const position = symbolPositions[locale] ?? "before";

  return position === "before"
    ? `${currencySymbol}${formattedNumber}`
    : `${formattedNumber}${currencySymbol}`;
}

// ============================================================================
// Percentage Formatting
// ============================================================================

/**
 * Formats a number as a percentage
 *
 * @example
 * formatPercent(0.256)              // "25.6%"
 * formatPercent(0.256, { decimals: 0 })  // "26%"
 * formatPercent(25, { multiply: false }) // "25%"
 * formatPercent(0.256, { locale: 'de-DE' }) // "25,6 %"
 */
export function formatPercent(value: number, options: PercentOptions = {}): string {
  const {
    decimals = 1,
    locale = "en-US",
    multiply = true,
  } = options;

  // Intl.NumberFormat with style:"percent" already:
  // 1. Treats the value as a fraction (0.25 = 25%)
  // 2. Adds the % symbol
  // So we just pass the raw value when multiply is true, or divide by 100 when false
  const displayValue = multiply ? value : value * 100;

  const formatter = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  // Intl.NumberFormat percent style divides by 100 automatically
  // So we pass the raw value and it handles the % symbol and division
  return formatter.format(displayValue);
}

// ============================================================================
// Number Formatting
// ============================================================================

/**
 * Formats a number with custom separators and precision
 *
 * @example
 * formatNumber(1234567.89)                    // "1,234,567.89"
 * formatNumber(1234567.89, { decimals: 0 })   // "1,234,568"
 * formatNumber(1234567.89, { separator: '.' }) // "1.234.567,89"
 * formatNumber(1234567.89, { locale: 'de-DE' }) // "1.234.567,89"
 */
export function formatNumber(value: number, options: NumberOptions = {}): string {
  const {
    decimals = 2,
    locale = "en-US",
    separator,
    decimalPoint,
  } = options;

  // If custom separators are provided, use manual formatting
  if (separator !== undefined || decimalPoint !== undefined) {
    const parts = value.toFixed(decimals).split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, separator ?? ",");
    const decPart = parts[1];

    return decimalPoint !== undefined
      ? `${intPart}${decimalPoint}${decPart}`
      : `${intPart}.${decPart}`;
  }

  // Use Intl.NumberFormat for locale-aware formatting
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return formatter.format(value);
}

// ============================================================================
// Compact Notation
// ============================================================================

/**
 * Formats a number in compact notation (1K, 1M, 1B, etc.)
 *
 * @example
 * formatCompact(1234)      // "1.2K"
 * formatCompact(1234567)   // "1.2M"
 * formatCompact(1234567890) // "1.2B"
 * formatCompact(999)       // "999"
 * formatCompact(999999)    // "1M"
 */
export function formatCompact(value: number, options: { locale?: string; decimals?: number } = {}): string {
  const { locale = "en-US", decimals = 1 } = options;

  // For small numbers (< 1000), return as-is without decimals
  if (Math.abs(value) < 1000) {
    return formatNumber(value, { decimals: 0, locale });
  }

  const formatter = new Intl.NumberFormat(locale, {
    notation: "compact",
    compactDisplay: "short",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return formatter.format(value);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parses a formatted string back to a number
 *
 * @example
 * parseFormattedNumber("$1,234.56")  // 1234.56
 * parseFormattedNumber("1.234,56")  // 1234.56 (locale-aware)
 * parseFormattedNumber("1K")         // 1000
 */
export function parseFormattedNumber(value: string, locale: string = "en-US"): number {
  // Remove currency symbols and whitespace
  let cleaned = value.replace(/[^\d.,\-]/g, "").trim();

  if (!cleaned) {
    return NaN;
  }

  // Detect locale from the format
  const hasLeadingCurrency = /^\$|^\€|^\£/.test(value);
  const hasTrailingCurrency = /\$|\€|\£$/.test(value);

  // Handle compact notation (K, M, B, T)
  const compactMatch = cleaned.match(/^([\d.,]+)\s*([KMBT])$/i);
  if (compactMatch) {
    const num = parseFloat(compactMatch[1].replace(",", ""));
    const suffix = compactMatch[2].toUpperCase();
    const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    return num * multipliers[suffix];
  }

  // Determine decimal separator based on locale
  const localeInfo = new Intl.Locale(locale);
  const region = localeInfo.region;

  // Common regions that use period as thousand separator
  const periodAsThousand: Record<string, boolean> = {
    DE: true, // Germany
    FR: true, // France
    ES: true, // Spain
    IT: true, // Italy
    BR: true, // Brazil
    PT: true, // Portugal
  };

  let num: number;

  if (periodAsThousand[region]) {
    // Period is thousand separator, comma is decimal
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // Comma is thousand separator, period is decimal
    cleaned = cleaned.replace(/,/g, "");
  }

  num = parseFloat(cleaned);
  return isNaN(num) ? NaN : num;
}

/**
 * Rounds a number to specified precision
 *
 * @example
 * round(3.14159, 2)  // 3.14
 * round(3.14159, 0)  // 3
 * round(3.14159, 4)  // 3.1416
 */
export function round(value: number, decimals: number = 0): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Pads a number with leading zeros
 *
 * @example
 * padNumber(42, 5)   // "00042"
 * padNumber(1234, 3) // "1234"
 * padNumber(-42, 5)  // "-00042"
 */
export function padNumber(value: number, length: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const padded = String(abs).padStart(length, "0");
  return sign + padded;
}

// ============================================================================
// Export all functions as a namespace
// ============================================================================

export const format = {
  currency: formatCurrency,
  percent: formatPercent,
  number: formatNumber,
  compact: formatCompact,
  parse: parseFormattedNumber,
  round,
  pad: padNumber,
};
