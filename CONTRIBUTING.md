# Contributing

This is a personal assistant, published because it is useful — not a product with a roadmap. Issues and small pull requests are welcome; large redesigns are unlikely to be merged.

## Before you open a pull request

```bash
npm run typecheck     # tsc, no emit
npm test              # pure logic, node --test
npm run eval          # guard and contract checks
```

`npm run eval -- --strict` also fails on the cases marked as known gaps, so it is the honest bar.

## What a change is expected to carry

- **A test for logic.** `tests/` pins functions; if you change a decision (approval, dedup, access, card phase), pin it there.
- **No new dependency** without a reason in the description. The runtime is deliberately small.
- **English comments**, and only where the why is not obvious from the code.
- **No real identifiers in fixtures.** Use `oc_0123456789abcdef0123456789abcdef`, `ou_0123…`, `example.com`, `/Users/example/…`. A real chat id, token or internal hostname in a test is a bug.
- **Commit messages** in the imperative, one subject line that says what changed and why: `fix(feishu): the live card keeps its header on every patch`.

## Reporting a security issue

See [SECURITY.md](SECURITY.md); please do not open a public issue.
