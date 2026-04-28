# Chatter Language — Project Memory

## Persona
Always speak like Gambit from the X-Men. "Mon ami", "bon", "non", "oui", "de" for "the", etc.

## Project
Path: `/Users/jxbaker/dev/chatter`
Stack: TypeScript, Jest, Node. Scripts: `npm test`, `npm run build`, `npm run dev`.
CLI: `npx ts-node src/index.ts <file.chatter>` runs the full pipeline.

## Architecture (two-phase)
1. **Compiler**: lex → parse → emit bytecode
2. **VM**: stack-based interpreter

### Files
- `src/lexer.ts` — INDENT/DEDENT Python-style, skips `#` comments
- `src/ast.ts` — node types
- `src/parser.ts` — recursive descent
- `src/bytecode.ts` — Instruction union + BytecodeProgram
- `src/compiler.ts` — two-pass: collect signatures + outer bindings, then emit
- `src/vm.ts` — stack VM with per-frame `it`
- `src/cli.ts` — wires pipeline + runs
- `src/index.ts` — entry point
- `tests/` — jest tests (unit + golden)
- `tests/chatter/*.chatter` + `.expected` — golden integration tests
- `tests/golden.test.ts` — auto-discovers and runs all golden cases
- `examples/hello_world.chatter` — user-authored example

## Test status
709 tests passing (plus 1 intentionally-failing stdlib_trim_tab_lf_cr test tracked separately). Total: 710.

## Language spec (current)

### Syntax
- Line-oriented, verb-first statements.
- `#` comments (whole line or trailing).
- Python-style indentation for blocks (`function ... end`, `if ... end`).

### Types
- `number` = signed integer, safe range ±(2^53 − 1) = ±9_007_199_254_740_991. Overflow = runtime error. Number literals may use `_` as a digit separator (e.g. `10_000`, `1_000_000`); `_` is allowed only between digits, no doubles, no leading/trailing.
- `string` = double-quoted literals.
- `boolean` = `true` / `false`. Prints as literal `true`/`false`.
- `list of TYPE` — mutable, ordered, **reference-value** list of scalar elements (TYPE ∈ {number, string, boolean}). Assignment / argument passing / returning aliases the same underlying list (mutations visible via every reference).
- `readonly list of TYPE` — a **reference-capability marker** used *only* in parameter type annotations. Forbids mutation through that reference at compile time. Not stored at runtime. Cannot appear as a `constant`/`variable` annotation nor as a return type.
- Nested lists (`list of list of T`) are **not supported** (parse error).

### Statements
- `say expr (, expr)*` — prints one or more expressions space-separated on one line, terminated by newline. **Does NOT update `it`** (for debugging). Empty `say` or trailing comma = compile error. Single-arg form output is byte-identical to the old single-expression `say`. List literals stay greedy in `say` arg position — use parens to mix a list alongside other items: `say (list of 1, 2), "end"`.
- `constant NAME is expr` — immutable binding. Duplicate `constant` = compile error.
- `variable NAME is expr` — **mutable** binding. Initializer required. Type-locked at first assignment to whichever of {number, string, boolean} the value is. Same scoping rules as `constant` (function-local; no shadowing of outer bindings; no redeclaration at same level — including mixing `constant`/`variable`). Does NOT update `it`.
- `change NAME to expr` — reassigns an existing `variable`. Compile error if NAME is not a `variable` (e.g. a `constant`, param, loop var, or undeclared). Runtime error if the new value's type doesn't match the locked type (message mentions name + expected/got). Does NOT update `it`.
- Arithmetic sugar (all shorthand for `change NAME to NAME <op> EXPR`):
  - `add EXPR to NAME`
  - `subtract EXPR from NAME`
  - `multiply NAME by EXPR`
  - `divide NAME by EXPR`
  All require NAME to be a `variable` of locked type `number` (compile error if the type is statically known to be string or boolean; otherwise deferred to runtime arithmetic check). Do NOT update `it`.
- `function NAME [takes TYPE IDENT (LABEL TYPE IDENT)*] [returns TYPE] is ... end function` — function decl. `TYPE` is `number`, `boolean`, or `string`. Zero-arg functions omit `takes` entirely. First param is positional (no label). Each subsequent param is preceded by a **separator label** that is used at the call site; the param's **body name** (the IDENT) is what the body code refers to. `LABEL` may be any IDENT or any non-stop KEYWORD (e.g. `to`, `with`, `from`, `in` are valid labels; `is`, `end`, `if`, `and`, `takes`, `returns`, ... are not). Duplicate body names in the same function → compile error. Duplicate labels are allowed; at the call site, multiple args with the same label bind to the matching params **in declaration order**. The closing `end function` qualifier is **required** (bare `end` is a parse error).

  **Two kinds of function (determined by presence of `returns` clause):**
  - **Void** (no `returns`): body may use bare `return` (no expression) to exit early. `return EXPR` in a void function is a **compile error**. Call sites emit `DROP` after `CALL` — the call does **NOT** update `it`. A void function used in expression position (`constant x is greet`, `say greet`, `greet + 1`, etc.) is a **compile error**. Empty void body is legal.
  - **Typed** (`returns TYPE`): every execution path must end with an explicit `return EXPR` (compile-time path analysis; see below). `return` alone is a compile error. `return EXPR`: if EXPR's static type mismatches the declared type → compile error; if unknown → runtime `CHECK_TYPE` op is emitted. Call sites emit `STORE_IT` normally. Empty typed body or fall-through → compile error ("missing return").

  **Path-termination analyzer** (`statementTerminates` / `blockTerminates` in `compiler.ts`):
  - `return` terminates.
  - `if` with else terminates iff every branch (all `else if` + `else`) terminates; missing else never terminates.
  - `repeat` bodies never contribute termination (loop body may run zero times).
  - All other statements: not terminating.
- `return expr` / `return` — `return expr` in typed fns, bare `return` in void fns only. Multiple returns allowed.
- **`the result of CALL` sugar** — appears ONLY at the top of the RHS of these four host statements (not as an expression, never nested, never inside an arg position):
  - `constant NAME is the result of CALL` ≡ `CALL` (typed-call, updates `it`) followed by `constant NAME is it`.
  - `variable NAME is the result of CALL` ≡ same, then `variable NAME is it`. Type-locks NAME to CALL's declared return type.
  - `change NAME to the result of CALL` ≡ same, then `change NAME to it`. Compile error if NAME's locked type statically mismatches CALL's return type.
  - `return the result of CALL` ≡ same, then `return it`. CALL's return type must match the enclosing function's declared return type.
  CALL parses exactly like a normal call statement (function name, optional positional first arg, zero or more named args, terminated by newline). The function MUST be a known user-defined or imported function (primitives like `length` / `character` / `code` are not callable; missing IDENT after `of` produces a parse error). The function MUST be typed (have a `returns` clause) — calling a void function is a compile error: `'the result of' requires a typed function, but 'X' is void`. After the sugared line, `it` equals the call's return value (the host statement does NOT independently update `it`). The leading `the` is **optional** (`constant x is result of f arg` works the same as `constant x is the result of f arg`). `the` and `result` are NOT reserved keywords — detection is a contextual peek for `[the] result of` immediately after `to` / `is` / `return`. Implemented via an optional `precall: CallStatement | null` field on `ConstantDeclaration`, `VarDeclaration`, `ChangeStatement`, and `ReturnStatement`; when set, the compiler emits the call (+`STORE_IT`) before the host store/return.

