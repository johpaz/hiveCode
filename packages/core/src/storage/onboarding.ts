/**
 * Onboarding / user resolution — stubbed to fix build.
 * TODO: Implement user session resolution and onboarding flow.
 */

export function resolveUserId(_req?: any): string {
  return "default-user"
}

export function resolveAgentId(_req?: any): string {
  return "default-agent"
}

export function runStartupMigrations(): void {
  // TODO: Run any DB migrations on startup
}

export function activateBrowserTools(): void {
  // TODO: Activate browser automation tools if configured
}

export function initOnboardingDb(): void {
  // TODO: Initialize onboarding-specific tables
}

export function saveUserProfile(_profile: any): void {
  // TODO: Save user profile to DB
}

export function saveAgentConfig(_config: any): string {
  return "stub-agent-id"
}

export function saveProviderConfig(_config: any): void {
  // TODO: Save provider config to DB
}

export function activateChannel(_channelId: string): void {
  // TODO: Activate channel in DB
}

export function saveVoiceConfig(_config: any): void {
  // TODO: Save voice config to DB
}

export function activateEthics(_ethicsId: string): void {
  // TODO: Activate ethics template in DB
}
