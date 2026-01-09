# Claude Code Instructions

## Coding Style

- **Never use single-letter abbreviations in lambdas.** Use descriptive names like `entry`, `text`, `value`, `event`, etc.
- **Use types and functions from `@opendaw/lib-std` instead of inline checks:**
  - Use `Optional<T>` instead of `T | undefined`
  - Use `Nullable<T>` instead of `T | null`
  - Use `isDefined(value)` instead of `value !== undefined` or `value !== null`
  - Use `!isDefined(value)` instead of `value === undefined` or `value === null`
  - Never write `| null` or `| undefined` inline - always use the lib-std types.
