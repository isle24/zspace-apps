# NAS administrator store session implementation plan

> **For agentic workers:** Use subagent-driven-development; source task review before integration and live deployment.

**Goal:** Enter the embedded store with the current verified NAS administrator without a second password, while retaining standalone store login.

**Architecture:** Configure a fixed NAS identity provider on the independent shop. The SDK exchanges its own normal NAS session with that explicitly trusted shop instance. The shop verifies `POST /auth/token` and `is_master`, issues a short-lived memory-only store session and rechecks administrator authority before protected actions. Standalone password sessions keep their current behavior.

**Tech Stack:** Existing Go/SQLite independent shop, React/TypeScript SDK and Tauri HTTP plugin; no custom NAS business API.

## Global constraints

- User explicitly requested embedded NAS-administrator session reuse; standalone direct access continues to require store login.
- Never delete files/containers/data or change official 5055, global NAS configuration or NAS credentials.
- Use only credentials from this SDK's normal login. Never read cookies/passwords/tokens from another tab, official Mac client, cache, DOM or system vault without its existing normal login flow.
- NAS token may be transmitted only to the configured, explicitly trusted store instance and fixed NAS provider, never returned publicly or stored in SQLite/logs/files/URL/DOM. No arbitrary identity-check target, username matching or frontend admin claim.
- No administrator entitlement without fresh official success and exact `is_master` authority. Deny malformed, ordinary-account, expired, redirect, oversized, timeout and provider-mismatch results.
- Preserve administrator password setup and independent login. NAS authentication is disabled unless an operator configures its fixed provider. Do not enable it merely from a client-supplied URL.
- Session replacement/logout, store address/instance change and late responses cannot restore prior authorization. Protected actions fail closed on revoked administrator authority; restart revokes all NAS-derived sessions.
- Do not auto-enable remote access or change exposed ports. Source/synthetic checks and real authenticated acceptance are separate gates.

## Task 1: Fixed-provider verification and memory sessions

**Files:** focused `server/internal/store/nas_auth.go`, `nas_auth_test.go`; narrow `types.go`, `service.go`; `server/cmd/space-gateway/main.go/tests`; deployment script/tests/docs for configuration plumbing.

**Interfaces:** `Options.NASOrigin` and `--nas-origin` configure one canonical bare HTTP(S) origin; default disabled. Public status adds `nasAuth: {enabled,origin,storeId}`. `POST /api/store/nas-session` accepts `providerId` equal to the configured canonical origin, separate `storeId`, and bounded private `token`, `deviceId`, `nasId`; no request-selected target URL or roles. It verifies the configured official `/auth/token` using POST form and emits only normal store-session fields plus `authSource:"nas"`. Store ID binds exchange to the actual instance. Auth middleware accepts memory NAS sessions or existing independent SQLite password sessions.

- [x] Red/green tests: disabled/unconfigured, exact admin success, ordinary/missing/wrong-type master denial, target/instance mismatch, raw-token/error privacy, redirect/body bounds/timeouts, credential persistence absent, revoke/role change, logout, restart, bounded sessions and concurrent revoke/requests.
- [x] Official code evidence is `docs/research/2026-10-11-nas-admin-store-session.md`; verification response checks successful canonical envelope and nonempty username/user identity with `is_master` equal to numeric 1 or boolean true. Unknown truthy strings/objects cannot grant permission. Genuine different field types need new evidence before extending.
- [x] Verification uses fixed route and bounded form/body, no redirects, no proxy-env credential forwarding, a 5-second timeout and at most 64 KiB response. No raw upstream body/message enters product errors or logs.
- [x] Keep NAS tokens only in a bounded memory session map (maximum 128, expiry 20 minutes), behind its own mutex. Verify every protected operation against the provider; network calls occur outside locks. Recheck the exact entry after awaits so revoked/replaced/expired entries cannot act. Explicit logout must revoke local NAS-derived sessions even if NAS is unreachable.
- [x] Store setup still requires its original loopback admin setup; existing password sessions/DB/schema and application records remain preserved. Clear memory on Close, prune expiry at mint/auth, reject saturation rather than evict active sessions.
- [x] Add safe CLI/deployment option plumbing with canonical URL validation; preserve old default behavior and deployment ownership checks. Run Go full race/vet and deployment regressions, self-review, scoped commit, unique report `.superpowers/sdd/nas-admin-task-1-report.md`.

