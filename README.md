# Chatter

> ⚠️ **Experimental.** Chatter is an exploratory programming language under active design. Syntax, semantics, and tooling will change without notice. Don't build anything you care about in it (yet).

Chatter is a small, HyperTalk-inspired programming language. Its goal is to read more like English than like code, while still being strict enough to catch mistakes early.

```chatter
constant foo is 5
constant bar is 6

function double takes number a returns number is
    return a * 2
end function

function raise takes number a to number exponent returns number is
    return a ** exponent
end function

double foo
# 'it' is now 10
raise foo to bar
# 'it' is now 15,625
```

## Design philosophy

### 1. Read like English, not like code
Chatter takes its cue from HyperTalk: `say "hello"`, `if x is 5`, `constant foo is 10`, `raise foo to bar`. Verbs come first, named arguments match parameter names verbatim, and block closers can spell themselves out (`end if`, `end function`). Code should narrate what it does.

### 2. Explicit beats clever
When ambiguity creeps in, we pick the path that forces the author to clarify:

- Mixing `and` with `or` at the same level? **Compile error, use parens.**
- Mutating a `constant` binding? **Compile error.**
- Shadowing an outer variable with a parameter? **Compile error.**
- Non-boolean in an `if` condition? **Runtime error** (no truthiness).
- Comparing a number to a string? **Runtime error** (strict equality).

We'd rather annoy the author at write-time than confuse the reader at read-time.

### 3. Immutability by default
`constant` creates immutable bindings, not variables. Once you know what a name means, it means that forever in its scope. No reassignment tricks.

### 4. `it` is sugar, not a crutch
The function-scoped `it` register captures "the thing we just made" so short pipelines read naturally:

```chatter
double foo
quadruple it
```

But it's deliberately limited — scoped per function so outer context can't be clobbered, and explicitly **not** updated by `say`, so you can sprinkle `say` statements for debugging without perturbing `it`.

### 5. Two-phase architecture
Source → **Compiler** → Bytecode → **VM**. Each phase is independently testable and swappable. The bytecode is the contract between the two.

### 6. Errors where they belong
Syntactic and scope violations → compile time. Type mismatches and arithmetic failures → runtime (for now; a static type checker is on the roadmap). Every error surfaces a clear message and exits non-zero.

### 7. Tests that look like users
Golden files under `tests/chatter/` — drop a `.chatter` and `.expected`, and it's tested. The harness runs the full pipeline, just like a user would. This keeps us honest: if the language feels wrong in a test file, it feels wrong in production.

### 8. Build features only when specified
Every feature comes from a conversation. The author describes intent (often with an example `.chatter` file), clarifying questions get asked until the spec is unambiguous, and only then does implementation follow. Nothing is added speculatively.

### 9. Incremental and reversible
Features land in small, focused batches. Tests prove they work before we move on. Earlier choices aren't sacred — when `print` stopped fitting the language's voice, it was replaced with `say`. When `==` felt too mathematical, it was swapped for `is`.

### 10. Simpler now, smarter later
Ship runtime type checks today, plan compile-time inference tomorrow. Ship strict `and`/`or` evaluation today, consider short-circuit later. Ship `number` as a safe integer, add fractions later. The language grows by answering questions it can answer; the rest waits.

---

**In one sentence:** Chatter reads like prose, errors early, changes its mind when a simpler English feels right, and builds only what the author actually asked for.

## Running Chatter

```bash
npm install
npx ts-node src/index.ts examples/hello_world.chatter
```

## Testing

```bash
npm test
```

Golden tests live in `tests/chatter/`. Each `<name>.chatter` has a `<name>.expected` file; the harness runs the full pipeline and diffs stdout. Add a new test case by dropping two files — no TypeScript boilerplate needed.
