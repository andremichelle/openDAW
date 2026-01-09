# Claude Code Instructions

## Coding Style

- **Never use single-letter abbreviations in lambdas.** Use descriptive names like `entry`, `text`, `value`, `event`, etc.
- **Use types from `@opendaw/lib-std` instead of inline union types:**
  - Use `Optional<T>` instead of `T | undefined`
  - Use `Nullable<T>` instead of `T | null`
  - Use `isDefined()` instead of `!== undefined`
  - Never write `| null` or `| undefined` inline - always use the lib-std types.
