# Agent instructions

- Run `npm test` before finishing a change. It builds, typechecks, runs the copy lint, and runs the Node and PHP tests.
- Verify a checkout with `.cursor/skills/verify/SKILL.md`. pstack skills are vendored under `.cursor/skills/` (MIT, Lauren Tan). The reasoning budget is small (medium). Skip `/swarm` and `/arena` unless a design is contested.
- The copy lint keeps vendor names off public surfaces. Public strings come from `docs/copy.md`. Vendor names may appear only in `docs/adapters.md`, in package pins, and in the bundled licence notices.
- Phase 4 stays locked. Settlement is test-only: the stub backend, no real money, and no live payouts.
- Never deploy, publish, change DNS, or change repository visibility.

## Rules and enforcers

| Rule | Enforcer |
| --- | --- |
| Public copy stays on the lint list. Vendor names stay in `docs/adapters.md`, package pins, and licence notices. | `npm run lint:copy` |
| Commit titles after `fa12195` are linted, so CI fetches full history. | `.github/workflows/ci.yml` `fetch-depth: 0` |
| Dotted hosts outside the allow list fail. | `tests/no-hardcoded-domains.test.ts` |
| Node packages are MIT. The plugin and the PHP library are GPL-2.0-or-later. | `tests/licence.test.ts` |
| Page meta descriptions, including legal pages, come from `docs/copy.md`. | `tests/meta-descriptions.test.ts` |
| Every built public page stays within a 360 and 390 phone width. | `tests/viewport.test.ts`, `tests/viewport-coverage.test.ts` |
| Plugin display name is Toll Gate. The header and the copy display name do not contain WordPress. | `scripts/plugin-name.mjs` in `scripts/build-wp-zip.mjs`, `tests/plugin-name.test.ts` |
| A challenge shape error does not echo the caller field name. | `tests/error-detail.test.ts` |
| Tests and the agent client read every fetch body they check with `.status` or `.ok`. | `tests/fetch-body.test.ts`, `drain` in `tests/helpers.ts` |
| Settlement stays on the stub. Live mode throws. | `tests/settlement-stub.test.ts` |
| `X-Forwarded-For` is not taken from the leftmost hop. | `tests/xff-trust.test.ts` |
| The site-key field is `type=text` and the admin line height is at least 1.75. | `tests/wp.test.ts` |
| pstack budget is small. Skip `/swarm` and `/arena` unless a design is contested. | `.cursor/rules/pstack-models.mdc` and this file |
