# Claude Code Instructions

## Coding Style

- **Minimize comments.** Code should be self-explanatory. Only add comments when the logic is truly non-obvious.
- **No blank lines inside methods.** Keep method bodies compact without empty line separators.
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
