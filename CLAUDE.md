# Claude Code Instructions

## Coding Style

- **Never use single-letter abbreviations in lambdas.** Use descriptive names like `entry`, `text`, `value`, `event`, etc.
- **Use types and functions from `@opendaw/lib-std` instead of inline checks:**
  - Use `Optional<T>` instead of `T | undefined`
  - Use `Nullable<T>` instead of `T | null`
  - Use `isDefined(value)` instead of `value !== undefined` or `value !== null`
  - Use `!isDefined(value)` instead of `value === undefined` or `value === null`
  - Use `isAbsent(value)` instead of `value === undefined || value === null`
  - **Never use falsy checks like `!value` or `if (!value)` for null/undefined checks** - always use `!isDefined(value)` or `isAbsent(value)`
  - Never write `| null` or `| undefined` inline - always use the lib-std types.
