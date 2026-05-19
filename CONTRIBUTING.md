# Contributing

## Workflow

1. Open an issue in [dagstack/config-typescript](https://github.com/dagstack/config-typescript/issues) for non-trivial changes.
2. Branch off `main` as `feature/<issue-id>-<desc>`.
3. Implementation + tests + `CHANGELOG.md` update (the `[Unreleased]` section).
4. `make lint typecheck test` — clean, no errors.
5. PR into `main`, review, merge (squash).

## Normative reference

The public API contract is [`dagstack/config-spec`](https://github.com/dagstack/config-spec), ADR-0001. If the binding's behavior diverges from the spec, that's a bug in the binding (or, more rarely, a proposal to amend the spec via an ADR amendment).

Golden fixtures live in `spec/conformance/`; CI runs them via `make conformance`.

## Dev dependencies

- Node.js ≥20, npm (or pnpm).
- Git with submodule support (`git submodule update --init`).

## Code style

- TypeScript strict mode (`tsconfig.json`).
- Prettier formatting (`npm run format`).
- ESLint flat config (`npm run lint`).
- UTF-8, LF line endings (see `.editorconfig` + `.gitattributes`).

## Commit style

Short title in the present tense (English or Russian). Body — optional. Identity — `demchenkoev@gmail.com`.