- **Optional cosmetic `the` in front of any noun-phrase form.** Anywhere an expression of the shape `<word> ... of EXPR` appears (`length of`, `item N of`, `last item of`, `last character of`, `character N of`, `characters A to B of`, `lines of file`, `code of`, struct field access `FIELD of EXPR`), the parser accepts an optional leading `the` and silently drops it. So `the length of xs`, `the item 2 of xs`, `the X of point`, `the code of "A"`, etc. all parse identically to the bare form. `the` remains a contextual identifier (not a reserved keyword): `variable the is 99 / say the` still works. Inside an index slot (the EXPR in `item N of`, `character N of`, `characters A to B of`), the `the FIELD of EXPR` form is suppressed for the same reason field-access parsing is — to avoid stealing the `of`.
- `NAME firstArg LABEL1 val1 LABEL2 val2` — function call: first arg positional, rest selected by the declared separator labels.
- `if cond ... [else if cond ... ]* [else ...] end if` — the closing `end if` qualifier is **required** (bare `end` is a parse error).
- `repeat N times ... end [repeat]` — run body N times. N must be a number; N=0 = 0 iterations; N<0 = runtime error.
- `repeat with i from A to B ... end [repeat]` — inclusive range loop. `i` is block-scoped (mutable across iterations, invisible after loop). `i` cannot shadow outer bindings (compile error). `constant i is ...` inside body also a compile error (duplicate binding). If A > B, zero iterations.
- `repeat while cond ... end [repeat]` — pre-test while loop. `cond` must be a boolean (runtime error otherwise). Note: without mutable state, rarely useful for now.
- All three variants require `end repeat` as the closer (bare `end` is a parse error).
- `exit repeat` — immediately terminates the innermost enclosing `repeat` loop, transferring control to the statement immediately after `end repeat`. Compile error if used outside any `repeat` (including inside an `if` that is not inside a repeat, and inside a function body outside a loop). Valid inside `if` / `else` blocks nested inside a repeat. Always targets the innermost repeat. Works in all four loop forms.
- `next repeat` — skips to the next iteration of the innermost enclosing `repeat` loop. For `N times` / `with i from A to B` / `with x in LIST`: runs the loop's increment (counter / `i` by step / index) then re-checks the bound. For `while COND`: jumps straight back to re-evaluate the condition. Same scope rules as `exit repeat`. Bare `exit` / `next` without `repeat` is a parse error.
- `expect PREDICATE [, MSG_EXPR]` — assertion statement.
  - `PREDICATE` forms:
    - Any boolean expression: `expect c is a digit`, `expect n > 0 and n < 10` (via existing ops), `expect list contains 5`, etc.
    - `to be` sugar (standalone statement only — not an expression), equivalent to the matching `is`-form:
      - `expect X to be Y` ≡ `expect X is Y`
      - `expect X to not be Y` ≡ `expect X is not Y`
      - `expect X to be less than Y` / `to be greater than Y` / `to be at least Y` / `to be at most Y`
      - `expect X to be a digit` / `to be a letter` / `to be whitespace`
      - `expect X to be empty` / `to not be empty` (polymorphic over strings and lists)
      - `be` is NOT a reserved keyword; parsed contextually after `to` (or `to not`). `to` is already reserved.
  - Predicate must evaluate to boolean at runtime (`expect requires a boolean, got X` otherwise).
  - On failure without a message: throws `expect failed: <source-echo>` where `<source-echo>` is the original source text of the predicate (including the `to be` wording if that form was used).
  - **Optional message clause** `, MSG_EXPR`:
    - Comma is literal and required when present.
    - `MSG_EXPR` must evaluate to a string. Statically-known non-string → compile error (`expect message must be a string, got X`). Runtime non-string → `expect message must be a string, got X` runtime error.
    - **Lazy evaluation**: the message is evaluated ONLY when the predicate fails. On success it is not evaluated at all (so `expect true, character 100 of "hi"` never raises).
    - On failure with a message, the error is `expect failed: <msg>` — the author-provided string REPLACES the source-echo. The `expect failed:` prefix is unchanged.
  - `expect` does NOT update `it`.

### Expressions
- Arithmetic: `+ - * / ** mod`. Standard precedence: `**` > `*/ mod` > `+-`. `mod` is a keyword, same precedence as `*` and `/`, left-associative. **Floored-division modulo** (sign follows divisor, à la Python/Ruby). Result of `a mod b` (when `b > 0`) is always in `[0, b)`. Runtime error on `mod 0`.
- Equality: `is`, `is not` — value + type comparison. Type mismatch = runtime error (Path A). Lower precedence than arithmetic, higher than logical. (`==` and `!=` are **not** tokens; they cause a tokenisation error.)
- Comparison (numbers only, same precedence as `is`/`is not`):
  - `a is less than b` → `<`
  - `a is at most b` → `<=` (also spelled `a is less than or equal to b`)
  - `a is greater than b` → `>`
  - `a is at least b` → `>=` (also spelled `a is greater than or equal to b`)
  - Non-number operands → RuntimeError ("Type mismatch: comparison requires numbers"). Positive forms only (no `is not less than` etc. yet).
  - Reserved keywords added: `less`, `greater`, `than`, `at`, `least`, `most`.
- Logical: `not` (unary), `and`, `or`. Precedence: `is`/`is not` > `not` > `and`/`or`.
- Unary `-` on numbers: `-EXPR` is legal anywhere a primary is (literals, vars, expressions). Binds tighter than `**`, so `-2 ** 2 = 4` (i.e. `(-2) ** 2`). Operand must be `number` or compile error.
- **Hybrid paren rule** for `and`/`or`: same-operator chains fine; mixing `and` with `or` at same level = compile error ("parentheses required"). `(a and b) or c` is OK. Parens reset context.
- `it` — meta-syntactic var holding last statement's result. **Per-frame/function-scoped**. `say` does not touch it.
- Parenthesised expressions allowed everywhere.

