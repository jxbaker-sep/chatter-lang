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
403 tests, all passing.

## Language spec (current)

### Syntax
- Line-oriented, verb-first statements.
- `#` comments (whole line or trailing).
- Python-style indentation for blocks (`function ... end`, `if ... end`).

### Types
- `number` = i32, signed. Overflow = runtime error.
- `string` = double-quoted literals.
- `boolean` = `true` / `false`. Prints as literal `true`/`false`.
- `list of TYPE` — mutable, ordered, **reference-value** list of scalar elements (TYPE ∈ {number, string, boolean}). Assignment / argument passing / returning aliases the same underlying list (mutations visible via every reference).
- `readonly list of TYPE` — a **reference-capability marker** used *only* in parameter type annotations. Forbids mutation through that reference at compile time. Not stored at runtime. Cannot appear as a `set`/`var` annotation nor as a return type.
- Nested lists (`list of list of T`) are **not supported** (parse error).

### Statements
- `say expr (, expr)*` — prints one or more expressions space-separated on one line, terminated by newline. **Does NOT update `it`** (for debugging). Empty `say` or trailing comma = compile error. Single-arg form output is byte-identical to the old single-expression `say`. List literals stay greedy in `say` arg position — use parens to mix a list alongside other items: `say (list of 1, 2), "end"`.
- `set NAME to expr` — immutable binding. Duplicate `set` = compile error.
- `var NAME is expr` — **mutable** binding. Initializer required. Type-locked at first assignment to whichever of {number, string, boolean} the value is. Same scoping rules as `set` (function-local; no shadowing of outer bindings; no redeclaration at same level — including mixing `set`/`var`). Does NOT update `it`.
- `change NAME to expr` — reassigns an existing `var`. Compile error if NAME is not a `var` (e.g. a `set`, param, loop var, or undeclared). Runtime error if the new value's type doesn't match the locked type (message mentions name + expected/got). Does NOT update `it`.
- Arithmetic sugar (all shorthand for `change NAME to NAME <op> EXPR`):
  - `add EXPR to NAME`
  - `subtract EXPR from NAME`
  - `multiply NAME by EXPR`
  - `divide NAME by EXPR`
  All require NAME to be a `var` of locked type `number` (compile error if the type is statically known to be string or boolean; otherwise deferred to runtime arithmetic check). Do NOT update `it`.
- `function NAME [takes TYPE IDENT (LABEL TYPE IDENT)*] [returns TYPE] is ... end [function]` — function decl. `TYPE` is `number`, `boolean`, or `string`. Zero-arg functions omit `takes` entirely. First param is positional (no label). Each subsequent param is preceded by a **separator label** that is used at the call site; the param's **body name** (the IDENT) is what the body code refers to. `LABEL` may be any IDENT or any non-stop KEYWORD (e.g. `to`, `with`, `from` are valid labels; `is`, `end`, `if`, `and`, `takes`, `returns`, ... are not). Duplicate body names in the same function → compile error. Duplicate labels are allowed; at the call site, multiple args with the same label bind to the matching params **in declaration order**. `end function` is an optional qualifier; plain `end` also works.

  **Two kinds of function (determined by presence of `returns` clause):**
  - **Void** (no `returns`): body may use bare `return` (no expression) to exit early. `return EXPR` in a void function is a **compile error**. Call sites emit `DROP` after `CALL` — the call does **NOT** update `it`. A void function used in expression position (`set x to greet`, `say greet`, `greet + 1`, etc.) is a **compile error**. Empty void body is legal.
  - **Typed** (`returns TYPE`): every execution path must end with an explicit `return EXPR` (compile-time path analysis; see below). `return` alone is a compile error. `return EXPR`: if EXPR's static type mismatches the declared type → compile error; if unknown → runtime `CHECK_TYPE` op is emitted. Call sites emit `STORE_IT` normally. Empty typed body or fall-through → compile error ("missing return").

  **Path-termination analyzer** (`statementTerminates` / `blockTerminates` in `compiler.ts`):
  - `return` terminates.
  - `if` with else terminates iff every branch (all `else if` + `else`) terminates; missing else never terminates.
  - `repeat` bodies never contribute termination (loop body may run zero times).
  - All other statements: not terminating.
- `return expr` / `return` — `return expr` in typed fns, bare `return` in void fns only. Multiple returns allowed.
- `NAME firstArg LABEL1 val1 LABEL2 val2` — function call: first arg positional, rest selected by the declared separator labels.
- `if cond ... [else if cond ... ]* [else ...] end [if]` — `end if` optional.
- `repeat N times ... end [repeat]` — run body N times. N must be a number; N=0 = 0 iterations; N<0 = runtime error.
- `repeat with i from A to B ... end [repeat]` — inclusive range loop. `i` is block-scoped (mutable across iterations, invisible after loop). `i` cannot shadow outer bindings (compile error). `set i to ...` inside body also a compile error (duplicate binding). If A > B, zero iterations.
- `repeat while cond ... end [repeat]` — pre-test while loop. `cond` must be a boolean (runtime error otherwise). Note: without mutable state, rarely useful for now.
- All three variants accept either `end` or `end repeat`.

