/**
 * Command Validator — Pre-execution safety layer for LLM-generated shell commands.
 *
 * Answers the 5 TDD §14 questions before any command runs:
 *   1. Does the path escape the project workspace?
 *   2. Does it access host environment secrets?
 *   3. Does it contain destructive patterns (rm -rf, mkfs, dd)?
 *   4. Does it download and pipe-execute scripts from the internet?
 *   5. Does it require root privileges?
 *
 * Also flags ALWAYS_CONFIRM actions regardless of agent mode.
 */

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; fatal: boolean };

// Patterns that are always blocked — no mode overrides this
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-\w*f\w*\s+)*-rf?\s+\/(?!\S)/, reason: "Recursive delete of filesystem root (rm -rf /)" },
  { pattern: /rm\s+(-\w*f\w*\s+)*-rf?\s+~\/?\s*$/, reason: "Recursive delete of home directory" },
  { pattern: /mkfs\b/, reason: "Filesystem format command (mkfs)" },
  { pattern: /dd\s+.*of=\/dev\/[sh]d[a-z]/, reason: "Raw disk write via dd" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:|;\s*\};\s*:/, reason: "Fork bomb detected" },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?bash/, reason: "Pipe internet script to shell (curl | bash)" },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?sh/, reason: "Pipe internet script to shell (curl | sh)" },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?zsh/, reason: "Pipe internet script to shell (curl | zsh)" },
  { pattern: /wget\s+.*-O\s*-\s*\|/, reason: "Pipe internet script to shell (wget -O- |)" },
  { pattern: /eval\s*\$\(curl/, reason: "eval of remote script (eval $(curl ...))" },
  { pattern: /python\s+-c\s+.*\bexec\b/, reason: "Python exec of arbitrary code" },
  { pattern: /node\s+-e\s+.*\brequire\b/, reason: "Node require of arbitrary module" },
  { pattern: /\beval\s*\(/, reason: "eval() of arbitrary code" },
  { pattern: /\bnew\s+Function\s*\(/, reason: "new Function() of arbitrary code" },
  { pattern: /\bsu\s+-/, reason: "Privilege escalation (su -)" },
  { pattern: /chmod\s+.*[7]/, reason: "World-writable permissions (chmod ...7...)" },
  { pattern: /chown\s+root/, reason: "Change ownership to root (chown root)" },
  { pattern: /\/etc\/passwd|shadow|sudoers/, reason: "Access to system credential files" },
  { pattern: /\/proc\//, reason: "Access to /proc filesystem" },
  { pattern: /\/sys\/kernel/, reason: "Access to /sys/kernel" },
  { pattern: /Bun\.secrets/, reason: "Access to Bun.secrets keystore" },
  { pattern: /process\.env\.[A-Z_]*(?:KEY|SECRET|TOKEN)/, reason: "Access to environment secrets" },
  { pattern: /curl\s+.*\$\(cat\s+/, reason: "Exfiltration via curl $(cat ...)" },
  { pattern: /base64\s+.*\|\s*curl/, reason: "Exfiltration via base64 | curl" },
];

// Patterns that ALWAYS require user confirmation regardless of mode
const ALWAYS_CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /DROP\s+TABLE\b/i, reason: "SQL DROP TABLE" },
  { pattern: /DELETE\s+FROM\s+\w+\s*(?:WHERE\s+1\s*=\s*1|;|$)/i, reason: "DELETE without WHERE" },
  { pattern: /\brm\s+(-\w+\s+)*["']?[\w.\/]+/, reason: "File deletion (rm)" },
  { pattern: /git\s+push\s+.*(?:main|master)\b/, reason: "Push to main/master branch" },
  { pattern: /git\s+push\s+--force/, reason: "Force push" },
  { pattern: /bun\s+add\b/, reason: "Package installation (bun add)" },
  { pattern: /npm\s+install\b(?!\s+--no-save)/, reason: "Package installation (npm install)" },
  { pattern: /\b\.env\b.*(?:write|echo|tee|>)/, reason: "Write to .env file" },
  { pattern: /(?:echo|tee|>)\s+.*\.env\b/, reason: "Write to .env file" },
  { pattern: /\bsudo\b/, reason: "Requires root (sudo)" },
  { pattern: /chmod\s+777\b/, reason: "World-writable permissions (chmod 777)" },
  { pattern: /\btruncate\s+/, reason: "File truncation" },
];

// Patterns that suggest env access (warn, not block)
const ENV_ACCESS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\{?\s*(?:AWS|AZURE|GCP|STRIPE|TWILIO|SENDGRID)_[A-Z_]+\s*\}?/, reason: "Cloud provider credentials in command" },
  { pattern: /\$\{?\s*[A-Z_]+_API_KEY\s*\}?/, reason: "API key variable reference" },
  { pattern: /\$\{?\s*[A-Z_]+_SECRET\s*\}?/, reason: "Secret variable reference" },
  { pattern: /\$\{?\s*DATABASE_URL\s*\}?/, reason: "Database URL variable reference" },
];

export interface ValidationOptions {
  workspace?: string;
  mode?: "plan" | "approval" | "auto";
}

/**
 * Validate a shell command before execution.
 * Returns { ok: true } if safe, or { ok: false, reason, fatal } if not.
 * fatal=true means BLOCK regardless of mode; fatal=false means WARN/CONFIRM.
 */
export function validateCommand(cmd: string, opts: ValidationOptions = {}): ValidationResult {
  // 1. Check for outright blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { ok: false, reason, fatal: true };
    }
  }

  // 2. Check workspace escape — paths going to /etc, /usr/bin, /boot, etc.
  if (opts.workspace) {
    // Flag commands that explicitly target system paths outside the workspace
    const systemPaths = /(?:^|\s|['">&|])\/(etc|usr|bin|sbin|boot|proc|sys|dev|root)\//;
    if (systemPaths.test(cmd)) {
      return {
        ok: false,
        reason: `Command references system path outside workspace (${opts.workspace})`,
        fatal: false,
      };
    }
  }

  // 3. Check for env secret access
  for (const { pattern, reason } of ENV_ACCESS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { ok: false, reason: `Command references host secrets: ${reason}`, fatal: false };
    }
  }

  // 4. Check ALWAYS_CONFIRM patterns
  for (const { pattern, reason } of ALWAYS_CONFIRM_PATTERNS) {
    if (pattern.test(cmd)) {
      return { ok: false, reason: `Requires confirmation: ${reason}`, fatal: false };
    }
  }

  return { ok: true };
}

/**
 * Returns true if the command is an ALWAYS_CONFIRM action (needs user approval
 * regardless of agent mode).
 */
export function requiresConfirmation(cmd: string): string | null {
  for (const { pattern, reason } of ALWAYS_CONFIRM_PATTERNS) {
    if (pattern.test(cmd)) return reason;
  }
  return null;
}

/**
 * Returns true if the command is completely blocked (fatal).
 */
export function isBlocked(cmd: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) return reason;
  }
  return null;
}