### Scoping
- `constant` bindings are immutable; `variable` bindings are mutable but type-locked.
- **Lexical scoping.** A function body sees only: its own params/locals, and **module top-level** `constant`/`variable` bindings. It does NOT see locals of any caller frame. A reference to an unknown name is a compile error (`Undefined variable: 'X'`). `change`/sugar can only target `variable`s declared in the **same** function body.
- Param names **cannot shadow** outer bindings — compile error.
- `variable` **cannot shadow** outer bindings (inside a function) — compile error. Redeclaring a name already bound via `constant`/`variable` in the same scope — compile error.

### Keywords reserved for mutable vars
`variable`, `change`, `add`, `subtract`, `multiply`, `divide`, `by`

### Keywords reserved for loop control
`exit`, `next` (each only meaningful in the two-word sequences `exit repeat` / `next repeat`; bare `exit` / `next` is a parse error).

### Keywords reserved for lists
`list`, `of`, `readonly`, `empty`, `unique`, `item`, `last`, `length`, `contains`, `append`, `prepend`, `insert`, `in`, `remove`

### Keywords reserved for string operations
`character`, `characters` (new). `length`, `contains`, `last`, `of` are shared with lists.

### Keywords reserved for file I/O
`read`, `file`, `lines`. See "File I/O" below.

### Keywords reserved for modules
`use`, `from`, `export`. See "Modules (v1)" below. (`from` is also reused by the `subtract X from Y` form.)

### Modules (v1)
One file = one module. The file path (normalized absolute) identifies the module; the entry file passed to the `chatter` CLI is module #1 and may `use` and/or `export` just like any other module.

**Import**: `use NAME (, NAME)* from "PATH"` at the top of the file (before any other statement). After any non-`use`, non-blank, non-comment statement appears, further `use` statements are a compile error.
- `PATH` is always relative to the importing file's directory. Leading `./` and `../` are allowed.
- `.chatter` is implicitly appended — the user writes `from "math"`, the loader reads `math.chatter`.
- Path matching is case-sensitive.
- Missing file → compile error `cannot find module "PATH"` (uses the exact string the user wrote).

**Export**: `export` is an optional modifier on `function` declarations only (v1 does not export `constant`/`variable`/expressions). A non-exported function is private: usable within its own module, invisible to importers.

**Binding rules**:
- Imported names live in the importing module's top-level scope alongside local functions.
- `use X, X from "m"` (duplicate in one use) → compile error.
- Importing a name that collides with a local function or another imported name → compile error `name 'X' is already defined`.
- Importing a name the target module does not export → compile error `module "PATH" does not export 'X'` (same message whether the function doesn't exist at all or just isn't exported).

**Top-level side effects**: a module's non-function, non-`use` statements execute exactly once the first time the module is imported. Ordering is dependency post-order: dependencies' top-level code runs before any importer's. Subsequent imports are cached (no re-run).

**Circular imports**: detected at compile time. Error message is `circular import: A → B → A` showing the user-written path of each hop.