### Expressions
- Arithmetic: `+ - * / ** mod`. Standard precedence: `**` > `*/ mod` > `+-`. `mod` is a keyword, same precedence as `*` and `/`, left-associative. **Floored-division modulo** (sign follows divisor, à la Python/Ruby). Result of `a mod b` (when `b > 0`) is always in `[0, b)`. Runtime error on `mod 0`.
- Equality: `is`, `is not` — value + type comparison. Type mismatch = runtime error (Path A). Lower precedence than arithmetic, higher than logical. (`==` and `!=` are **not** tokens; they cause a tokenisation error.)
- Comparison (numbers only, same precedence as `is`/`is not`):
  - `a is less than b` → `<`
  - `a is at most b` → `<=`
  - `a is greater than b` → `>`
  - `a is at least b` → `>=`
  - Non-number operands → RuntimeError ("Type mismatch: comparison requires numbers"). Positive forms only (no `is not less than` etc. yet).
  - Reserved keywords added: `less`, `greater`, `than`, `at`, `least`, `most`.
- Logical: `not` (unary), `and`, `or`. Precedence: `is`/`is not` > `not` > `and`/`or`.
- Unary `-` on numbers: `-EXPR` is legal anywhere a primary is (literals, vars, expressions). Binds tighter than `**`, so `-2 ** 2 = 4` (i.e. `(-2) ** 2`). Operand must be `number` or compile error.
- **Hybrid paren rule** for `and`/`or`: same-operator chains fine; mixing `and` with `or` at same level = compile error ("parentheses required"). `(a and b) or c` is OK. Parens reset context.
- `it` — meta-syntactic var holding last statement's result. **Per-frame/function-scoped**. `say` does not touch it.
- Parenthesised expressions allowed everywhere.

### Scoping
- `set` bindings are immutable; `var` bindings are mutable but type-locked.
- Functions can read outer-scope `set`/`var` bindings (closures), but `change`/sugar can only target `var`s declared in the **same** function body.
- Param names **cannot shadow** outer bindings — compile error.
- `var` **cannot shadow** outer bindings (inside a function) — compile error. Redeclaring a name already bound via `set`/`var` in the same scope — compile error.

### Keywords reserved for mutable vars
`var`, `change`, `add`, `subtract`, `multiply`, `divide`, `by`

### Keywords reserved for lists
`list`, `of`, `readonly`, `empty`, `item`, `first`, `last`, `length`, `contains`, `append`, `prepend`, `insert`, `in`, `remove`

### Keywords reserved for string operations
`character`, `characters` (new). `length`, `contains`, `first`, `last`, `of` are shared with lists.

### Keywords reserved for file I/O
`read`, `file`, `lines`. See "File I/O" below.

### File I/O (read-only, v1)
- **`lines of file EXPR`** — expression form. `EXPR` must be `string` (compile error otherwise). Returns a fresh **mutable** `list of string`. Line-splitting: any `\n` or `\r\n` is a separator; exactly one trailing newline is stripped (so `"a\nb\n"` → `["a", "b"]`). Empty file → empty list. Leading/internal blank lines are preserved as empty strings.
- **`read file EXPR`** — statement form, sugar for `set it to lines of file EXPR`. Updates `it` with the same list. Does NOT introduce a named binding.
- **Path resolution**: relative paths are resolved against `process.cwd()` at runtime (where the `chatter` CLI was invoked). Absolute paths work normally.
- **Errors**: file not found, permission denied, etc. surface as runtime error `"could not read file '<path>': <code-or-message>"`.
- **Writing files** is future work.

### Strings (v1: tiers 1+2)
- **Concat** `&` — binary OP, **lower precedence than `+`/`-`** (own level between equality and additive), left-assoc. Both sides coerced to string (`String(n)` for numbers, `"true"`/`"false"` for booleans, `say`-style `[...]` formatter for lists). Always returns string. Never a type error. Example: `"x=" & 1 + 2` → `"x=3"` because `+` binds tighter than `&`.
- **`length of S`** — polymorphic with list; returns character count.
- **`S contains T`** — polymorphic with list; both sides must be strings (enforced statically when LHS type is known-string; runtime error otherwise). `""` contains `""` → true.
- **`character N of S`** — 1-indexed char access; OOB/non-string/non-number → runtime error.
- **`characters A to B of S`** — inclusive substring. `A > B` → `""`. `A < 1` or `B > length` → runtime error.
- **`first character of S`** / **`last character of S`** — sugar (parse to dedicated AST nodes). Empty string → runtime error. `last` uses a compiler temp to avoid double-evaluating the target (parallel with `last item of`).
- **Static checks**: `character/characters/first character/last character of X` with statically-known non-string `X` → compile error. `contains` with string LHS + non-string RHS (static) → compile error.
- **`&` is the only new OP token.** Lexer change: `+-*/&`.

