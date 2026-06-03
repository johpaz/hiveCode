---
name: code_security_audit
description: "Security audit for code: detect vulnerabilities, hardcoded secrets, injection risks, and dependency issues"
version: 1.0.0
icon: "🔒"
category: code
tools: [code_search, fs_read, code_lint, shell_executor, web_search]
triggers:
  - "security"
  - "seguridad"
  - "vulnerabilidad"
  - "vulnerability"
  - "audit"
  - "auditoría"
  - "cve"
  - "secrets"
  - "secretos"
  - "inyección"
  - "injection"
  - "xss"
  - "sql injection"
  - "csrf"
preferred_agents: []
steps:
  - step: 1
    action: scan_for_secrets
    instruction: "Search for hardcoded API keys, tokens, passwords in codebase"
  - step: 2
    action: scan_dependencies
    instruction: "Check for known vulnerabilities in dependencies"
  - step: 3
    action: code_review_security
    instruction: "Review code for common security issues (injection, XSS, auth bypass)"
  - step: 4
    action: report
    instruction: "Generate security audit report with findings and remediation steps"
rules:
  - "Never report actual secrets in output - only report locations"
  - "Check npm audit, pip audit, or cargo audit depending on project"
  - "Prioritize findings by severity (Critical > High > Medium > Low)"
  - "Always suggest specific fixes for each finding"
output_format:
  structure: markdown
  sections:
    - "summary"
    - "critical_findings"
    - "high_findings"
    - "medium_findings"
    - "low_findings"
    - "recommendations"
examples:
  - user_input: "auditá la seguridad del proyecto"
    expected_behavior: "Run security scans → generate report with findings and fixes"
---
# Code Security Audit Skill

## Áreas de Revisión

1. **Secretos**: API keys, tokens, passwords en código
2. **Dependencias**: npm audit, pip audit, cargo audit
3. **Inyección SQL**: Validación de inputs, prepared statements
4. **XSS**: Escapado de outputs, Content-Security-Policy
5. **Autenticación**: JWT, sesiones, permisos
6. **CSRF**: Tokens, SameSite cookies
