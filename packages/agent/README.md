# packages/agent

Not started. Phase 2: a `toll.fetch` for automated clients that pays the per-request offer instead of doing the work. It stays Toll's own code (Amendment 1). It will solve work with the work adapter's Node solver (`solveWork` in `packages/work-adapter`) and pay through the `SettlementEngine` interface in `packages/settlement-ln` (stub only for now). See docs/adapters.md and docs/settlement.md.