### Lists (v1)
- **Literals**: `list of EXPR (, EXPR)*` (nonempty, at least one element) — element type inferred/checked; `empty list of TYPE` (element type required).
- **Read ops (expressions)**:
  - `item N of L` — 1-indexed access; OOB / non-list / non-number index → runtime error.
  - `first item of L` — sugar for `item 1 of L`; empty → runtime error.
  - `last item of L` — sugar for `item (length) of L`; empty → runtime error.
  - `length of L` — returns number.
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
- **Reference semantics**: lists are references. `set b to a` aliases. Passing to a function aliases. Mutating through any alias is visible through all.
- **Readonly rules** (compile-time only, never stored at runtime):
  - `readonly list of T` is only valid in param annotations.
  - Inside a function body, any of the 5 mutations targeting a readonly param → compile error.
  - `set x to readonly_param` / `var x is readonly_param` / `change v to readonly_param` → compile error ("cannot bind a readonly-list reference").
  - `return readonly_param` from a typed function → compile error. Return types cannot be `readonly list of T` (parse error).
  - **Call-site matching**: `list of T` arg widens to `readonly list of T` param (OK). `readonly list of T` → `list of T` param rejected (compile error). Element type must match exactly.
- **Internal type representation**: `ChatterType = {kind:'scalar', name} | {kind:'list', element, readonly}`. Used uniformly in bindings, signatures, param/return annotations, staticType. AST types: `TypeAnnotation` (same shape minus `kind`) for `FunctionParam.paramType` and `FunctionDeclaration.returnType`.

### Compile-time vs runtime checks
- **Compile-time**: readonly enforcement, call-site arg/param type matching, readonly smuggling prevention, return-type matching (scalar and list kind/element/readonly), type-locked `var` changes, mixed-type-literal detection (when all types known), append/prepend/insert/change-item element-type static checks, nested-list rejection.
- **Runtime**: list OOB (get/set/insert/remove), non-list targets when static type is unknown, wrong-type elements when compile-time type couldn't verify, empty `first`/`last`, non-number index.

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
`DELETE` — removes a local from the current frame; used to scope loop variables.
`LT` / `LE` / `GT` / `GE` — numeric comparison; RuntimeError on non-numbers.
`STORE_VAR` — type-locked store for mutable `var` bindings. On first store in a frame it records the value's type (number/string/boolean/`list:<element>`); on subsequent stores (from `change` or the arithmetic sugar) it checks the value's type matches the locked type and throws a RuntimeError if not. Each call frame has its own varTypes map, so recursive calls re-lock per invocation.

### List / string bytecode ops
- `MAKE_LIST { count, elementType: 'number'|'string'|'boolean'|null }` — pops `count` values (order-preserving), pushes a new `ChatterList`. `elementType=null` means infer from the first element; all others must match. Used for nonempty list literals.
- `MAKE_EMPTY_LIST { elementType }` — push a fresh empty list with explicit element type.
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
- `set` is strictly immutable (constants really).
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
- **Fractional numbers**: planned. `number` is currently i32 only.
- **Loop extensions (deferred)**: reverse direction (`down to`), early exit (`exit repeat`, `next repeat`), `repeat until cond`. Base `repeat` loops (times / range / while) and the `by STEP` clause on range-form are implemented.
- **Chatter-native test framework**: write tests in Chatter (`assert x is 10`) once assertions exist.
- **Maps**: independent built-in key-value type. Mutable. Also need a read-only variant.
- **Sets**: independent built-in unordered unique-element collection. Mutable + readonly variant.
- **Structs**: independent built-in "plain old data" aggregate — named fields, no methods. **Immutable.** Should have syntactic sugar for "copy with specific fields changed" (like Rust's struct update syntax or a `with` clause). Not objects — pure data containers.
- **Writing files**: companion to `lines of file` / `read file`. Likely `write LIST to file PATH` and/or `write STRING to file PATH`. Questions for later: overwrite vs append, auto-add trailing newline on line lists, create parent dirs or error?

### Natural follow-ups
- **String operations (tier 3/4 deferred)**: case transforms (`uppercase/lowercase of`), trim, split/join, replace, index-of, starts-with/ends-with. Tiers 1+2 (concat `&`, `length of`, `contains`, `character N of`, `characters A to B of`, `first/last character of`) are **implemented**.
- **More HyperTalk naturalizations** (if desired): `put X into Y`, word-form arithmetic (`plus`, `times`), `to the power of`. (Function-decl `takes` form and `mod` are implemented; negative literals / unary `-` are implemented.)
- **String escape sequences**: `\"`, `\n` etc.

### Quality of life
- Better error messages (line/col + source snippet).
- REPL.
- More example programs (FizzBuzz, Fibonacci — need loops first).
