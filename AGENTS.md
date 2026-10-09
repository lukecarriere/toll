# Agent instructions

- Run `npm test` before finishing a change. It builds, typechecks, runs the copy lint, and runs the Node and PHP tests.
- The copy lint keeps vendor names off public surfaces. Public strings come from `docs/copy.md`. Vendor names may appear only in `docs/adapters.md`, in package pins, and in the bundled licence notices.
- Phase 4 stays locked. Settlement is test-only: the stub backend, no real money, and no live payouts.
- Never deploy, publish, change DNS, or change repository visibility.
