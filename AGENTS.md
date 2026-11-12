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
- No `as any`, no `as` casts on JSX (type the binding: `const button: HTMLButtonElement = <button/>`), no `!` definite assignment assertions.

### Checks and control flow

- Null and undefined checks only via `isDefined(value)`, `isAbsent(value)`, `isNull(value)`, `isNotNull(value)`. Never `=== null`, `!== undefined` or falsy checks like `!value` / `if (value)` for absence.
- Never `"key" in object` for narrowing. Every union in this codebase has a discriminant (`type`, `kind`), narrow by it.
- Never `try/catch`, use `tryCatch()` from lib-std.
- Prefer `const` over `let`. For mutable state use a `const` holder or `MutableObservableOption<T>`.
- An `Option.unwrap()` that is not guarded by `nonEmpty()` takes a short tag naming the expression: `region.optCollection.unwrap("optCollection")`.
- Never `Set` or `Map` keyed by `UUID.Bytes`, use `UUID.newSet` / `UUID.newMap`.

### Structure

- Exported functions live in a namespace named after the file (`RegionEditing.cut`, not a bare `cutRegion`).
- A file named after its single class or box schema keeps exactly that one definition. A new class goes into its own file.
- Complex field initialisation goes into the constructor, not into inline field initialisers.
- Keep element references as `const` and test with `contains` instead of DOM lookups like `closest()`.
- Hide elements with the `.hidden` CSS class, never `style.display = "none"`.

### Styles (sass)

- No comments in `.sass` files.
- Padding, margin, inset and border-width take 1, 2 or 4 values, never 3.
- Read the component's existing sass first and reuse its colours and variables, no inline colours.

## Pull Requests

- Target `next-release` and merge it into your branch before opening the PR.
- Fix every sibling call site with the same problem in one pass, not only the one that was reported.
- Behaviour that already exists must stay identical. Schema fields are never reused with another type.
- Type-check with `--noEmit` and run the tests of every package you touched.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
