# Claude Code Instructions

## Coding Style

- **Never use single-letter abbreviations in lambdas.** Use descriptive names like `entry`, `text`, `value`, `event`, etc.
- **Use `Optional` from `@opendaw/lib-std` instead of `T | undefined` or `T | null`.** Import from `packages/lib/std/src/lang.ts`.
