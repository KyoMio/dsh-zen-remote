# Security Policy

## Supported versions

Only the latest major release on npm receives security fixes.

| Version | Supported |
| ------- | --------- |
| 2.x (latest, currently 2.3.x) | ✅ |
| < 2.0   | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a
suspected vulnerability.

Report it privately through GitHub's private vulnerability reporting:
**Security → Advisories → Report a vulnerability** on
<https://github.com/KyoMio/dsh-zen-remote/security/advisories/new>.

If that form is unavailable, open a minimal issue that only asks for a private
contact channel — no details, no proof of concept — and we will reach out.

Helpful to include: affected version, role (host / client / gateway), the
component (e.g. `lib/lan-gate-server.cjs`, relay, plugin bridge), reproduction
steps and impact.

We aim to acknowledge reports within 7 days and to ship a fix or mitigation
for confirmed issues in the next patch release, crediting the reporter unless
you ask otherwise.

## Scope notes

- The pairing-code gateway, device tokens, relay shared secret and the plugin
  bridge's share checks are in scope.
- Literal "secrets" under `test/` (e.g. `'a1b2c3d4'.repeat(8)`, `tok-gateway`)
  are synthetic fixtures for the test suite, not real credentials.

---

## 安全策略（中文）

- 仅 npm 上的最新大版本（当前 2.x）接收安全修复。
- 请勿公开提 issue / PR；请走 GitHub 私密漏洞报告：仓库 Security → Advisories →
  Report a vulnerability。表单不可用时，开一个只请求私下联系方式的 issue（不写细节）。
- `test/` 里的字面量“密钥”都是测试夹具，不是真实凭据。