**`it` semantics**: top-level `it` is per-module-scope conceptually (each module's init runs as its own top-level). Imported functions still follow the existing per-frame `it` rule when called.

**Internals (non-user-visible)**:
- Each module is assigned a sequential id `m0`, `m1`, … (`m0` = entry).
- Function names are mangled to `<moduleId>::<name>` inside the emitted bytecode; imported names resolve to the defining module's mangled form. The VM only ever sees mangled names; compile and runtime errors still mention the user-facing unqualified name.
- Top-level `constant`/`variable` bindings are also mangled by module to prevent cross-module collision. At runtime the `LOAD` op consults only the current frame and the bottom frame (frame[0] = combined module top-level), enforcing lexical scope. Imported-function closures reach their home-module top-level bindings via the mangled name in frame[0].
- The combined `main` is the concatenation of every non-entry module's top-level instructions (in DFS post-order) followed by the entry's top-level. `JUMP`/`JUMP_IF_FALSE` targets are rewritten by the loader when blocks are concatenated. No new VM opcodes were needed.
- Loader lives in `src/moduleLoader.ts`; entry point `loadProgram(entryFilePath) → BytecodeProgram`. `CLI` calls `loadProgram`.

**Standard library imports (`std:` prefix)**: `use NAMES from "std:MODULENAME"` loads a bundled stdlib module.
- `MODULENAME` is a bare module name — no slashes, no `..`, no `.chatter` extension. Violations → compile error `invalid stdlib import "std:..."` (with a per-rule reason).
- The default stdlib directory is resolved as `path.resolve(__dirname, '..', 'stdlib')` relative to `src/moduleLoader.ts`. In dev that's `<repo>/stdlib/`; when installed as a package, `stdlib/` ships as a sibling of `dist/` (listed in `package.json` `files`). Missing module file → standard `cannot find module "std:NAME"` error.
- `loadProgram(entryPath, { stdlibDir })` accepts an override for tests.
- Stdlib modules participate in the same module graph (cycle detection, export checks, mangling). Relative `use` from inside a stdlib module resolves against the stdlib file's own directory. Stdlib modules are keyed in the loader's registry by the synthetic string `std:<NAME>` rather than their absolute filesystem path; because `std:` cannot appear in an absolute path, collisions with a coincidentally-named user file are impossible.
- Placeholder module lives at `stdlib/placeholder.chatter` as proof-of-life. Real stdlib modules: `stdlib/strings.chatter` (e.g. `parse`), `stdlib/math.chatter` (`min`, `max`).

**Not in v1 (deferred)**: `use X as Y` renaming, exporting `constant`/`variable`, package-style paths (no `./` or `../`), re-exports, dynamic imports, circular imports with partial-module semantics.

### File I/O (read-only, v1)
- **`lines of file EXPR`** — expression form. `EXPR` must be `string` (compile error otherwise). Returns a fresh **mutable** `list of string`. Line-splitting: any `\n` or `\r\n` is a separator; exactly one trailing newline is stripped (so `"a\nb\n"` → `["a", "b"]`). Empty file → empty list. Leading/internal blank lines are preserved as empty strings.
- **`read file EXPR`** — statement form, sugar for `constant it is lines of file EXPR`. Updates `it` with the same list. Does NOT introduce a named binding.
- **Path resolution**: relative paths are resolved against `process.cwd()` at runtime (where the `chatter` CLI was invoked). Absolute paths work normally.
- **Errors**: file not found, permission denied, etc. surface as runtime error `"could not read file '<path>': <code-or-message>"`.
- **Writing files** is future work.

### Strings (v1: tiers 1+2, plus char primitives)
- **Concat** `&` — binary OP, **lower precedence than `+`/`-`** (own level between equality and additive), left-assoc. Both sides coerced to string (`String(n)` for numbers, `"true"`/`"false"` for booleans, `say`-style `[...]` formatter for lists). Always returns string. Never a type error. Example: `"x=" & 1 + 2` → `"x=3"` because `+` binds tighter than `&`.
- **`length of S`** — polymorphic with list; returns character count.
- **`S is empty`** / **`S is not empty`** — polymorphic with list; true iff `length of S` equals 0 (respectively > 0). Compile error when `S` is statically known to be non-string and non-list; runtime error ("'is empty' requires a string or list, got X") when the static type is unknown and the value is neither. Does NOT update `it`.
- **`S contains T`** — polymorphic with list; both sides must be strings (enforced statically when LHS type is known-string; runtime error otherwise). `""` contains `""` → true.
- **`character N of S`** — 1-indexed char access; OOB/non-string/non-number → runtime error. `N` may use the `end` index sentinel (see below).
- **`characters A to B of S`** — inclusive substring. `A > B` → `""`. `A < 1` or `B > length` → runtime error. Both `A` and `B` may use the `end` index sentinel (see below).
- **`last character of S`** — sugar (parses to a dedicated AST node). Empty string → runtime error. Uses a compiler temp to avoid double-evaluating the target (parallel with `last item of`). (Note: there is no `first character of` sugar — use `character 1 of S` instead. `first` is an ordinary identifier.)
- **Character primitives (Phase 1)**:
  - **`code of S`** — expression form. Returns the Unicode code point (0..0x10FFFF) of a single-code-point string. Runtime error on empty or multi-code-point strings. `code` is **not** a reserved keyword — parsed contextually when followed by `of`; any existing user variable named `code` still works (e.g. `constant code is 5` / `say code`). Compile error when `S` is statically non-string. Does NOT update `it`.
  - **`character of N`** — expression form (parallel to the existing `character N of S`; disambiguated by `of` coming immediately after `character`). Returns a one-code-point string built from code point `N`. Runtime error on non-integer, negative, `> 0x10FFFF`, or surrogate halves `0xD800..0xDFFF`. Compile error when `N` is statically non-number. Does NOT update `it`.
  - **Char-class predicates** (infix at `is` precedence):
    - `S is a digit` — true iff `S` is a single-code-point string whose code point is in `'0'..'9'` (0x30..0x39).
    - `S is a letter` — true iff single-code-point string in `'A'..'Z'` or `'a'..'z'`.
    - `S is whitespace` — true iff single-code-point string equal to space (0x20), tab (0x09), LF (0x0A), or CR (0x0D).
    - Runtime error on empty or multi-code-point `S`; compile error when statically non-string.
    - `a`, `digit`, `letter`, `whitespace` are **not** reserved; parsed contextually after `is` / `is a`. These are boolean expressions and do not update `it`.
- **Static checks**: `character/characters/last character of X` with statically-known non-string `X` → compile error. `contains` with string LHS + non-string RHS (static) → compile error.

### `end` index sentinel
Inside the **index slot** of `character N of S`, `characters A to B of S`, and `item N of L`, the bare identifier `end` is sugar for "length of the target" (the value to the right of `of`). It participates in arithmetic like a normal number: `character end - 1 of S`, `characters end - 2 to end of S`, `item end of L`, `character end / 2 of S`, etc.

Scoping: `end` is lexically bound to the **nearest enclosing index slot's target**. So in `character end of (characters 1 to end of s)` the outer `end` is the length of the (already-computed) substring, the inner `end` is the length of `s`. Each index slot gets its own scope.

Evaluation: the target is evaluated exactly once per indexable expression; the length is computed once and reused for every `end` occurrence in that index slot (compiler-emitted temp, parallel with `last item of` / `last character of`).

Shadowing: inside an index slot `end` is **always** the sentinel — it does not resolve to any user binding. Outside an index slot, `end` remains a reserved keyword (block terminator) and does not name a value.

Errors: `end` outside an index slot → parse error (reserved keyword, unchanged from before the feature). Arithmetic with `end` that produces an out-of-range index → the same runtime "Index out of range" error as a literal OOB index.
- **`&` is the only new OP token.** Lexer change: `+-*/&`.

### Lists (v1)
- **Literals**: `list of EXPR (, EXPR)*` (nonempty, at least one element) — element type inferred/checked; `empty list of TYPE` (element type required).
- **Read ops (expressions)**:
  - `item N of L` — 1-indexed access; OOB / non-list / non-number index → runtime error. `N` may use the `end` index sentinel (see below).
  - `last item of L` — sugar for `item (length) of L`; empty → runtime error. (No `first item of L` sugar — use `item 1 of L`.)
  - `length of L` — returns number.
  - `L is empty` / `L is not empty` — polymorphic with string; same semantics (and same compile/runtime checks) as the string form.
  - `L contains V` — binary predicate at equality precedence (same level as `is`); left-associative.
  - `of` on the right-hand side binds tight — `item 3 of L + 1` means `(item 3 of L) + 1`.
- **Mutation statements** (all forbid readonly targets; emit compile error for non-list / non-existent bindings):
  - `append EXPR to NAME`
  - `prepend EXPR to NAME`
  - `insert EXPR at EXPR in NAME` (position 1..length+1; length+1 == append)
  - `remove item EXPR from NAME`
  - `change item EXPR of NAME to EXPR`
  - Element type mismatches: compile error when statically known; else runtime error. None update `it`.
- **Iteration**: `repeat with x in L ... end [repeat]` — block-scoped, read-only per iteration; `change x to ...` → compile error; empty list → zero iterations. Implemented as an index-based desugared loop (LENGTH + LIST_GET) using `_rep_list_*`, `_rep_idx_*`, `_rep_len_*` temps.
- **Reference semantics**: lists are references. `constant b is a` aliases. Passing to a function aliases. Mutating through any alias is visible through all.
- **Readonly rules** (compile-time only, never stored at runtime):
  - `readonly list of T` is only valid in param annotations.
  - Inside a function body, any of the 5 mutations targeting a readonly param → compile error.
  - `constant x is readonly_param` / `variable x is readonly_param` / `change v to readonly_param` → compile error ("cannot bind a readonly-list reference").
  - `return readonly_param` from a typed function → compile error. Return types cannot be `readonly list of T` (parse error).
  - **Call-site matching**: `list of T` arg widens to `readonly list of T` param (OK). `readonly list of T` → `list of T` param rejected (compile error). Element type must match exactly.
- **Internal type representation**: `ChatterType = {kind:'scalar', name} | {kind:'list', element, readonly} | {kind:'uniqueList', element, readonly:false}`. Used uniformly in bindings, signatures, param/return annotations, staticType. AST types: `TypeAnnotation` (same shape minus `kind`) for `FunctionParam.paramType` and `FunctionDeclaration.returnType`.

### Unique lists (v1)
A **unique list** is a "set" data structure (no duplicate values) spelled `unique list of T` to avoid the keyword clash with the `constant` binding form. Like lists, unique lists are mutable references; like sets, they enforce uniqueness via value equality and offer no random access. Element type `T` ∈ {`number`, `string`, `boolean`}. Insertion order is always preserved (iteration yields elements in the order they were first added).

- **Literals**:
  - `unique list of EXPR (, EXPR)*` — nonempty literal. Duplicate values in the literal are **silently dropped at creation time**, preserving the position of the first occurrence (so `unique list of 1, 2, 1, 3, 2` becomes `[1, 2, 3]`).
  - `empty unique list of T` — empty literal; element type required.
- **Type annotation**: `unique list of T` is allowed in parameter type annotations and as the return type of typed functions. **`readonly unique list of T` is not supported in v1** (parse error).
- **Read ops (expressions)** — all polymorphic with `list` and (where noted) `string`:
  - `length of S` — returns count.
  - `S is empty` / `S is not empty` — polymorphic with string/list.
  - `S contains V` — element type must match. **O(1)** for unique lists (hash lookup); linear for plain lists / strings.
  - `repeat with x in S ... end repeat` — iterates in insertion order; same scoping rules as list iteration.
  - **No random access**: `item N of S`, `last item of S`, `change item N of S to V` all → compile error mentioning "random access".
- **Mutation statements**:
  - `add EXPR to NAME` — adds `EXPR` if not already present (value equality). **No-op if present.** Element-type mismatch is a compile error when statically known; runtime error otherwise. Targeting a `list` binding with `add` → compile error pointing at `append` / `prepend` / `insert at`.
  - `remove EXPR from NAME` — removes `EXPR` by value. **No-op if absent (no error).** Element-type mismatch is a compile error / runtime error like `add`. Targeting a `list` binding with `remove EXPR from …` → compile error pointing at `remove item N from NAME`.
  - The list-only mutations (`append`, `prepend`, `insert at`, `change item N of`) targeting a unique list → compile error mentioning unique list.
  - Neither `add` nor `remove EXPR from …` updates `it`.
  - Both work on any binding kind (`constant`, `variable`, `param`) — the underlying unique list is mutable through aliases just like a regular list.
- **Equality** (`is` / `is not`) — extends to unique lists:
  - **unique list ↔ unique list**: equal iff same element type, same size, every element of one is contained in the other (order-independent set equality).
  - **unique list ↔ list** (either direction): equal iff same element type, same size, same elements **in same insertion / index order** (intersection of list and unique-list semantics).
  - **list ↔ list**: unchanged (reference equality).
  - Mismatched element types between aggregates → static compile error.
- **Type compatibility**: `unique list of T` and `list of T` are **distinct kinds**. A `list of T` arg cannot be passed to a `unique list of T` param (compile error), and vice versa. Returning the wrong kind from a typed function → compile error.
- **Reference semantics & aliasing**: identical to `list` — `constant b is a`, function-arg passing, and storing in another binding all alias the same underlying `items` array. Mutations through any alias are visible everywhere.
- **Iteration during mutation**: undefined behavior (same as list).
- **Formatting**: `say uniqueList` and `uniqueList & "..."` use the same `[1, 2, 3]` formatter as list. Users introspect via `length`, `contains`, and iteration.
- **Static type checker**: arithmetic / comparison / logical / `not` / `if` / `while` / bare-`expect` operands of known unique-list type → compile error (parallel to existing list checks).
- **Internal**: `ChatterUniqueList = { kind:'uniqueList'; element; items: Map<string, ChatterValue>; _iterCache?: ChatterValue[] }`. Uniqueness enforced via a canonical-key hash (O(1) `add` / `remove` / `contains`). Map insertion order is preserved by the JS spec, so iteration order remains "first-add-wins". A lazy `_iterCache` materializes values into an indexed array for `LIST_GET`-based iteration; mutations clear the cache. Var type-locking records `uniqueList:T` (parallel to `list:T`).

### Structs (v1)
Plain-old-data aggregates: named fields, no methods, **immutable** (copy-on-update via `with`).

**Declaration**:
```
struct Point
    number x
    number y
end struct
```
- Body is an indented block of `TYPE FIELDNAME` lines (struct fields use the same type annotation grammar as params, including `list of T`, `unique list of T`, and other structs).
- At least one field is required (`ERROR: must have at least one field`). Duplicate field names → compile error. Empty body (no INDENT) is permitted by the parser but rejected by the compiler.
- `export struct Name ... end struct` exports the struct (parallel to `export function`).
- Forward references are allowed within a module: `struct Outer` may reference a `struct Inner` declared later in the same file.
- Self- and mutually-recursive struct types are rejected: `ERROR: circular struct: A → B → A` (DFS through both `struct` field types and `struct:` elements inside list/uniqueList fields).

**Type annotations**: a struct is referenced by its bare name in any type position (param, return, struct field, list element). Both `Point` and `struct Point` parse as the same struct reference.

**Construction** — `make NAME with FIELD VALUE (, FIELD VALUE)*`:
- Every declared field must be provided exactly once. Missing → `make X missing field 'F'`. Unknown field → `struct 'X' has no field 'F'`. Duplicate → `duplicate field 'F' in make X`.
- Values are statically type-checked when knowable.
- Greedy parse: comma-separated pairs are part of the same `make`. Without a comma, the parser closes the make and applies any further `with` as a postfix update on the result.

**Field access** — `FIELD of EXPR` (e.g. `x of p`). Parsed contextually when an `IDENT of EXPR` appears outside an indexing slot. Unknown field on a known-struct target → compile error.

**Update sugar** — `EXPR with FIELD VALUE (, FIELD VALUE)*` returns a fresh struct copy with the listed fields replaced. Original value is unchanged. Unknown field, type mismatch, or duplicate update field → compile error. `with` on a known-non-struct LHS → compile error.

**Equality**: same-struct compare → field-by-field equality (recursively, struct/list/scalar). Cross-struct compare known statically → compile error (`Type mismatch: cannot compare struct A and struct B`). Cross-type runtime compare → runtime `Type mismatch`.

**Display / `say` / `&` concat**: format is `Type(F: V, F: V, …)`. String fields are quoted (`"..."`), numbers/booleans bare, nested lists/structs recursively formatted. Same formatter used by `say` and string concat (`&`).

**Operators that reject structs (statically when possible)**:
- Arithmetic (`+ - * / ** mod`) → CE `arithmetic requires numbers, got struct X`.
- Comparison (`<`, `<=`, `>`, `>=`) → CE `comparison requires numbers, got struct X`.
- Logical (`and`/`or`/`not`) → CE.
- `if` / `while` / `expect` predicate → CE.
- `is empty` / `length of` / `contains` → CE (struct is neither a string nor a list).

**In collections**: `list of P`, `unique list of P`, `readonly list of P` all work. Unique-list dedup uses recursive struct equality. Iteration (`repeat with x in ps`) binds `x` to a value of struct type so field access works inside the body.

**Modules**: `export struct` makes a struct available to importers. Importing an unexported struct → `module "PATH" does not export 'X'`. Imports use the same `use Name from "..."` form for both functions and structs (resolved by what the dep exports).

**Internal representation**: structs carry a mangled type name `<moduleId>::<Name>`. The compiler emits the mangled form in `MAKE_STRUCT { typeName, fieldNames }`; the VM stores fields as an insertion-ordered list of `[name, value]` pairs (`ChatterStruct`). List/uniqueList element types of struct kind are encoded as the string `"struct:<moduleId>::<Name>"` in bytecode metadata. The `formatValue` printer un-mangles for display.

**Bytecode ops** (already documented in "Bytecode instructions" below): `MAKE_STRUCT`, `STRUCT_GET`, `STRUCT_WITH`. Equality is handled by the existing polymorphic `EQ`/`NEQ` ops via `aggregateEquals`.

**Out of scope (v2+)**: methods/dispatch, pattern matching/destructuring, optional fields/defaults, anonymous struct literals, mutation, recursive struct types (would require nullable/option types).

### Compile-time vs runtime checks
- **Compile-time**: readonly enforcement, call-site arg/param type matching, readonly smuggling prevention, return-type matching (scalar and list kind/element/readonly), type-locked `variable` changes, mixed-type-literal detection (when all types known), append/prepend/insert/change-item element-type static checks, nested-list rejection.
- **Compile-time (operator/control-flow type checks, when operand types are statically known)**:
  - Arithmetic (`+`, `-`, `*`, `/`, `**`, `mod`) — both operands must be `number`. Known non-number → `Type mismatch: arithmetic requires numbers, got X`.
  - Unary minus `-X` — `X` must be `number`.
  - Logical `not X` — `X` must be `boolean`.
  - Logical `and` / `or` — both operands must be `boolean`. Known non-boolean → `Type mismatch: 'and' requires booleans, got X` (likewise `or`).
  - Equality `is` / `is not` — when **both** sides have known static types, they must be compatible (same scalar name, or both `list of T` with the same element type). Otherwise → `Type mismatch: cannot compare X and Y`.
  - Comparison `is less than` / `is at most` / `is greater than` / `is at least` — both operands must be `number`. Known non-number → `Type mismatch: comparison requires numbers, got X`.
  - `if` / `else if` condition — must be `boolean`.
  - `repeat while COND` — `COND` must be `boolean`.
  - `repeat N times` — `N` must be `number`. Literal-negative `N` (a `NumberLiteral` with negative value, or `-NumberLiteral`) → `repeat count cannot be negative, got -K`.
  - `expect PREDICATE` (bare form) — predicate must be `boolean` when statically known.
  - **Pass-through rule**: when an operand's static type is unknown (most commonly `it`, an identifier whose binding type is unknown, a function-call result without a return type, or any expression `staticType` returns `null` for), the compile check is **skipped** and the existing runtime check still applies. No false positives.
  - `&` (string concat) is **never** type-checked statically — it always succeeds at runtime by coercing to string.
- **Runtime**: list OOB (get/set/insert/remove), non-list targets when static type is unknown, wrong-type elements when compile-time type couldn't verify, empty `last item`/`last character`, non-number index, all of the above operator/control-flow checks when at least one operand's static type is unknown.

## Keyword `takes` / `returns`
`takes` is reserved and introduces the parameter list of a function declaration. `returns` is reserved and introduces the return-type clause (before `is`). Both are "stop keywords" — they cannot be used as a named-argument label or parameter separator label.

## Bytecode instructions
`PUSH_INT`, `PUSH_STR`, `PUSH_BOOL`, `LOAD`, `STORE`, `STORE_VAR`, `DELETE`, `LOAD_IT`, `STORE_IT`,
`ADD`, `SUB`, `MUL`, `DIV`, `POW`,
`EQ`, `NEQ`, `LT`, `LE`, `GT`, `GE`, `NOT`, `AND`, `OR`,
`JUMP`, `JUMP_IF_FALSE`,
`CALL` (name, argCount), `RETURN`, `SAY`, `SAY_MULTI` (count),
`DROP` — pops and discards stack top; emitted after `CALL` at **void-function call sites** (void fns still emit a trailing `PUSH_INT 0; RETURN` so the stack stays balanced; caller discards it and does NOT update `it`).
`CHECK_TYPE` (expected, context) — peeks the stack top and throws `RuntimeError("Type mismatch: <context> (expected X, got Y)")` when the type doesn't match. Emitted in typed-function `return EXPR` when the expression's static type is unknown.
`ERROR` (message) — throws a RuntimeError with the given message; used by the compiler to emit runtime-check branches (e.g., negative `repeat` count).
`EXPECT` (source) — pops a value; if not boolean, throws "expect requires a boolean, got X"; if false, throws "expect failed: <source>". Used for the bare-form `expect PREDICATE` with no message clause.
`EXPECT_BOOL_CHECK` — peeks the stack top; throws "expect requires a boolean, got X" if not boolean. Stack unchanged. Used as a type guard for the message-form of expect before `JUMP_IF_FALSE` branches on the value.
`EXPECT_FAIL_WITH_MSG` — pops a string; throws "expect failed: <string>". Throws "expect message must be a string, got X" if not a string. Emitted only on the failure branch of `expect PREDICATE, MSG_EXPR`.
`DELETE` — removes a local from the current frame; used to scope loop variables.
`LT` / `LE` / `GT` / `GE` — numeric comparison; RuntimeError on non-numbers.
`STORE_VAR` — type-locked store for mutable `variable` bindings. On first store in a frame it records the value's type (number/string/boolean/`list:<element>`); on subsequent stores (from `change` or the arithmetic sugar) it checks the value's type matches the locked type and throws a RuntimeError if not. Each call frame has its own varTypes map, so recursive calls re-lock per invocation.

### List / string bytecode ops
- `MAKE_LIST { count, elementType: 'number'|'string'|'boolean'|null }` — pops `count` values (order-preserving), pushes a new `ChatterList`. `elementType=null` means infer from the first element; all others must match. Used for nonempty list literals.
- `MAKE_EMPTY_LIST { elementType }` — push a fresh empty list with explicit element type.
- `MAKE_UNIQUE_LIST { count, elementType }` — pops `count` values, dedupes preserving insertion order (silent), pushes a new `ChatterUniqueList`. Used for nonempty unique-list literals.
- `MAKE_EMPTY_UNIQUE_LIST { elementType }` — push a fresh empty unique list with explicit element type.
- `UNIQUE_LIST_ADD` — pop value, pop unique list, add the value if not already present (O(1) hashed by canonical key); element-type check.
- `UNIQUE_LIST_REMOVE` — pop value, pop unique list, remove the value if present (linear scan, no-op if absent); element-type check.
- `LIST_GET` — pop index, pop list, push element (1-indexed). Errors: non-list, non-number index, OOB.
- `LIST_SET` — pop value, pop index, pop list, mutate element in place (1-indexed). Element-type check.
- `LENGTH` — pop value, push number. Polymorphic: works on list (items.length) or string (character count). Other types → runtime error.
- `CONTAINS` — pop rhs, pop lhs, push boolean. Polymorphic: lhs string → JS `.includes` (rhs must be string, else runtime error); lhs list → existing element-type check + linear search.
- `CONCAT` — pop b, pop a; coerce each to string (numbers via `String()`, booleans to `"true"`/`"false"`, lists via the same formatter `say` uses); push concatenation. Always succeeds — never a type error.
- `STR_CHAR_AT` — pop index, pop string, push 1-char string. 1-indexed. Errors: non-string, non-number, OOB.
- `STR_SUBSTRING` — pop `to`, pop `from`, pop string, push inclusive substring `s.substring(from-1, to)`. If `from > to` → empty string. Errors: non-string, non-number bounds, `from < 1`, or `to > length`.
- `LIST_APPEND` — pop value, pop list, push/mutate (element-type check).
- `LIST_PREPEND` — pop value, pop list, unshift.
- `LIST_INSERT` — pop value, pop index, pop list, splice-in at 1-indexed position (valid range 1..length+1).
- `LIST_REMOVE` — pop index, pop list, splice-out at 1-indexed position.
- `READ_FILE_LINES` — pop path string, read file (CWD-relative, utf-8), split on `\n` / `\r\n`, strip exactly one trailing newline, push a fresh mutable `list of string`. Empty file → `[]`. Errors: non-string path, any `fs.readFileSync` failure (`could not read file '<path>': <code>`).
- `CHAR_CODE` — pop string, push Unicode code point (number). Errors: non-string, empty, or more than one code point (`code of requires a single character, got "..."`).
- `CHAR_FROM_CODE` — pop number, push one-code-point string via `String.fromCodePoint`. Errors: non-number, non-integer, `< 0` or `> 0x10FFFF`, or in surrogate range `0xD800..0xDFFF`.
- `IS_DIGIT` / `IS_LETTER` / `IS_WHITESPACE` — pop string, push boolean. Ranges are ASCII-only: `0-9`, `A-Za-z`, and `{space, tab, LF, CR}` respectively. Errors: non-string, empty, or multi-code-point (same check as `CHAR_CODE`).
- `IS_EMPTY` — pop string or list, push boolean (`length === 0`). Runtime error on any other type (`Type mismatch: 'is empty' requires a string or list, got X`).

`ChatterValue = number | string | boolean | ChatterList`, where `ChatterList = { kind:'list'; element; items: ChatterValue[] }`. Readonly-ness is **never** stored at runtime — it's purely a compile-time property.

### Iteration compilation strategy
`repeat with x in L` is desugared by the compiler into an index-based `while`-style loop:
```
<L>; STORE listTmp
LOAD listTmp; LENGTH; STORE lenTmp
PUSH 1; STORE idxTmp
top:
  LOAD idxTmp; LOAD lenTmp; LE
  JUMP_IF_FALSE end
  LOAD listTmp; LOAD idxTmp; LIST_GET; STORE x
  <body>
  LOAD idxTmp; PUSH 1; ADD; STORE idxTmp
  JUMP top
end:
DELETE x, listTmp, idxTmp, lenTmp
```
(No dedicated `LIST_ITER_*` bytecode. Modifying `L` during iteration is undefined.)

## Testing methodology
**Golden file tests** (`tests/chatter/*.{chatter,expected}`):
- `<name>.expected` = exact stdout OR first line `ERROR: <substring>` for compile/runtime error expectations.
- Runner: `tests/golden.test.ts` auto-discovers all pairs and runs pipeline.
- **Add a new test case = drop two files.** No TS boilerplate.

Existing golden cases:
- `hello_world`, `arithmetic`, `set_bindings`, `functions`, `it_scoping`
- `divide_by_zero`, `duplicate_set`, `integer_overflow`
- `conditionals`, `mixed_logic_no_parens`, `eq_type_mismatch`, `it_after_print`
- `natural_equality`, `natural_else_if`, `end_qualifiers` — showcase new natural syntax
- `removed_double_equals`, `removed_print`, `removed_elif` — error cases for removed syntax
- `repeat_times`, `repeat_range`, `repeat_while`, `repeat_nested`, `repeat_in_function` — positive cases for loops
- `repeat_negative_count`, `repeat_shadowing`, `repeat_loop_var_scoped`, `repeat_while_non_boolean` — loop error cases
- `comparisons`, `comparison_in_logic`, `comparison_with_arithmetic` — natural comparison operators (`is less than`, `is at most`, `is greater than`, `is at least`)
- `comparison_type_mismatch`, `comparison_reserved_word`, `comparison_is_at_typo` — comparison error cases
- `var_basic`, `var_change`, `var_sugar_add`, `var_sugar_subtract`, `var_sugar_multiply`, `var_sugar_divide`, `var_factorial`, `var_mutate_in_if`, `var_mutate_in_loop` — mutable var positive cases (includes iterative factorial)
- `var_type_lock`, `var_redeclare_set`, `var_redeclare_var`, `var_change_set`, `var_change_undeclared`, `var_sugar_on_string` — mutable var error cases
- `takes_zero_arg`, `takes_one_arg`, `takes_multi_arg_distinct_names`, `takes_duplicate_label`, `takes_nested_call` — `takes` form positive cases
- `takes_duplicate_body_name`, `takes_stop_keyword_label`, `takes_paren_form_rejected` — `takes` form error cases
- `returns_void_basic`, `returns_void_it_unchanged`, `returns_typed_basic`, `returns_typed_it_updated`, `returns_typed_if_else_both_return` — return-type positive cases
- `returns_void_cannot_be_value`, `returns_void_with_value`, `returns_typed_missing_return`, `returns_typed_bare_return`, `returns_typed_if_missing_else`, `returns_typed_wrong_type_static`, `returns_typed_wrong_type_runtime` — return-type error cases
- `list_literal_basic`, `list_empty`, `list_append_basic`, `list_prepend_basic`, `list_insert_middle`, `list_insert_append_position`, `list_remove_basic`, `list_change_item`, `list_contains_true`, `list_contains_false`, `list_iteration`, `list_iteration_empty`, `list_mutation_via_alias`, `list_pass_mutable_to_function`, `list_call_widening`, `list_returns_type`, `list_factorial_style` — list positive cases
- `list_wrong_element_type_static`, `list_nested_rejected`, `list_item_oob`, `list_first_last_empty`, `list_insert_oob`, `list_remove_oob`, `list_change_item_wrong_type`, `list_iteration_change_x`, `list_pass_readonly_param`, `list_call_narrowing_rejected` — list error cases

## Design decisions made
- **Path A** for equality type-checking: runtime error on type mismatch. Plan **Path C** (full static type checker) later.
- **Hybrid paren rule** for `and`/`or` mixing (not standard precedence).
- `print` does NOT update `it` — user wants this for debugging. (`print` was renamed to `say`.)
- `it` is function-scoped (separate per frame).
- `constant` is strictly immutable (constants really).
- No shadowing of any kind.
- Booleans strict: `if 5` is runtime error, not truthiness.
- `and`/`or` are strict (eager) not short-circuit. Both sides always evaluated.

## User preferences
- Prefers explicit over clever (e.g. parens over precedence memorization for mixing).
- Always asks clarifying questions before building; expects ask_user/targeted questions in conversation when specs are ambiguous.
- Iterative: each feature round = spec Q&A → build via sub-agent → verify tests.
- **Always commit after completing work.** Don't wait to be asked.

## Workflow pattern (important)
1. User describes new feature with example `.chatter` file.
2. I ask targeted clarifying questions (one block at a time, wait for answers).
3. When spec is fully clear, I summarize and delegate implementation to a `general-purpose` background agent with a comprehensive prompt.
4. Agent builds + tests; I verify all tests pass afterward.

## Open items / roadmap

### Explicitly queued
- **Path C**: static type checker. Would catch `5 is "hello"` at compile time, validate param types, etc. Currently Path A (runtime checks). Deferred.
- **Fractional numbers**: planned. `number` is currently integer-only (safe range ±(2^53 − 1)).
- **Loop extensions (deferred)**: reverse direction (`down to`), `repeat until cond`. Base `repeat` loops (times / range / while / with-in) and the `by STEP` clause on range-form are implemented; early exit (`exit repeat` / `next repeat`) is implemented.
- **Chatter-native test framework**: write tests in Chatter (`assert x is 10`) once assertions exist.
- **Maps**: independent built-in key-value type. Mutable. Also need a read-only variant.
- **Sets**: delivered as `unique list of T` (see "Unique lists (v1)" above). A readonly variant is not yet supported.
- **Writing files**: companion to `lines of file` / `read file`. Likely `write LIST to file PATH` and/or `write STRING to file PATH`. Questions for later: overwrite vs append, auto-add trailing newline on line lists, create parent dirs or error?

### Natural follow-ups
- **String operations (tier 3/4 deferred)**: case transforms (`uppercase/lowercase of`), trim, split/join, replace, index-of, starts-with/ends-with. Tiers 1+2 (concat `&`, `length of`, `contains`, `character N of`, `characters A to B of`, `last character of`) are **implemented**.
- **More HyperTalk naturalizations** (if desired): `put X into Y`, word-form arithmetic (`plus`, `times`), `to the power of`. (Function-decl `takes` form and `mod` are implemented; negative literals / unary `-` are implemented.)
- **String escape sequences**: `\"`, `\n` etc.

### Quality of life
- Better error messages (line/col + source snippet).
- **Cross-module error reports with source caret.** Currently when a runtime error fires inside an imported module (e.g. `std:strings`), `formatError` shows the right filename + line:col but skips the source-line caret because it only has access to the entry file's source. Full fix: thread per-module sources into the formatter (e.g. via a `sources: Map<filename, string>` argument) and render the caret using the appropriate source. The plumbing for `loc.file` already exists.
- **F2 (Rename Symbol) support in `vscode-chatter`.** Today the extension is declarative-only (TextMate grammar + language-configuration). To enable rename:
  - **Phase 1 — single-file local rename (MVP).**
    - Build a `resolveSymbol(source, line, col) → { defLoc, refLocs[], kind, isRenameable, reason? }` API in `src/` (probably new file `src/resolver.ts`). Walks the AST scope tree the same way the compiler does (function body, `repeat with i / x in L` loop body, if/else blocks).
    - Covers: `constant`, `variable`, function parameters, loop variables (`repeat with i`, `repeat with x in L`).
    - Convert `vscode-chatter/` from declarative to a TS extension: `package.json` adds `main: ./out/extension.js`, build script, tsconfig; `src/extension.ts` registers `vscode.languages.registerRenameProvider`.
    - `prepareRename` validates the cursor is on a renameable local; `provideRenameEdits` returns a `WorkspaceEdit` against the current document only.
    - Bundle de compiled parser/resolver — easiest path is to publish `chatter-lang` as a workspace-local npm dep of de extension and re-export the resolver from `dist/`.
    - Validate `newName`: must be a valid IDENT, must not be a reserved keyword (reuse the lexer's KEYWORDS set), must not collide with another binding visible in the same scope.
    - Refuse (with a clear message) for anything outside Phase 1 scope.
  - **Phase 2 — module-scope locals.**
    - Top-level `constant`/`variable` bindings (within one file).
    - Non-exported function declarations (within one file).
    - Same single-file scope, larger surface area.
  - **Phase 3 — workspace-wide rename.**
    - Exported functions: walk every `.chatter` file in the workspace, parse each, follow `use` graphs, and update every `use NAME from "..."` clause + every call site that resolves to the exported function.
    - `use NAME from "..."` import (which in v1 must match the exported name): renaming this is equivalent to renaming the export — handle as one operation that also renames inside the source module.
    - **Hard refusal**: any chain of refs that touches a `std:` module → block rename with "cannot rename names defined in stdlib".
    - File-level renames (`.chatter` filename change → update every `from "..."` string) — usually delivered by VS Code's `onWillRenameFiles` rather dan F2. Sibling work.
  - **Required language plumbing dat doesn't exist yet:**
    - `IdentifierExpression` already carries line/col/length ✓.
    - But binding sites (`ConstantDeclaration.name`, `VarDeclaration.name`, `FunctionParam.name`, repeat-with loop-var, `UseStatement.names[i]` already has `nameLocs[]`, `FunctionDeclaration.name`) need locations on de **name token specifically**, not just de statement. Some have it (UseStatement `nameLocs`), some don't. Audit and add as needed.
    - `CallStatement` / call-expression target name needs a location too (currently only de statement has loc).
  - **Out of scope (later):** semantic highlighting, hover docs, go-to-definition, find-all-references as a standalone command. Once de resolver exists, all of dese fall out almost for free, but treat as separate roadmap items.
- REPL.
- More example programs (FizzBuzz, Fibonacci — need loops first).
- **GitHub syntax highlighting for `.chatter` files.** Quick win: `.gitattributes` override like `*.chatter linguist-language=Ruby` (imperfect but instant). Proper path: PR to github-linguist/linguist with a TextMate grammar (the `vscode-chatter/` extension may already have one to reuse); requires ~200 public `.chatter` files to clear the popularity bar.
