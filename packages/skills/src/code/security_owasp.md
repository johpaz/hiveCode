# Security OWASP

## Top 10 Risks
1. **Broken Access Control**: Enforce authorization on every endpoint
2. **Cryptographic Failures**: Use HTTPS, hash passwords with Bun.password, encrypt at rest
3. **Injection**: Use parameterized queries, NEVER string concatenation for SQL
4. **Insecure Design**: Threat model before coding, assume breach
5. **Security Misconfiguration**: Remove default creds, disable debug in prod
6. **Vulnerable Components**: Audit dependencies with `check_dependencies`
7. **Auth Failures**: Implement MFA, secure session handling
8. **Software Integrity**: Verify checksums of downloaded scripts
9. **Logging Failures**: Log security events, never log secrets
10. **SSRF**: Validate URLs before server-side fetching

## Bun-Specific
- `Bun.password.hash()` for password hashing
- `Bun.CryptoHasher` for integrity checks
- `Bun.secrets` for API keys (never in .env files)
- Sandbox `Bun.spawn` with minimal env, isolated cwd

## Code Review Checklist
- [ ] No hardcoded secrets
- [ ] All inputs validated
- [ ] Auth checks on every route
- [ ] SQL uses parameterized queries
- [ ] Error messages don't leak internals
