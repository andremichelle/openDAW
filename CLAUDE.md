# Claude Code Instructions

## Coding Style

- **Absolutely minimal comments.** A comment is rare and it is ONE short line. Never a 4-5 line block, never narration of what the code is doing, never a design rationale (that belongs in the commit message). Only comment when it is absolutely necessary, meaning the reader needs a fact the code cannot show. Tests may be commented freely.
- **No blank lines inside methods.** Keep method bodies compact without empty line separators.
- **Keep destructuring compact.** Group multiple destructured properties on the same line rather than one per line. Break into multiple lines only when a single line would exceed ~120 characters.
- **Never use single-letter abbreviations in lambdas.** Use descriptive names like `entry`, `text`, `value`, `event`, etc.
- **Use types and functions from `@opendaw/lib-std` instead of inline checks:**
  - Use `Optional<T>` instead of `T | undefined`
  - Use `Nullable<T>` instead of `T | null`
  - Use `isDefined(value)` instead of `value !== undefined` or `value !== null`
  - Use `!isDefined(value)` instead of `value === undefined` or `value === null`
  - Use `isAbsent(value)` instead of `value === undefined || value === null`
  - **Never use falsy checks like `!value` or `if (!value)` for null/undefined checks** - always use `!isDefined(value)` or `isAbsent(value)`
  - Never write `| null` or `| undefined` inline - always use the lib-std types.
  - Use `MutableObservableOption<T>` instead of `DefaultObservableValue<Nullable<T>>`. Use `wrap(value)`/`clear()` instead of `setValue(value)`/`setValue(null)`.
- **Never use `!` definite assignment assertions** (`let x!: Type`) to suppress compiler errors. Create elements as `const` upfront and embed them in JSX with `{el}`.
- **Use the `.hidden` CSS class** instead of `element.style.display = "none"`. Use `element.classList.add("hidden")` / `element.classList.remove("hidden")`.
- **Never use `as any`** — always define proper types instead.
- **Never use `try/catch`** — use `tryCatch()` from `@opendaw/lib-std`.
- **Never use `"foo" in bar`** for type checks — use proper type guards.
- **Never use `Set`/`Map` with `UUID.Bytes`** — use `UUID.newSet` / `UUID.newMap` (SortedSet) for correct byte-level comparison.
- **Use `Option<T>`, not `Optional<T>`**, for fallible return types.
- **Use the actual type from its source** — never create ad-hoc structural types like `{ name: string, value: number }` when a proper type exists.
- **Move complex field initializations into the constructor** rather than using inline field initializers.
- **Always use `--noEmit` when type-checking** to avoid generating waste `.js`/`.d.ts` files.

## Workflow

- **Analyze bugs and propose fixes, but wait for approval before editing code.**
- **Never commit.** Only run `git commit` when explicitly asked, for that commit. Finished, tested and verified work is ready to be committed, it is not permission to commit it.
- **Never use `Write` to rewrite existing files** — always use `Edit` (small diffs).