## Task 2: Private SDK exchange and embedded store flow

**Files:** `official-nas.ts` and focused tests, `client.ts/tests`, `modules/Store.tsx/tests`, `App.tsx/tests`; necessary exact native capability contract and dev identity route only; `StandaloneStore.tsx` only if needed to explicitly retain default independent mode.

**Interfaces:** Public Gateway `connectStoreWithNas` uses configured base, public store status and current NAS session; token exchange remains private inside OfficialNas. Store accepts `embedded?:boolean` (default false), App passes true, standalone leaves false. Expose only safe NAS identity/store session result, never an export-token callback or arbitrary endpoint API.

- [x] Red/green SDK/UI tests for exact destination, omitted browser credentials/no redirects, safe bounded exchange, matching provider/store instance, no NAS secret in output/errors, no token sent before trust, pre/post-await NAS/store generation fences and abandoned successful-session revocation.
- [x] On first matching provider/store-instance binding, display NAS and shop destination and explain session reuse; user trusts it once, without entering a new password. Persist only non-sensitive exact binding identifiers. Binding/store-instance changes require new trust, and ordinary users show clear permission feedback.
- [x] Embedded entry obtains and refreshes verified store authorization from its own NAS session automatically after trusted binding. Standalone page never accesses a NAS session or automatically exchanges it; independent login/setup continues unchanged.
- [x] Switching/expiring/logging out NAS clears NAS-derived store authorization and pending plans without affecting a separately logged-in password store session unnecessarily. Keep retry/install generation guards and downloads lifetime intact.
- [x] Native store exchange uses the same trusted store request boundary and exact API route permissions; never send a NAS Cookie to the shop. Add exact `/auth/token` read route only if client identity verification needs it, with POST guard.
- [x] Full frontend/typecheck/build, scoped review, Go/Rust checks where changed; unique report `.superpowers/sdd/nas-admin-task-2-report.md`.

## Runtime acceptance

Use root-owned synthetic official provider and independent shop first to prove administrator/ordinary/revoke/standalone behavior. Then normal real NAS login (no imported browser session), configured existing shop, reviewed trust destination, embedded entry, actual protected read and logout. Validate real `is_master` type through SDK's sanitized identity result. Source correctness alone does not establish the real SSO or formal HTTPS/remote deployment. User login handoffs remain pending while independent source work continues.


Task 1 source gate passed through `78adf7c`: strict provider/authority/privacy and final-commit revocation fences, scoped re-review clean, final Go race/vet and 15 deployment regressions passed. Task 2 source gate passed through `464b37c`: exact trust, private exchange, automatic embedded reuse and independent login; expiry-field reflection finding closed by canonical timestamp output and four regression cases. Full frontend669/Rust38 at `c4c5c9d`, fix-focused114/typecheck at `464b37c`, and the new Mac build passed. Root actual synthetic browser/Go pairing, administrator revocation, normal relogin reuse and standalone independence passed; report is `.superpowers/sdd/nas-admin-root-acceptance.md`.

Combined final review Approved through `464b37c`. Root deployed frozen-source release `20261011T063139Z-e63554ec`, explicitly enabling the fixed official NAS origin and the exact development H5 origin; service health, original account/instance/job preservation, same-origin proxy and unauthenticated/foreign-origin rejection passed. These are separate from real authenticated acceptance. Real provider fields and authenticated NAS/H5/native pairing remain pending; the human explicitly postponed both real login handoffs and requested continued client/session development. Current evidence is `docs/verification/2026-10-11-nas-admin-checkpoint.md`.
