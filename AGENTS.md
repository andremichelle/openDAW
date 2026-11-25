# openDAW Agent Instructions

Pull requests are reviewed against these rules. Check every new or touched file before opening one.

## Code Style

### Comments and layout

- Comments are rare and ONE short line. No doc blocks, no headers, no narration of what the code does, no design rationale (that belongs in the commit or PR). A comment is fine for a magic number, a value in a box schema, or a reason the reader cannot infer from the code. Tests may be commented freely.
- No blank lines inside method or function bodies.
- Exactly one blank line above a constructor. Constructor parameters each on their own line when there is more than one.
- Keep destructuring compact, several properties per line, break only beyond ~120 characters.
- Lambda parameters get descriptive names (`entry`, `region`, `event`), never single letters.

### Types

- Import types and helpers from `@opendaw/lib-std` (`packages/lib/std/src/lang.ts`):
  - `Nullable<T>` instead of `T | null`, `Optional<T>` instead of `T | undefined`. Never write `| null` or `| undefined` inline.
  - `Option<T>` for fallible return values, never `Optional<T>` or a nullable.
  - `Exec`, `Provider<T>`, `Procedure<T>`, `Predicate<T>`, `Func<T, R>` instead of inline function types like `() => void` or `(value: T) => void`. `EmptyExec` and `EmptyProcedure` for no-ops.
  - `MutableObservableOption<T>` instead of `DefaultObservableValue<Nullable<T>>`, with `wrap(value)` and `clear()`.
- `Array<T>` and `ReadonlyArray<T>`, never `T[]`. An empty `ReadonlyArray` return is `Arrays.empty()`.
- Use the real type from its source. Never invent ad-hoc structural types like `{in: number, out: number}` when an adapter, box or named type already exists.
- No `as` casts that force a type (`as any`, `as unknown as T`, `value as SomeEnum`). Fix the types or narrow with a type guard. `as const` is fine.
- No `as` casts on JSX (type the binding: `const button: HTMLButtonElement = <button/>`), no `!` definite assignment assertions.

### Checks and control flow

- Null and undefined checks only via `isDefined(value)`, `isAbsent(value)`, `isNull(value)`, `isNotNull(value)`. Never `=== null`, `!== undefined` or falsy checks like `!value` / `if (value)` for absence.
- Never `"key" in object` for narrowing. Every union in this codebase has a discriminant (`type`, `kind`), narrow by it.
- Never `try/catch`, use `tryCatch()` from lib-std.
- Prefer `const` over `let`. For mutable state use a `const` holder or `MutableObservableOption<T>`.
- An `Option.unwrap()` that is not guarded by `nonEmpty()` takes a short tag naming the expression: `region.optCollection.unwrap("optCollection")`.
- Never `Set` or `Map` keyed by `UUID.Bytes`, use `UUID.newSet` / `UUID.newMap`.
- Never drop an error silently. Ignore only the expected case (a cancelled file dialog, `Errors.isAbort(error)`) and report or rethrow everything else.
- One user action is one `editing.modify` transaction, so it is one undo step. Never call `modify` once per item in a loop.

### Structure

- Exported functions live in a namespace named after the file (`RegionEditing.cut`, not a bare `cutRegion`).
- A file named after its single class or box schema keeps exactly that one definition. A new class goes into its own file.
- Complex field initialisation goes into the constructor, not into inline field initialisers.
- Keep element references as `const` and test with `contains` instead of DOM lookups like `closest()`.
- Hide elements with the `.hidden` CSS class, never `style.display = "none"`.

### UI

- No inline `style={{...}}` in JSX. Styles go into the component's sass file.
- Use the existing components (`Button`, `Checkbox`, `NumberInput`, `MenuButton`, `SearchInput`) instead of raw form elements.
- A new keyboard shortcut is registered in `GlobalShortcuts`, so it is listed and can be rebound.

### Styles (sass)

- No comments in `.sass` files.
- Padding, margin, inset and border-width take 1, 2 or 4 values, never 3.
- Read the component's existing sass first and reuse its colours and variables, no inline colours.

## Pull Requests

- Target `next-release` and merge it into your branch before opening the PR.
- Keep pull requests small and focused, large ones are not reviewed. Split a big feature into parts that each keep the app working.
- An unrelated fix goes into its own commit or pull request.
- AI-assisted work is welcome. Document the process (design, plan, acceptance test) in `plans/`. Every contributor must understand every line they submit.
- Fix every sibling call site with the same problem in one pass, not only the one that was reported.
- Behaviour that already exists must stay identical. Schema fields are never reused with another type.

## Checks before opening a pull request

- Type-check every package you touched: `npx tsc --noEmit -p packages/<path>` (for example `packages/studio/core`, `packages/app/studio`).
- Run the tests of every package you touched: `npx turbo run test --filter=@opendaw/<package>` (for example `@opendaw/studio-core`). Turbo builds the dependencies first.
- After a change in `crates/`, also run `npx turbo run test:rust --filter=@opendaw/studio-core-wasm` (all Rust crates, cached while `crates/` is unchanged). Long render and fuzz tests run with `npm run test:slow -w @opendaw/studio-core-wasm`.
- After a box schema change in `packages/studio/forge-boxes`, run `npm run build`. It regenerates the boxes and the Rust registry in `crates/studio-boxes/src/registry.rs`, commit both.
