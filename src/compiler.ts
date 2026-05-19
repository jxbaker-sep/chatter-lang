import {
  Program, Statement, Expression, Located,
  SayStatement, ConstantDeclaration, FunctionDeclaration,
  CallStatement, ReturnStatement, BinaryExpression, UnaryExpression,
  IfStatement, RepeatStatement,
  VarDeclaration, ChangeStatement, ChangeItemStatement, CompoundAssignStatement,
  ListLiteral, ItemAccessExpression, LastItemExpression,
  LengthExpression, AppendStatement, PrependStatement, InsertStatement,
  RemoveItemStatement, RemoveValueStatement, UniqueListLiteral,
  DictionaryLiteral, DictGetExpression, DictSetStatement,
  TypeAnnotation, ScalarTypeName, ElementTypeAnnotation,
  CharacterAccessExpression, LastCharacterExpression,
  SubstringExpression,
  ListSliceExpression,
  EndIndexSentinel,
  ReadFileLinesExpression, ReadFileStatement,
  ExpectStatement,
  FailStatement,
  ExitRepeatStatement, NextRepeatStatement,
  StructDeclaration, StructField,
  TypeAliasDeclaration,
  MakeStructExpression, FieldAccessExpression, StructWithExpression,
  SortStatement, MapExpression, FilterExpression, ReduceExpression,
} from './ast';
import { Instruction, InstructionKind, FunctionDef, BytecodeProgram } from './bytecode';
import { ChatterError, SourceLocation } from './errors';

export class CompileError extends ChatterError {
  constructor(message: string, location?: SourceLocation) {
    super(message, location);
    this.name = 'CompileError';
  }
}

function locOf(node: Located | undefined | null): SourceLocation | undefined {
  if (!node || node.line === undefined || node.col === undefined) return undefined;
  return { line: node.line, col: node.col, length: node.length, file: node.file };
}

function containsEndSentinel(expr: Expression | null | undefined): boolean {
  if (!expr) return false;
  switch (expr.type) {
    case 'EndIndexSentinel': return true;
    case 'BinaryExpression':
      return containsEndSentinel(expr.left) || containsEndSentinel(expr.right);
    case 'UnaryExpression':
      return containsEndSentinel(expr.operand);
    case 'CharacterAccessExpression':
    case 'ItemAccessExpression':
    case 'SubstringExpression':
    case 'ListSliceExpression':
      return false;
    default:
      return false;
  }
}

export type ChatterType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: string }       // element string-encoded
  | { kind: 'uniqueList'; element: string }
  | { kind: 'dict'; keyType: string; valueType: string }
  | { kind: 'struct'; mangled: string };

function unmangle(s: string): string {
  const idx = s.indexOf('::');
  return idx === -1 ? s : s.slice(idx + 2);
}

function elementHuman(code: string): string {
  if (code.startsWith('struct:')) return 'struct ' + unmangle(code.slice(7));
  return code;
}

function typesEqual(a: ChatterType, b: ChatterType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'scalar' && b.kind === 'scalar') return a.name === b.name;
  if (a.kind === 'list' && b.kind === 'list') {
    return a.element === b.element;
  }
  if (a.kind === 'uniqueList' && b.kind === 'uniqueList') {
    return a.element === b.element;
  }
  if (a.kind === 'dict' && b.kind === 'dict') {
    return a.keyType === b.keyType && a.valueType === b.valueType;
  }
  if (a.kind === 'struct' && b.kind === 'struct') {
    return a.mangled === b.mangled;
  }
  return false;
}

function typeToString(t: ChatterType): string {
  if (t.kind === 'scalar') return t.name;
  if (t.kind === 'struct') return 'struct ' + unmangle(t.mangled);
  if (t.kind === 'uniqueList') return 'unique list of ' + elementHuman(t.element);
  if (t.kind === 'dict') {
    return 'dictionary from ' + elementHuman(t.keyType) + ' to ' + elementHuman(t.valueType);
  }
  return 'list of ' + elementHuman(t.element);
}

function elementCode(t: ChatterType | null): string | null {
  if (t === null) return null;
  if (t.kind === 'scalar') return t.name;
  if (t.kind === 'struct') return 'struct:' + t.mangled;
  return null;
}

interface StructInfo {
  mangled: string;
  fields: Array<{ name: string; type: ChatterType }>;
  exported: boolean;
  imported: boolean;
  // If non-null, the mangled name of the formatter function for this struct.
  // Populated during pass 1d (local structs) or pass 1a (imported structs).
  formatterName?: string | null;
}

interface AliasInfo {
  mangled: string;
  // For local aliases, `body` is the unresolved annotation. For imported
  // aliases, `body` is null and `resolved` is pre-populated.
  body: TypeAnnotation | null;
  resolved: ChatterType | null;
  resolving: boolean;
  exported: boolean;
  imported: boolean;
  loc?: SourceLocation;
}

type BindingKind = 'constant' | 'var' | 'param' | 'loop';

interface BindingInfo {
  kind: BindingKind;
  type?: ChatterType;  // statically known type
}

interface ScopedBindingInfo extends BindingInfo {
  mangled: string;
}

// Lexical scope chain for block scoping. Each Scope has its own bindings map
// plus a parent pointer. Bindings in ancestor scopes are visible inward via
// `lookup` but cannot be shadowed (`declare` rejects names already visible).
// Each block-declared binding receives a possibly-mangled internal name so
// distinct sibling-scope bindings sharing a user-facing name never collide
// at runtime.
//
// `allMangledInFunction` tracks every internal name minted anywhere in the
// enclosing function (or module top-level for the root scope) and is shared
// by reference across all scopes that descend from the same root.
class Scope {
  parent: Scope | null;
  vars: Map<string, ScopedBindingInfo> = new Map();
  allMangledInFunction: Set<string>;
  // Top-level scopes feed module-mangling: every minted mangled name is also
  // added to `outerNamesSink` so the post-processor module-prefixes it.
  // Function-body scopes leave this null.
  outerNamesSink: Set<string> | null;

  constructor(parent: Scope | null, outerNamesSink: Set<string> | null = null) {
    this.parent = parent;
    if (parent) {
      this.allMangledInFunction = parent.allMangledInFunction;
      this.outerNamesSink = parent.outerNamesSink;
    } else {
      this.allMangledInFunction = new Set();
      this.outerNamesSink = outerNamesSink;
    }
  }

  hasInCurrent(name: string): boolean {
    return this.vars.has(name);
  }

  lookup(name: string): ScopedBindingInfo | null {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return null;
  }

  // Walk only ancestor scopes (not current). Used to distinguish "shadow"
  // vs "duplicate" errors in declare().
  private lookupAncestors(name: string): ScopedBindingInfo | null {
    for (let s: Scope | null = this.parent; s !== null; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return null;
  }

  declare(name: string, info: BindingInfo, currentLoc?: SourceLocation, extraOuterShadow?: boolean): string {
    if (this.vars.has(name)) {
      throw new CompileError(
        `Duplicate binding: '${name}' is already declared`,
        currentLoc,
      );
    }
    if (this.lookupAncestors(name) !== null || extraOuterShadow) {
      throw new CompileError(
        `Variable '${name}' shadows outer binding`,
        currentLoc,
      );
    }
    let mangled = name;
    let i = 1;
    while (this.allMangledInFunction.has(mangled)) {
      mangled = `${name}$${i++}`;
    }
    this.allMangledInFunction.add(mangled);
    if (this.outerNamesSink) this.outerNamesSink.add(mangled);
    this.vars.set(name, { ...info, mangled });
    return mangled;
  }
}

export interface ImportedFunction {
  mangled: string;
  signature: Array<{ name: string; label: string | null; type: ChatterType }>;
  returnType: ChatterType | null;
  paramNames: string[];
}

export interface ImportedStruct {
  mangled: string;
  fields: Array<{ name: string; type: ChatterType }>;
  // If the home module attached a `format is` clause, this is the mangled
  // formatter function name (already present in the program's `functions`
  // map). Importers don't need to recompile it.
  formatterName?: string | null;
}

export interface ImportedAlias {
  // Aliases imported from another module are stored as the fully-expanded
  // ChatterType produced by the source module. Importers do not need to
  // re-walk the source's alias chain.
  mangled: string;          // <sourceModuleId>::<Name>
  resolved: ChatterType;
}

export interface CompileOptions {
  moduleId?: string;
  imports?: Map<string, ImportedFunction>;
  structImports?: Map<string, ImportedStruct>;
  aliasImports?: Map<string, ImportedAlias>;
}

export interface CompiledModule {
  functions: Map<string, FunctionDef>;      // keyed by mangled names
  topLevel: Instruction[];                  // module top-level instructions
  exports: Map<string, ImportedFunction>;   // local name -> info (for loader)
  structExports: Map<string, ImportedStruct>;
  aliasExports: Map<string, ImportedAlias>;
  // Map from mangled struct type name -> mangled formatter function name.
  // Populated for every struct (local or imported re-export) that has a
  // `format is EXPR` clause in its home module.
  structFormatters: Map<string, string>;
}

export class Compiler {
  private functions = new Map<string, FunctionDef>();
  // Per-function set of locally-bound mangled names (params + block-scope
  // locals + compiler temps). The post-processor consults this when rewriting
  // top-level binding names so it doesn't accidentally rewrite a function-local
  // that shadows a top-level binding (e.g. a param named `x` when the caller
  // also has top-level `x`).
  private functionLocals = new Map<string, Set<string>>();
  private functionSignatures = new Map<string, Array<{ name: string; label: string | null; type: ChatterType }>>();
  private functionReturnTypes = new Map<string, ChatterType | null>();  // null = void
  private functionMangled = new Map<string, string>();   // local name -> mangled
  private outerBindings = new Set<string>();
  // Superset of `outerBindings`: also includes block-scoped top-level mangled
  // names (e.g. `a$1` for `constant a` declared inside an `if` branch at
  // module top level). Used solely by the post-processor to module-prefix
  // every top-level mangled name. Visibility checks (from inside a function
  // body) still use `outerBindings`, which holds only direct top-level user
  // bindings — block-scope top-level locals are NOT visible from elsewhere.
  private topLevelMangled = new Set<string>();
  private topLevelBindings: Scope | null = null;
  private tempCounter = 0;
  private currentFuncReturnType: ChatterType | null | undefined = undefined;  // undefined = top-level
  private currentFuncName: string | null = null;
  private locStack: (SourceLocation | undefined)[] = [];
  private moduleId: string | null = null;
  private imports: Map<string, ImportedFunction> = new Map();
  private localFunctions = new Map<string, FunctionDeclaration>();
  private endLenTmpStack: string[] = [];
  // Struct registry: local name -> info (mangled, fields). Includes both
  // local declarations (resolved fully) and imported structs.
  private structs = new Map<string, StructInfo>();
  private localStructDecls = new Map<string, StructDeclaration & Located>();

  // Type-alias registry: local name -> info. Includes both local declarations
  // (raw `body` field, resolved lazily during pass 1b with cycle detection)
  // and imported aliases (already expanded by the source module).
  private aliases = new Map<string, AliasInfo>();
  private localAliasDecls = new Map<string, TypeAliasDeclaration & Located>();

  // Loop control stack: each entry records pending JUMP instruction indices
  // that must be patched to the loop's continue / exit targets.
  private loopStack: Array<{
    continueJumps: number[];
    exitJumps: number[];
  }> = [];

  // Higher-order list operation context. The `it` and `accumulator` magic
  // names rebind to a synthesized local while compiling a HOF body. We push
  // on entering a HOF body and pop on exit. Nested HOFs are forbidden in v1.
  private hofItStack: Array<{ local: string; type: ChatterType | undefined }> = [];
  private hofAccStack: Array<{ local: string; type: ChatterType | undefined }> = [];
  private inHofBody = false;

  private get currentLoc(): SourceLocation | undefined {
    return this.locStack[this.locStack.length - 1];
  }

  private emit(out: Instruction[], instr: InstructionKind): void {
    const withLoc = instr as Instruction;
    if (withLoc.loc === undefined && this.currentLoc !== undefined) {
      Object.defineProperty(withLoc, 'loc', {
        value: this.currentLoc,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    out.push(withLoc);
  }

  private freshName(tag: string): string {
    const prefix = this.moduleId ? `_rep_${this.moduleId}_` : '_rep_';
    return `${prefix}${tag}_${this.tempCounter++}`;
  }

  private mangleBinding(name: string): string {
    if (this.moduleId && this.topLevelMangled.has(name)) {
      return `${this.moduleId}::${name}`;
    }
    return name;
  }

  private mangleFunction(name: string): string {
    const imp = this.imports.get(name);
    if (imp) return imp.mangled;
    const local = this.functionMangled.get(name);
    if (local) return local;
    return name;
  }

  // Look up a binding in the lexical scope chain, falling back to the module
  // top-level scope if not found. Collection mutations (list/dict element
  // assignment, append/prepend/insert/remove, unique-list add/remove, dict
  // remove, compound assigns on item-of/value-of) operate on the underlying
  // aggregate through its reference, so they're allowed to target any visible
  // binding — including module-top-level `constant`s and `variable`s — from
  // inside a function body. (Bare-NAME `change`/arithmetic sugar on number
  // variables is still restricted to same-function scope; callers enforce
  // that separately.)
  private lookupBindingWithOuter(
    name: string,
    bindings: Scope,
  ): { info: ScopedBindingInfo; fromOuter: boolean } | null {
    const local = bindings.lookup(name);
    if (local) return { info: local, fromOuter: false };
    if (this.topLevelBindings && bindings !== this.topLevelBindings) {
      const top = this.topLevelBindings.lookup(name);
      if (top) return { info: top, fromOuter: true };
    }
    return null;
  }

  // Resolve a TypeAnnotation to a ChatterType using the struct + alias
  // registries. Throws CompileError for unknown names. Aliases are expanded
  // (both local and imported); cycle detection is handled in pass 1b so by
  // the time fromAnnotation runs in normal compilation flow, every local
  // alias has a non-null `resolved` field.
  private fromAnnotation(a: TypeAnnotation, loc?: SourceLocation): ChatterType {
    if (a.kind === 'scalar') return { kind: 'scalar', name: a.name };
    if (a.kind === 'struct') {
      // Bare IDENT: alias takes precedence over struct lookup, since names
      // are unique across both registries (collision is checked in pass 1).
      const ali = this.aliases.get(a.name);
      if (ali) {
        if (ali.resolved) return ali.resolved;
        // Should be pre-resolved; fall back to on-demand resolution (e.g.,
        // when fromAnnotation is reached during alias resolution itself).
        return this.resolveLocalAlias(a.name, [], loc);
      }
      const info = this.structs.get(a.name);
      if (!info) {
        throw new CompileError(`unknown type '${a.name}'`, loc ?? this.currentLoc);
      }
      return { kind: 'struct', mangled: info.mangled };
    }
    if (a.kind === 'dict') {
      const kCode = this.elementAnnotationToCode(a.keyType, loc);
      const vCode = this.elementAnnotationToCode(a.valueType, loc);
      return { kind: 'dict', keyType: kCode, valueType: vCode };
    }
    // list/uniqueList
    const elem = a.element;
    const elemCode = this.elementAnnotationToCode(elem, loc);
    if (a.kind === 'uniqueList') {
      return { kind: 'uniqueList', element: elemCode };
    }
    return { kind: 'list', element: elemCode };
  }

  private elementAnnotationToCode(e: ElementTypeAnnotation, loc?: SourceLocation): string {
    if (e.kind === 'scalar') return e.name;
    // Bare IDENT in element position: try alias first, then struct.
    const ali = this.aliases.get(e.name);
    if (ali) {
      const t = ali.resolved ?? this.resolveLocalAlias(e.name, [], loc);
      if (t.kind === 'list' || t.kind === 'uniqueList' || t.kind === 'dict') {
        throw new CompileError(
          `nested collections not supported (alias '${e.name}' expands to ${typeToString(t)})`,
          loc ?? this.currentLoc,
        );
      }
      if (t.kind === 'scalar') return t.name;
      return 'struct:' + t.mangled;
    }
    const info = this.structs.get(e.name);
    if (!info) {
      throw new CompileError(`unknown type '${e.name}'`, loc ?? this.currentLoc);
    }
    return 'struct:' + info.mangled;
  }

  // Resolve a local alias to a ChatterType, walking through alias-of-alias
  // chains and detecting cycles. Also enforces the v1 rule that an alias
  // body cannot reference an imported name.
  private resolveLocalAlias(localName: string, chain: string[], loc?: SourceLocation): ChatterType {
    const info = this.aliases.get(localName)!;
    if (info.resolved) return info.resolved;
    if (info.resolving) {
      const startIdx = chain.indexOf(localName);
      const cycle = startIdx >= 0
        ? chain.slice(startIdx).concat(localName)
        : chain.concat(localName);
      throw new CompileError(
        `circular type alias: ${cycle.join(' → ')}`,
        info.loc ?? loc ?? this.currentLoc,
      );
    }
    info.resolving = true;
    try {
      const t = this.expandAliasBody(info.body!, chain.concat(localName), info.loc);
      info.resolved = t;
      return t;
    } finally {
      info.resolving = false;
    }
  }

  // Walk an alias body, rejecting any reference to an imported name.
  // Local struct refs and local alias refs are allowed (recurses for
  // alias-of-alias). Cycle detection lives in resolveLocalAlias.
  private expandAliasBody(a: TypeAnnotation, chain: string[], loc?: SourceLocation): ChatterType {
    if (a.kind === 'scalar') return { kind: 'scalar', name: a.name };
    if (a.kind === 'struct') {
      const name = a.name;
      // Reject imported names (function, struct, or alias).
      if (
        this.imports.has(name) ||
        (this.structs.get(name)?.imported === true) ||
        (this.aliases.get(name)?.imported === true)
      ) {
        throw new CompileError(
          `aliasing imported names is not supported in v1`,
          loc ?? this.currentLoc,
        );
      }
      if (this.aliases.has(name)) return this.resolveLocalAlias(name, chain, loc);
      const info = this.structs.get(name);
      if (!info) {
        throw new CompileError(`unknown type '${name}'`, loc ?? this.currentLoc);
      }
      return { kind: 'struct', mangled: info.mangled };
    }
    if (a.kind === 'dict') {
      const kCode = this.expandAliasElement(a.keyType, chain, loc);
      const vCode = this.expandAliasElement(a.valueType, chain, loc);
      return { kind: 'dict', keyType: kCode, valueType: vCode };
    }
    const elemCode = this.expandAliasElement(a.element, chain, loc);
    if (a.kind === 'uniqueList') return { kind: 'uniqueList', element: elemCode };
    return { kind: 'list', element: elemCode };
  }

  private expandAliasElement(e: ElementTypeAnnotation, chain: string[], loc?: SourceLocation): string {
    if (e.kind === 'scalar') return e.name;
    const name = e.name;
    if (
      this.imports.has(name) ||
      (this.structs.get(name)?.imported === true) ||
      (this.aliases.get(name)?.imported === true)
    ) {
      throw new CompileError(
        `aliasing imported names is not supported in v1`,
        loc ?? this.currentLoc,
      );
    }
    if (this.aliases.has(name)) {
      const t = this.resolveLocalAlias(name, chain, loc);
      if (t.kind === 'list' || t.kind === 'uniqueList' || t.kind === 'dict') {
        throw new CompileError(
          `nested collections not supported (alias '${name}' expands to ${typeToString(t)})`,
          loc ?? this.currentLoc,
        );
      }
      if (t.kind === 'scalar') return t.name;
      return 'struct:' + t.mangled;
    }
    const info = this.structs.get(name);
    if (!info) {
      throw new CompileError(`unknown type '${name}'`, loc ?? this.currentLoc);
    }
    return 'struct:' + info.mangled;
  }

  compile(program: Program): BytecodeProgram {
    const m = this.compileModule(program, {});
    return { functions: m.functions, main: m.topLevel, structFormatters: m.structFormatters };
  }

  compileModule(program: Program, opts: CompileOptions): CompiledModule {
    this.moduleId = opts.moduleId ?? null;
    this.imports = opts.imports ?? new Map();
    const structImports = opts.structImports ?? new Map<string, ImportedStruct>();
    const aliasImports = opts.aliasImports ?? new Map<string, ImportedAlias>();

    // Pass 1a: register all structs (local + imported) and aliases (local +
    // imported) by local name. Imported entries first.
    for (const [localName, info] of structImports) {
      this.structs.set(localName, {
        mangled: info.mangled,
        fields: info.fields,
        exported: false,
        imported: true,
        formatterName: info.formatterName ?? null,
      });
    }
    for (const [localName, info] of aliasImports) {
      this.aliases.set(localName, {
        mangled: info.mangled,
        body: null,
        resolved: info.resolved,
        resolving: false,
        exported: false,
        imported: true,
      });
    }

    // Helper for collision checks across the unified namespace
    // (struct, alias, function, import).
    const checkCollision = (name: string, loc?: SourceLocation) => {
      if (this.structs.has(name) || this.aliases.has(name) || this.imports.has(name)) {
        throw new CompileError(
          `name '${name}' is already defined`,
          loc,
        );
      }
    };

    // Local struct declarations: collect names with mangled, fields filled later.
    for (const stmt of program.body) {
      if (stmt.type !== 'StructDeclaration') continue;
      checkCollision(stmt.name, locOf(stmt));
      const mangled = this.moduleId ? `${this.moduleId}::${stmt.name}` : stmt.name;
      // Validate empty / duplicate fields here (don't need full type resolution).
      if (stmt.fields.length === 0) {
        throw new CompileError(
          `struct '${stmt.name}' must have at least one field`,
          locOf(stmt),
        );
      }
      const seen = new Set<string>();
      for (const f of stmt.fields) {
        if (seen.has(f.name)) {
          throw new CompileError(
            `duplicate field '${f.name}' in struct ${stmt.name}`,
            locOf(stmt),
          );
        }
        seen.add(f.name);
      }
      this.structs.set(stmt.name, {
        mangled,
        fields: [],  // resolved next
        exported: stmt.exported,
        imported: false,
      });
      this.localStructDecls.set(stmt.name, stmt);
    }

    // Local type alias declarations: collect (raw bodies; resolved in pass 1a').
    for (const stmt of program.body) {
      if (stmt.type !== 'TypeAliasDeclaration') continue;
      checkCollision(stmt.name, locOf(stmt));
      const mangled = this.moduleId ? `${this.moduleId}::${stmt.name}` : stmt.name;
      this.aliases.set(stmt.name, {
        mangled,
        body: stmt.body,
        resolved: null,
        resolving: false,
        exported: stmt.exported,
        imported: false,
        loc: locOf(stmt),
      });
      this.localAliasDecls.set(stmt.name, stmt as TypeAliasDeclaration & Located);
    }

    // Pass 1a': resolve every local alias (DFS via resolveLocalAlias).
    // This populates `resolved` and detects cycles + import-name refs.
    for (const localName of this.localAliasDecls.keys()) {
      this.resolveLocalAlias(localName, []);
    }

    // Pass 1b: resolve each local struct's field types (forward refs OK now).
    for (const [localName, decl] of this.localStructDecls) {
      const info = this.structs.get(localName)!;
      const fields: Array<{ name: string; type: ChatterType }> = [];
      for (const f of decl.fields) {
        const ft = this.fromAnnotation(f.fieldType, locOf(decl));
        fields.push({ name: f.name, type: ft });
      }
      info.fields = fields;
    }

    // Pass 1c: cycle detection on local structs (DFS through struct fields
    // and struct elements inside list/uniqueList fields).
    {
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = new Map<string, number>();
      const stack: string[] = [];
      const dfs = (mangled: string, friendlyChain: string[]): void => {
        const c = color.get(mangled) ?? WHITE;
        if (c === BLACK) return;
        if (c === GRAY) {
          // cycle
          const startIdx = friendlyChain.lastIndexOf(unmangle(mangled));
          const cycle = startIdx >= 0
            ? friendlyChain.slice(startIdx).concat(unmangle(mangled))
            : friendlyChain.concat(unmangle(mangled));
          throw new CompileError(
            `circular struct: ${cycle.join(' → ')}`,
          );
        }
        // Find local info by mangled name (only local matters for cycles).
        let local: StructInfo | undefined;
        for (const v of this.structs.values()) {
          if (v.mangled === mangled && !v.imported) { local = v; break; }
        }
        if (!local) { color.set(mangled, BLACK); return; }
        color.set(mangled, GRAY);
        stack.push(unmangle(mangled));
        for (const f of local.fields) {
          let next: string | null = null;
          if (f.type.kind === 'struct') next = f.type.mangled;
          else if ((f.type.kind === 'list' || f.type.kind === 'uniqueList')
                   && f.type.element.startsWith('struct:')) {
            next = f.type.element.slice(7);
          }
          if (next !== null) dfs(next, stack.slice());
        }
        stack.pop();
        color.set(mangled, BLACK);
      };
      for (const info of this.structs.values()) {
        if (info.imported) continue;
        dfs(info.mangled, []);
      }
    }

    // Seed signatures / returnTypes from imports (callable by local name)
    for (const [localName, info] of this.imports) {
      this.functionSignatures.set(localName, info.signature);
      this.functionReturnTypes.set(localName, info.returnType);
    }

    // First pass: collect local function signatures, return types, outer bindings
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration') {
        if (this.imports.has(stmt.name) || this.structs.has(stmt.name) || this.aliases.has(stmt.name)) {
          throw new CompileError(
            `name '${stmt.name}' is already defined`,
            locOf(stmt),
          );
        }
        this.functionSignatures.set(
          stmt.name,
          stmt.params.map(p => ({ name: p.name, label: p.label, type: this.fromAnnotation(p.paramType, locOf(stmt)) })),
        );
        this.functionReturnTypes.set(
          stmt.name,
          stmt.returnType === null ? null : this.fromAnnotation(stmt.returnType, locOf(stmt)),
        );
        const mangled = this.moduleId ? `${this.moduleId}::${stmt.name}` : stmt.name;
        this.functionMangled.set(stmt.name, mangled);
        this.localFunctions.set(stmt.name, stmt);
      }
      if (stmt.type === 'ConstantDeclaration' || stmt.type === 'VarDeclaration') {
        this.outerBindings.add(stmt.name);
        this.topLevelMangled.add(stmt.name);
      }
    }

    const topLevel: Instruction[] = [];
    // Top-level scope feeds `topLevelMangled` (a superset of outerBindings)
    // as block-mangled names are minted at module top level, so the
    // post-processor module-prefixes them and they don't collide with
    // identically-named block-scoped bindings in other modules.
    const bindings: Scope = new Scope(null, this.topLevelMangled);
    this.topLevelBindings = bindings;

    // Pass 1d: compile format thunks for every local struct with a
    // `format is EXPR` clause. Each thunk is a synthetic single-param
    // function (`it` of struct type) whose body is the expression followed
    // by RETURN. Registered in `this.functions` under name
    // `<mangledStructType>::__format__`. Static type of the body must be
    // `string` when statically known (pass-through otherwise).
    for (const [localName, decl] of this.localStructDecls) {
      if (!decl.formatExpr) continue;
      const info = this.structs.get(localName)!;
      this.compileFormatThunk(localName, info, decl.formatExpr, locOf(decl));
    }

    for (const stmt of program.body) {
      if (stmt.type === 'UseStatement') continue;
      if (stmt.type === 'StructDeclaration') continue;  // already processed in pass 1
      if (stmt.type === 'TypeAliasDeclaration') continue;  // pure compile-time
      this.compileStatement(stmt, topLevel, bindings);
    }

    // Post-process: apply mangling to binding names (outer) and function-call names
    const rewriteInstrs = (instrs: Instruction[], skip: Set<string> | null) => {
      for (const i of instrs) {
        if (i.op === 'LOAD' || i.op === 'STORE' || i.op === 'STORE_VAR' || i.op === 'DELETE') {
          if (skip && skip.has(i.name)) continue;
          i.name = this.mangleBinding(i.name);
        } else if (i.op === 'CALL') {
          i.name = this.mangleFunction(i.name);
        }
      }
    };
    rewriteInstrs(topLevel, null);
    for (const [mangledName, fdef] of this.functions) {
      rewriteInstrs(fdef.instructions, this.functionLocals.get(mangledName) ?? null);
    }

    // Slot-allocation pass: within each function body, rewrite name-based
    // local accesses to slot-indexed variants. A name is treated as a
    // function-local slot iff it appears in the function's own
    // `functionLocals` set (params + block-scope locals), OR it isn't a
    // module-top-level binding and isn't a mangled global (compiler temps
    // from `freshName` fall in the latter bucket). This handles the case
    // where a function param shadows a same-named top-level binding.
    for (const [mangledName, fdef] of this.functions) {
      const localSet = this.functionLocals.get(mangledName) ?? new Set<string>();
      const isLocal = (n: string): boolean => {
        if (localSet.has(n)) return true;
        if (n.indexOf('::') >= 0) return false;
        if (this.topLevelMangled.has(n)) return false;
        return true;
      };
      const slotOf = new Map<string, number>();
      for (const p of fdef.params) {
        if (!slotOf.has(p)) slotOf.set(p, slotOf.size);
      }
      const instrs = fdef.instructions;
      for (let idx = 0; idx < instrs.length; idx++) {
        const i = instrs[idx];
        if (i.op === 'LOAD' && isLocal(i.name)) {
          let s = slotOf.get(i.name);
          if (s === undefined) { s = slotOf.size; slotOf.set(i.name, s); }
          instrs[idx] = { op: 'LOAD_SLOT', slot: s, name: i.name, loc: i.loc };
        } else if (i.op === 'STORE' && isLocal(i.name)) {
          let s = slotOf.get(i.name);
          if (s === undefined) { s = slotOf.size; slotOf.set(i.name, s); }
          instrs[idx] = { op: 'STORE_SLOT', slot: s, loc: i.loc };
        } else if (i.op === 'STORE_VAR' && isLocal(i.name)) {
          let s = slotOf.get(i.name);
          if (s === undefined) { s = slotOf.size; slotOf.set(i.name, s); }
          instrs[idx] = { op: 'STORE_VAR_SLOT', slot: s, name: i.name, loc: i.loc };
        } else if (i.op === 'DELETE' && isLocal(i.name)) {
          let s = slotOf.get(i.name);
          if (s === undefined) { s = slotOf.size; slotOf.set(i.name, s); }
          instrs[idx] = { op: 'DELETE_SLOT', slot: s, loc: i.loc };
        }
      }
      fdef.slotCount = slotOf.size;
    }

    // Build exports table
    const exports = new Map<string, ImportedFunction>();
    for (const [localName, decl] of this.localFunctions) {
      if (!decl.exported) continue;
      exports.set(localName, {
        mangled: this.functionMangled.get(localName)!,
        signature: this.functionSignatures.get(localName)!,
        returnType: this.functionReturnTypes.get(localName)!,
        paramNames: decl.params.map(p => p.name),
      });
    }

    const structExports = new Map<string, ImportedStruct>();
    for (const [localName, info] of this.structs) {
      if (info.imported || !info.exported) continue;
      structExports.set(localName, {
        mangled: info.mangled,
        fields: info.fields,
        formatterName: info.formatterName ?? null,
      });
    }

    const aliasExports = new Map<string, ImportedAlias>();
    for (const [localName, info] of this.aliases) {
      if (info.imported || !info.exported) continue;
      aliasExports.set(localName, {
        mangled: info.mangled,
        resolved: info.resolved!,
      });
    }

    // Build the per-module structFormatters map. Includes both local structs
    // (whose formatters were just compiled into `this.functions`) and
    // imported structs that carry a formatterName from their home module.
    // Both flavors contribute so the loader can pass a single map through.
    const structFormatters = new Map<string, string>();
    for (const info of this.structs.values()) {
      if (info.formatterName) {
        structFormatters.set(info.mangled, info.formatterName);
      }
    }

    return { functions: this.functions, topLevel, exports, structExports, aliasExports, structFormatters };
  }

  // Compile a `format is EXPR` clause as a synthetic FunctionDef. `it` is the
  // sole param (struct value); the body is the user expression followed by
  // RETURN. The thunk lives in `this.functions` like any other function,
  // sees the home module's top-level bindings, and is invoked directly by
  // the VM's formatValue (not via the CALL opcode).
  private compileFormatThunk(
    localName: string,
    info: StructInfo,
    formatExpr: Expression,
    declLoc: SourceLocation | undefined,
  ): void {
    const structType: ChatterType = { kind: 'struct', mangled: info.mangled };
    const thunkName = `${info.mangled}::__format__`;
    info.formatterName = thunkName;

    const instructions: Instruction[] = [];
    const funcDef: FunctionDef = { name: thunkName, params: ['it'], instructions };
    this.functions.set(thunkName, funcDef);

    // Set up compiler state mimicking a typed function body that returns string.
    const funcBindings: Scope = new Scope(null, null);
    const prevReturnType = this.currentFuncReturnType;
    const prevFuncName = this.currentFuncName;
    this.currentFuncReturnType = { kind: 'scalar', name: 'string' };
    this.currentFuncName = `${localName}.__format__`;

    // Push `it` onto hofItStack so ItExpression compiles to LOAD `it`
    // (the param local) and staticType resolves `it` to the struct type.
    this.hofItStack.push({ local: 'it', type: structType });
    this.locStack.push(declLoc);
    try {
      // Static type check on the body. Must be `string` if knowable.
      const bt = this.staticType(formatExpr, funcBindings);
      if (bt !== null) {
        if (!(bt.kind === 'scalar' && bt.name === 'string')) {
          throw new CompileError(
            `'format is' body must produce a string, got ${typeToString(bt)}`,
            declLoc,
          );
        }
      }
      this.compileExpr(formatExpr, instructions, funcBindings);
      // Defensive runtime check: enforce string if static type was unknown.
      if (bt === null) {
        this.emit(instructions, {
          op: 'CHECK_TYPE',
          expected: 'string',
          context: `'format is' body must produce a string`,
        });
      }
      this.emit(instructions, { op: 'RETURN' });
    } finally {
      this.hofItStack.pop();
      this.locStack.pop();
      this.currentFuncReturnType = prevReturnType;
      this.currentFuncName = prevFuncName;
    }

    // Track the param `it` as a function local so the post-processor's
    // binding-mangling step doesn't rewrite LOAD/STORE for it.
    this.functionLocals.set(thunkName, new Set(['it', ...funcBindings.allMangledInFunction]));
  }

  private compileStatement(
    stmt: Statement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    this.locStack.push(locOf(stmt) ?? this.currentLoc);
    try {
      this.compileStatementInner(stmt, out, bindings);
    } finally {
      this.locStack.pop();
    }
  }

  private compileStatementInner(
    stmt: Statement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    switch (stmt.type) {
      case 'SayStatement':
        this.compileSay(stmt, out, bindings);
        break;
      case 'ConstantDeclaration':
        this.compileSet(stmt, out, bindings);
        break;
      case 'VarDeclaration':
        this.compileVarDecl(stmt, out, bindings);
        break;
      case 'ChangeStatement':
        this.compileChange(stmt, out, bindings);
        break;
      case 'ChangeItemStatement':
        this.compileChangeItem(stmt, out, bindings);
        break;
      case 'DictSetStatement':
        this.compileDictSet(stmt, out, bindings);
        break;
      case 'CompoundAssignStatement':
        this.compileCompoundAssign(stmt, out, bindings);
        break;
      case 'FunctionDeclaration':
        this.compileFuncDecl(stmt);
        break;
      case 'CallStatement': {
        this.compileCallStmt(stmt, out, bindings);
        const rt = this.functionReturnTypes.get(stmt.name);
        if (rt === null) {
          // Void call: discard the implicit 0 returned by the callee. Does NOT update `it`.
          this.emit(out, { op: 'DROP' });
        } else {
          this.emit(out, { op: 'STORE_IT' });
        }
        break;
      }
      case 'ReturnStatement':
        this.compileReturn(stmt, out, bindings);
        break;
      case 'IfStatement':
        this.compileIf(stmt, out, bindings);
        break;
      case 'RepeatStatement':
        this.compileRepeat(stmt, out, bindings);
        break;
      case 'AppendStatement':
        this.compileAppend(stmt, out, bindings);
        break;
      case 'PrependStatement':
        this.compilePrepend(stmt, out, bindings);
        break;
      case 'InsertStatement':
        this.compileInsert(stmt, out, bindings);
        break;
      case 'RemoveItemStatement':
        this.compileRemove(stmt, out, bindings);
        break;
      case 'RemoveValueStatement':
        this.compileRemoveValue(stmt, out, bindings);
        break;
      case 'ReadFileStatement':
        this.compileReadFileStatement(stmt, out, bindings);
        break;
      case 'ExpectStatement':
        this.compileExpect(stmt, out, bindings);
        break;
      case 'FailStatement':
        this.compileFail(stmt, out, bindings);
        break;
      case 'UseStatement':
        // Module system handled at loader level; nothing to emit here.
        break;
      case 'ExitRepeatStatement': {
        if (this.loopStack.length === 0) {
          throw new CompileError(
            `'exit repeat' outside of a repeat loop`,
            this.currentLoc,
          );
        }
        const frame = this.loopStack[this.loopStack.length - 1];
        const idx = out.length;
        this.emit(out, { op: 'JUMP', target: -1 });
        frame.exitJumps.push(idx);
        break;
      }
      case 'NextRepeatStatement': {
        if (this.loopStack.length === 0) {
          throw new CompileError(
            `'next repeat' outside of a repeat loop`,
            this.currentLoc,
          );
        }
        const frame = this.loopStack[this.loopStack.length - 1];
        const idx = out.length;
        this.emit(out, { op: 'JUMP', target: -1 });
        frame.continueJumps.push(idx);
        break;
      }
      case 'SortStatement':
        this.compileSort(stmt, out, bindings);
        break;
      case 'HofStatement':
        this.compileExpr(stmt.expr, out, bindings);
        this.emit(out, { op: 'STORE_IT' });
        break;
    }
  }

  private compileExpect(
    stmt: ExpectStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    // Static type check on predicate (skip when unknown).
    const pt = this.staticType(stmt.expression, bindings);
    if (pt && !(pt.kind === 'scalar' && pt.name === 'boolean')) {
      throw new CompileError(
        `expect requires a boolean, got ${typeToString(pt)}`,
      this.currentLoc);
    }

    if (!stmt.message) {
      this.compileExpr(stmt.expression, out, bindings);
      this.emit(out, { op: 'EXPECT', source: stmt.source });
      return;
    }

    // Statically reject non-string messages.
    const mt = this.staticType(stmt.message, bindings);
    if (mt && !(mt.kind === 'scalar' && mt.name === 'string')) {
      throw new CompileError(
        `expect message must be a string, got ${typeToString(mt)}`,
        this.currentLoc,
      );
    }

    // Emitted shape (message evaluated lazily, only on failure):
    //   <eval predicate>
    //   EXPECT_BOOL_CHECK         ; throws "expect requires a boolean, got X" if non-bool; peeks
    //   JUMP_IF_FALSE L_fail      ; pops; branch if false
    //   JUMP L_end
    // L_fail:
    //   <eval message>            ; pushes string (runtime type check below)
    //   EXPECT_FAIL_WITH_MSG      ; pops string, throws "expect failed: <msg>"
    // L_end:
    this.compileExpr(stmt.expression, out, bindings);
    this.emit(out, { op: 'EXPECT_BOOL_CHECK' });
    const jmpFail = out.length;
    this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
    const jmpEnd = out.length;
    this.emit(out, { op: 'JUMP', target: -1 });
    const failLabel = out.length;
    this.compileExpr(stmt.message, out, bindings);
    this.emit(out, { op: 'EXPECT_FAIL_WITH_MSG' });
    const endLabel = out.length;
    (out[jmpFail] as any).target = failLabel;
    (out[jmpEnd] as any).target = endLabel;
  }

  private compileFail(
    stmt: FailStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const mt = this.staticType(stmt.message, bindings);
    if (mt && !(mt.kind === 'scalar' && mt.name === 'string')) {
      throw new CompileError(
        `fail message must be a string, got ${typeToString(mt)}`,
        this.currentLoc,
      );
    }
    this.compileExpr(stmt.message, out, bindings);
    this.emit(out, { op: 'FAIL' });
  }

  private compileReadFileStatement(
    stmt: ReadFileStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const pt = this.staticType(stmt.path, bindings);
    if (pt && !(pt.kind === 'scalar' && pt.name === 'string')) {
      throw new CompileError(
        `'read file' requires a string path, got ${typeToString(pt)}`,
      this.currentLoc);
    }
    this.compileExpr(stmt.path, out, bindings);
    this.emit(out, { op: 'READ_FILE_LINES' });
    this.emit(out, { op: 'STORE_IT' });
  }

  private compileSay(
    stmt: SayStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (stmt.expressions.length === 1) {
      this.compileExpr(stmt.expressions[0], out, bindings);
      this.emit(out, { op: 'SAY' });
      return;
    }
    for (const expr of stmt.expressions) {
      this.compileExpr(expr, out, bindings);
    }
    this.emit(out, { op: 'SAY_MULTI', count: stmt.expressions.length });
  }

  private compilePrecall(
    precall: CallStatement,
    out: Instruction[],
    bindings: Scope,
  ): ChatterType {
    if (!this.functionReturnTypes.has(precall.name)) {
      throw new CompileError(
        `'the result of' refers to unknown function '${precall.name}'`,
        this.currentLoc,
      );
    }
    const rt = this.functionReturnTypes.get(precall.name);
    if (rt === null || rt === undefined) {
      throw new CompileError(
        `'the result of' requires a typed function, but '${precall.name}' is void`,
        this.currentLoc,
      );
    }
    this.compileCallStmt(precall, out, bindings);
    this.emit(out, { op: 'STORE_IT' });
    return rt;
  }

  // Validate a HOF body/predicate/start/key slot when filled via `the result of`.
  // The slot's value is a CallStatement only when produced by `tryConsumeTheResultOf`
  // (parser only allows this in statement-form HOFs and `sort by`). Surface a clear
  // error early so the caller gets `void function ...` wording instead of the
  // generic "cannot determine static type" path.
  private validateHofResultOfSlot(slot: Expression | undefined): void {
    if (!slot || slot.type !== 'CallStatement') return;
    const call = slot as CallStatement;
    if (!this.functionReturnTypes.has(call.name)) {
      throw new CompileError(
        `'the result of' refers to unknown function '${call.name}'`,
        this.currentLoc,
      );
    }
    const rt = this.functionReturnTypes.get(call.name);
    if (rt === null || rt === undefined) {
      throw new CompileError(
        `'the result of' requires a typed function, but '${call.name}' is void`,
        this.currentLoc,
      );
    }
  }

  private compileSet(
    stmt: ConstantDeclaration,
    out: Instruction[],
    bindings: Scope,
  ): void {
    // Determine type first, then declare (declare may throw shadow/dup error).
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      const mangled = bindings.declare(stmt.name, { kind: 'constant', type: rt }, this.currentLoc,
        bindings !== this.topLevelBindings && this.outerBindings.has(stmt.name));
      this.emit(out, { op: 'STORE', name: mangled });
      return;
    }
    this.compileExpr(stmt.value, out, bindings);
    const st = this.staticType(stmt.value, bindings);
    const mangled = bindings.declare(stmt.name, { kind: 'constant', type: st ?? undefined }, this.currentLoc,
      bindings !== this.topLevelBindings && this.outerBindings.has(stmt.name));
    this.emit(out, { op: 'STORE', name: mangled });
  }

  private compileVarDecl(
    stmt: VarDeclaration,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const extraOuter = bindings !== this.topLevelBindings && this.outerBindings.has(stmt.name);
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      const mangled = bindings.declare(stmt.name, { kind: 'var', type: rt }, this.currentLoc, extraOuter);
      this.emit(out, { op: 'STORE_VAR', name: mangled });
      return;
    }
    this.compileExpr(stmt.value, out, bindings);
    const st = this.staticType(stmt.value, bindings);
    const mangled = bindings.declare(stmt.name, { kind: 'var', type: st ?? undefined }, this.currentLoc, extraOuter);
    this.emit(out, { op: 'STORE_VAR', name: mangled });
  }

  private compileChange(
    stmt: ChangeStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const info = bindings.lookup(stmt.name);
    if (!info) {
      throw new CompileError(
        `Cannot change '${stmt.name}': no such variable declared in this function`,
      this.currentLoc);
    }
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot change '${stmt.name}': it is a ${info.kind === 'constant' ? "'constant' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'variable'`,
      this.currentLoc);
    }
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      if (info.type) {
        if (!typesEqual(info.type, rt)) {
          throw new CompileError(
            `Type mismatch: cannot change '${stmt.name}' from ${typeToString(info.type)} to ${typeToString(rt)}`,
            this.currentLoc,
          );
        }
      }
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'STORE_VAR', name: info.mangled });
      return;
    }
    // Static type check for list/uniqueList/dict vars: exact match required.
    if (info.type && (info.type.kind === 'list' || info.type.kind === 'uniqueList' || info.type.kind === 'dict')) {
      const rhs = this.staticType(stmt.value, bindings);
      if (rhs !== null && !typesEqual(rhs, info.type)) {
        throw new CompileError(
          `Type mismatch: cannot change '${stmt.name}' from ${typeToString(info.type)} to ${typeToString(rhs)}`,
        this.currentLoc);
      }
    }
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'STORE_VAR', name: info.mangled });
  }

  private compileChangeItem(
    stmt: ChangeItemStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const resolved = this.lookupBindingWithOuter(stmt.listName, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot change item of '${stmt.listName}': no such binding`,
      this.currentLoc);
    }
    const info = resolved.info;
    if (info.type && info.type.kind === 'uniqueList') {
      throw new CompileError(
        `'change item N of NAME' is not a unique-list operation; unique lists do not support random access (name '${stmt.listName}')`,
      this.currentLoc);
    }
    if (!info.type || info.type.kind !== 'list') {
      if (info.type) {
        throw new CompileError(
          `Cannot change item of '${stmt.listName}': not a list (type ${typeToString(info.type)})`,
        this.currentLoc);
      }
    } else {
      const rhs = this.staticType(stmt.value, bindings);
      const rc = elementCode(rhs);
      if (rc !== null && rc !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot assign ${elementHuman(rc)} to list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
    }
    // Emit: LOAD list; <index>; <value>; LIST_SET
    // If `end` sentinel appears in the index, stash the list in a tmp first
    // so we can compute length once for the sentinel.
    if (containsEndSentinel(stmt.index)) {
      const listTmp = this.freshName('chgitem_list');
      const lenTmp = this.freshName('chgitem_len');
      this.emit(out, { op: 'LOAD', name: info.mangled });
      this.emit(out, { op: 'STORE', name: listTmp });
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'LENGTH' });
      this.emit(out, { op: 'STORE', name: lenTmp });
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.endLenTmpStack.push(lenTmp);
      try { this.compileExpr(stmt.index, out, bindings); } finally { this.endLenTmpStack.pop(); }
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'LIST_SET' });
      this.emit(out, { op: 'DELETE', name: listTmp });
      this.emit(out, { op: 'DELETE', name: lenTmp });
    } else {
      this.emit(out, { op: 'LOAD', name: info.mangled });
      this.compileExpr(stmt.index, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'LIST_SET' });
    }
  }

  private compileListMutationTarget(listName: string, bindings: Scope, op: string): { type: ChatterType | null; mangled: string } {
    const resolved = this.lookupBindingWithOuter(listName, bindings);
    if (!resolved) {
      throw new CompileError(`Cannot ${op} to '${listName}': no such binding`, this.currentLoc);
    }
    const info = resolved.info;
    if (info.type && info.type.kind === 'uniqueList') {
      throw new CompileError(
        `'${op}' is a list operation; unique lists use 'add' / 'remove EXPR from NAME' instead (name '${listName}')`,
      this.currentLoc);
    }
    if (info.type && info.type.kind !== 'list') {
      throw new CompileError(
        `Cannot ${op} to '${listName}': not a list (type ${typeToString(info.type)})`,
      this.currentLoc);
    }
    return { type: info.type ?? null, mangled: info.mangled };
  }

  private checkElementType(
    listType: ChatterType | null,
    value: Expression,
    bindings: Scope,
    op: string,
  ): void {
    if (listType && listType.kind === 'list') {
      const rhs = this.staticType(value, bindings);
      const rc = elementCode(rhs);
      if (rc !== null && rc !== listType.element) {
        throw new CompileError(
          `Type mismatch: cannot ${op} ${elementHuman(rc)} to list of ${elementHuman(listType.element)}`,
        this.currentLoc);
      }
      if (rhs && (rhs.kind === 'list' || rhs.kind === 'uniqueList')) {
        throw new CompileError(
          `Type mismatch: cannot ${op} a list value to list of ${elementHuman(listType.element)}`,
        this.currentLoc);
      }
    }
  }

  private compileAppend(
    stmt: AppendStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'append');
    this.checkElementType(lt.type, stmt.value, bindings, 'append');
    this.emit(out, { op: 'LOAD', name: lt.mangled });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_APPEND' });
  }

  private compilePrepend(
    stmt: PrependStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'prepend');
    this.checkElementType(lt.type, stmt.value, bindings, 'prepend');
    this.emit(out, { op: 'LOAD', name: lt.mangled });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_PREPEND' });
  }

  private compileInsert(
    stmt: InsertStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'insert');
    this.checkElementType(lt.type, stmt.value, bindings, 'insert');
    this.emit(out, { op: 'LOAD', name: lt.mangled });
    this.compileExpr(stmt.index, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_INSERT' });
  }

  private compileRemove(
    stmt: RemoveItemStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'remove');
    this.emit(out, { op: 'LOAD', name: lt.mangled });
    this.compileExpr(stmt.index, out, bindings);
    this.emit(out, { op: 'LIST_REMOVE' });
  }

  private compileRemoveValue(
    stmt: RemoveValueStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const resolved = this.lookupBindingWithOuter(stmt.listName, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot remove value from '${stmt.listName}': no such binding`,
      this.currentLoc);
    }
    const info = resolved.info;
    if (info.type) {
      if (info.type.kind === 'list') {
        throw new CompileError(
          `'remove EXPR from NAME' is not a list operation; use 'remove item N from NAME' (name '${stmt.listName}')`,
        this.currentLoc);
      }
      if (info.type.kind === 'dict') {
        const rhs = this.staticType(stmt.value, bindings);
        const rc = elementCode(rhs);
        if (rc !== null && rc !== info.type.keyType) {
          throw new CompileError(
            `Type mismatch: dictionary key has type ${elementHuman(info.type.keyType)}, got ${elementHuman(rc)}`,
          this.currentLoc);
        }
        this.emit(out, { op: 'LOAD', name: info.mangled });
        this.compileExpr(stmt.value, out, bindings);
        this.emit(out, { op: 'DICT_REMOVE' });
        return;
      }
      if (info.type.kind !== 'uniqueList') {
        throw new CompileError(
          `Cannot remove value from '${stmt.listName}': not a unique list or dictionary (type ${typeToString(info.type)})`,
        this.currentLoc);
      }
      // Element-type check.
      const rhs = this.staticType(stmt.value, bindings);
      const rc = elementCode(rhs);
      if (rc !== null && rc !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot remove ${elementHuman(rc)} from unique list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
      if (rhs && (rhs.kind === 'list' || rhs.kind === 'uniqueList' || rhs.kind === 'dict')) {
        throw new CompileError(
          `Type mismatch: cannot remove ${typeToString(rhs)} from unique list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
    }
    this.emit(out, { op: 'LOAD', name: info.mangled });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'UNIQUE_LIST_REMOVE' });
  }

  private compileCompoundAssign(
    stmt: CompoundAssignStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const target = stmt.target;
    if (target.kind === 'listItem') {
      this.compileCompoundAssignListItem(stmt, target, out, bindings);
      return;
    }
    if (target.kind === 'dictValue') {
      this.compileCompoundAssignDictValue(stmt, target, out, bindings);
      return;
    }
    const name = target.name;
    const resolved = this.lookupBindingWithOuter(name, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot ${stmt.op} '${name}': no such variable declared in this function`,
      this.currentLoc);
    }
    const info = resolved.info;
    // `add EXPR to NAME` is overloaded: for unique-list bindings, route to UNIQUE_LIST_ADD.
    // De underlying unique list is mutable through aliases, so dis works on any binding
    // (including module top-level).
    if (stmt.op === 'add' && info.type && info.type.kind === 'uniqueList') {
      const rhs = this.staticType(stmt.value, bindings);
      const rc = elementCode(rhs);
      if (rc !== null && rc !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot add ${elementHuman(rc)} to unique list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
      if (rhs && (rhs.kind === 'list' || rhs.kind === 'uniqueList')) {
        throw new CompileError(
          `Type mismatch: cannot add ${typeToString(rhs)} to unique list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
      this.emit(out, { op: 'LOAD', name: info.mangled });
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'UNIQUE_LIST_ADD' });
      return;
    }
    // `add EXPR to NAME` on a list → helpful error pointing at append/prepend/insert at.
    if (stmt.op === 'add' && info.type && info.type.kind === 'list') {
      throw new CompileError(
        `'add' cannot insert into a list (use 'append', 'prepend', or 'insert at' for '${name}')`,
      this.currentLoc);
    }
    // Bare-NAME arithmetic sugar on a number variable is restricted to de
    // current function body's scope chain (parallel to `change NAME to V`).
    if (resolved.fromOuter) {
      throw new CompileError(
        `Cannot ${stmt.op} '${name}': arithmetic sugar can only target variables declared in this function (use 'change item N of L' or 'change value of K in D' to mutate module-top-level collections)`,
      this.currentLoc);
    }
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot ${stmt.op} '${name}': it is a ${info.kind === 'constant' ? "'constant' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'variable'`,
      this.currentLoc);
    }
    if (info.type !== undefined && !(info.type.kind === 'scalar' && info.type.name === 'number')) {
      throw new CompileError(
        `Cannot ${stmt.op} '${name}': its type is ${typeToString(info.type)}, not number`,
      this.currentLoc);
    }
    // Emit: LOAD name; <value>; OP; STORE_VAR name
    this.emit(out, { op: 'LOAD', name: info.mangled });
    this.compileExpr(stmt.value, out, bindings);
    this.emitArithOp(stmt.op, out);
    this.emit(out, { op: 'STORE_VAR', name: info.mangled });
  }

  private emitArithOp(op: 'add' | 'subtract' | 'multiply' | 'divide', out: Instruction[]): void {
    switch (op) {
      case 'add':      this.emit(out, { op: 'ADD' }); break;
      case 'subtract': this.emit(out, { op: 'SUB' }); break;
      case 'multiply': this.emit(out, { op: 'MUL' }); break;
      case 'divide':   this.emit(out, { op: 'DIV' }); break;
    }
  }

  private compileCompoundAssignListItem(
    stmt: CompoundAssignStatement,
    target: { kind: 'listItem'; listName: string; index: Expression },
    out: Instruction[],
    bindings: Scope,
  ): void {
    const resolved = this.lookupBindingWithOuter(target.listName, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot ${stmt.op} item of '${target.listName}': no such binding`,
      this.currentLoc);
    }
    const info = resolved.info;
    if (info.type && info.type.kind === 'uniqueList') {
      throw new CompileError(
        `'${stmt.op} ... item N of NAME' is not a unique-list operation; unique lists do not support random access (name '${target.listName}')`,
      this.currentLoc);
    }
    if (info.type && info.type.kind !== 'list') {
      throw new CompileError(
        `Cannot ${stmt.op} item of '${target.listName}': not a list (type ${typeToString(info.type)})`,
      this.currentLoc);
    }
    if (info.type && info.type.kind === 'list' && info.type.element !== 'number') {
      throw new CompileError(
        `Cannot ${stmt.op} item of '${target.listName}': its element type is ${elementHuman(info.type.element)}, not number`,
      this.currentLoc);
    }
    const listTmp = this.freshName('cassign_list');
    const idxTmp = this.freshName('cassign_idx');
    // Stash list and index once so the read and write see identical values.
    this.emit(out, { op: 'LOAD', name: info.mangled });
    this.emit(out, { op: 'STORE', name: listTmp });
    if (containsEndSentinel(target.index)) {
      const lenTmp = this.freshName('cassign_len');
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'LENGTH' });
      this.emit(out, { op: 'STORE', name: lenTmp });
      this.endLenTmpStack.push(lenTmp);
      try { this.compileExpr(target.index, out, bindings); } finally { this.endLenTmpStack.pop(); }
      this.emit(out, { op: 'STORE', name: idxTmp });
      this.emit(out, { op: 'DELETE', name: lenTmp });
    } else {
      this.compileExpr(target.index, out, bindings);
      this.emit(out, { op: 'STORE', name: idxTmp });
    }
    // Build LIST_SET stack: list, index, newValue
    this.emit(out, { op: 'LOAD', name: listTmp });
    this.emit(out, { op: 'LOAD', name: idxTmp });
    // newValue = oldValue OP rhs
    this.emit(out, { op: 'LOAD', name: listTmp });
    this.emit(out, { op: 'LOAD', name: idxTmp });
    this.emit(out, { op: 'LIST_GET' });
    this.compileExpr(stmt.value, out, bindings);
    this.emitArithOp(stmt.op, out);
    this.emit(out, { op: 'LIST_SET' });
    this.emit(out, { op: 'DELETE', name: listTmp });
    this.emit(out, { op: 'DELETE', name: idxTmp });
  }

  private compileCompoundAssignDictValue(
    stmt: CompoundAssignStatement,
    target: { kind: 'dictValue'; dictName: string; key: Expression },
    out: Instruction[],
    bindings: Scope,
  ): void {
    const resolved = this.lookupBindingWithOuter(target.dictName, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot ${stmt.op} value in '${target.dictName}': no such binding`,
      this.currentLoc);
    }
    const info = resolved.info;
    if (info.type) {
      if (info.type.kind !== 'dict') {
        throw new CompileError(
          `Cannot ${stmt.op} value in '${target.dictName}': not a dictionary (type ${typeToString(info.type)})`,
        this.currentLoc);
      }
      if (info.type.valueType !== 'number') {
        throw new CompileError(
          `Cannot ${stmt.op} value in '${target.dictName}': its value type is ${elementHuman(info.type.valueType)}, not number`,
        this.currentLoc);
      }
      const kt = this.staticType(target.key, bindings);
      const kc = elementCode(kt);
      if (kc !== null && kc !== info.type.keyType) {
        throw new CompileError(
          `Type mismatch: dictionary key has type ${elementHuman(info.type.keyType)}, got ${elementHuman(kc)}`,
        this.currentLoc);
      }
    }
    const dictTmp = this.freshName('cassign_dict');
    const keyTmp = this.freshName('cassign_key');
    this.emit(out, { op: 'LOAD', name: info.mangled });
    this.emit(out, { op: 'STORE', name: dictTmp });
    this.compileExpr(target.key, out, bindings);
    this.emit(out, { op: 'STORE', name: keyTmp });
    // Build DICT_SET stack: dict, key, newValue
    this.emit(out, { op: 'LOAD', name: dictTmp });
    this.emit(out, { op: 'LOAD', name: keyTmp });
    // newValue = oldValue OP rhs
    this.emit(out, { op: 'LOAD', name: dictTmp });
    this.emit(out, { op: 'LOAD', name: keyTmp });
    this.emit(out, { op: 'DICT_GET' });
    this.compileExpr(stmt.value, out, bindings);
    this.emitArithOp(stmt.op, out);
    this.emit(out, { op: 'DICT_SET' });
    this.emit(out, { op: 'DELETE', name: dictTmp });
    this.emit(out, { op: 'DELETE', name: keyTmp });
  }

  private compileFuncDecl(stmt: FunctionDeclaration): void {
    const params = stmt.params.map(p => p.name);

    // Params may not shadow outer-scope bindings
    for (const param of params) {
      if (this.outerBindings.has(param)) {
        throw new CompileError(
          `Parameter '${param}' in function '${stmt.name}' shadows outer binding`,
        this.currentLoc);
      }
    }

    // Typed functions: every execution path must end with an explicit `return EXPR`.
    if (stmt.returnType !== null) {
      if (!blockTerminates(stmt.body)) {
        throw new CompileError(
          `missing return in typed function '${stmt.name}'; every path must return a ${typeToString(this.fromAnnotation(stmt.returnType))}`,
        this.currentLoc);
      }
    }

    const instructions: Instruction[] = [];
    const mangledName = this.functionMangled.get(stmt.name) ?? stmt.name;
    const funcDef: FunctionDef = { name: mangledName, params, instructions };
    this.functions.set(mangledName, funcDef);

    const funcBindings: Scope = new Scope(null, null);
    for (const p of stmt.params) {
      funcBindings.declare(p.name, {
        kind: 'param',
        type: this.fromAnnotation(p.paramType),
      }, this.currentLoc);
    }
    const prevReturnType = this.currentFuncReturnType;
    const prevFuncName = this.currentFuncName;
    this.currentFuncReturnType = stmt.returnType === null ? null : this.fromAnnotation(stmt.returnType);
    this.currentFuncName = stmt.name;
    try {
      for (const bodyStmt of stmt.body) {
        this.compileStatement(bodyStmt, instructions, funcBindings);
      }
    } finally {
      this.currentFuncReturnType = prevReturnType;
      this.currentFuncName = prevFuncName;
    }
    if (stmt.returnType === null) {
      // Void: implicit `return 0` so the call site has a value to DROP.
      this.emit(instructions, { op: 'PUSH_INT', value: 0 });
      this.emit(instructions, { op: 'RETURN' });
    }
    // Snapshot every name minted inside this function (params + block-scope
    // locals + compiler temps). The post-processor uses this to avoid
    // rewriting local references when a local shares a name with a top-level
    // binding.
    this.functionLocals.set(mangledName, new Set(funcBindings.allMangledInFunction));
  }

  private compileCallStmt(
    stmt: CallStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const sig = this.functionSignatures.get(stmt.name);

    if (sig !== undefined) {
      const bound: Array<Expression | undefined> = new Array(sig.length).fill(undefined);
      let positionalUsed = false;

      for (const arg of stmt.args) {
        if (arg.name === null) {
          if (positionalUsed) {
            throw new CompileError(
              `Multiple positional arguments in call to '${stmt.name}'`,
            this.currentLoc);
          }
          if (sig.length === 0) {
            throw new CompileError(
              `Function '${stmt.name}' takes no arguments`,
            this.currentLoc);
          }
          bound[0] = arg.value;
          positionalUsed = true;
        } else {
          let idx = -1;
          for (let i = 0; i < sig.length; i++) {
            if (bound[i] === undefined && sig[i].label === arg.name) {
              idx = i;
              break;
            }
          }
          if (idx === -1) {
            const anyMatch = sig.some(p => p.label === arg.name);
            if (anyMatch) {
              throw new CompileError(
                `Too many arguments with label '${arg.name}' in call to '${stmt.name}'`,
              this.currentLoc);
            }
            throw new CompileError(
              `Unknown argument label '${arg.name}' in call to '${stmt.name}'`,
            this.currentLoc);
          }
          bound[idx] = arg.value;
        }
      }

      for (let i = 0; i < sig.length; i++) {
        if (bound[i] === undefined) {
          throw new CompileError(
            `Missing argument for parameter '${sig[i].name}' in call to '${stmt.name}'`,
          this.currentLoc);
        }
        const argExpr = bound[i]!;
        // Static type check for arguments.
        const paramType = sig[i].type;
        const argType = this.staticType(argExpr, bindings);
        if (argType !== null) {
          // Aggregate kind matching: kinds must match exactly between list / unique list / scalar.
          if (paramType.kind !== argType.kind) {
            throw new CompileError(
              `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
            this.currentLoc);
          }
          if (paramType.kind === 'list' && argType.kind === 'list') {
            if (argType.element !== paramType.element) {
              throw new CompileError(
                `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
              this.currentLoc);
            }
          } else if (paramType.kind === 'uniqueList' && argType.kind === 'uniqueList') {
            if (argType.element !== paramType.element) {
              throw new CompileError(
                `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
              this.currentLoc);
            }
          } else if (paramType.kind === 'dict' && argType.kind === 'dict') {
            if (argType.keyType !== paramType.keyType || argType.valueType !== paramType.valueType) {
              throw new CompileError(
                `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
              this.currentLoc);
            }
          } else if (paramType.kind === 'struct' && argType.kind === 'struct') {
            if (paramType.mangled !== argType.mangled) {
              throw new CompileError(
                `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
              this.currentLoc);
            }
          } else if (paramType.kind === 'scalar' && argType.kind === 'scalar') {
            // Scalar kinds match — element-name check delegated to existing runtime / future static.
          }
        }
        this.compileExpr(argExpr, out, bindings);
      }

      this.emit(out, { op: 'CALL', name: stmt.name, argCount: sig.length });
    } else {
      for (const arg of stmt.args) {
        this.compileExpr(arg.value, out, bindings);
      }
      this.emit(out, { op: 'CALL', name: stmt.name, argCount: stmt.args.length });
    }
  }

  private compileIf(
    stmt: IfStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const exitJumps: number[] = [];

    for (const branch of stmt.branches) {
      const ct = this.staticType(branch.condition, bindings);
      if (ct && !(ct.kind === 'scalar' && ct.name === 'boolean')) {
        throw new CompileError(
          `Type mismatch: 'if' condition must be a boolean, got ${typeToString(ct)}`,
        this.currentLoc);
      }
      this.compileExpr(branch.condition, out, bindings);
      const jifIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

      const branchScope = new Scope(bindings);
      for (const s of branch.body) {
        this.compileStatement(s, out, branchScope);
      }

      const exitIdx = out.length;
      this.emit(out, { op: 'JUMP', target: -1 });
      exitJumps.push(exitIdx);

      (out[jifIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
    }

    if (stmt.elseBody) {
      const elseScope = new Scope(bindings);
      for (const s of stmt.elseBody) {
        this.compileStatement(s, out, elseScope);
      }
    }

    const endIdx = out.length;
    for (const j of exitJumps) {
      (out[j] as { op: 'JUMP'; target: number }).target = endIdx;
    }
  }

  private compileRepeat(
    stmt: RepeatStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (stmt.kind === 'times') {
      // Static type check on count.
      const countT = this.staticType(stmt.count, bindings);
      if (countT && !(countT.kind === 'scalar' && countT.name === 'number')) {
        throw new CompileError(
          `Type mismatch: 'repeat N times' requires a number, got ${typeToString(countT)}`,
        this.currentLoc);
      }
      // Literal-negative count: surface at compile time.
      if (stmt.count.type === 'NumberLiteral' && stmt.count.value < 0) {
        throw new CompileError(
          `repeat count cannot be negative, got ${stmt.count.value}`,
        this.currentLoc);
      }
      if (
        stmt.count.type === 'UnaryExpression' &&
        stmt.count.operator === '-' &&
        stmt.count.operand.type === 'NumberLiteral' &&
        stmt.count.operand.value > 0
      ) {
        throw new CompileError(
          `repeat count cannot be negative, got ${-stmt.count.operand.value}`,
        this.currentLoc);
      }
      const limit = this.freshName('limit');
      const counter = this.freshName('counter');

      this.compileExpr(stmt.count, out, bindings);
      this.emit(out, { op: 'STORE', name: limit });
      this.emit(out, { op: 'PUSH_INT', value: 0 });
      this.emit(out, { op: 'STORE', name: counter });

      this.emit(out, { op: 'LOAD', name: limit });
      this.emit(out, { op: 'PUSH_INT', value: 0 });
      this.emit(out, { op: 'LT' });
      const jifNegIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
      this.emit(out, { op: 'ERROR', message: 'repeat count cannot be negative' });
      (out[jifNegIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;

      const topIdx = out.length;
      this.emit(out, { op: 'LOAD', name: counter });
      this.emit(out, { op: 'LOAD', name: limit });
      this.emit(out, { op: 'LT' });
      const jifEndIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

      const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
      this.loopStack.push(frame);
      const bodyScope = new Scope(bindings);
      for (const s of stmt.body) {
        this.compileStatement(s, out, bodyScope);
      }
      this.loopStack.pop();

      const continueIdx = out.length;
      this.emit(out, { op: 'LOAD', name: counter });
      this.emit(out, { op: 'PUSH_INT', value: 1 });
      this.emit(out, { op: 'ADD' });
      this.emit(out, { op: 'STORE', name: counter });
      this.emit(out, { op: 'JUMP', target: topIdx });
      const exitIdx = out.length;
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
      for (const j of frame.continueJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = continueIdx;
      }
      for (const j of frame.exitJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = exitIdx;
      }
      return;
    }

    if (stmt.kind === 'range') {
      const loopVar = stmt.varName;
      // Pre-check shadow against module top-level outer bindings.
      if (this.outerBindings.has(loopVar) && bindings !== this.topLevelBindings) {
        throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`, this.currentLoc);
      }

      const limit = this.freshName('limit');

      // Validate step (if present) and determine whether a runtime check is needed.
      let stepIsKnownPositive = false;
      if (stmt.step !== undefined) {
        const step = stmt.step;
        // Literal-positive or literal-non-positive detection.
        if (step.type === 'NumberLiteral') {
          if (step.value < 1) {
            throw new CompileError(
              `step in 'repeat' must be positive (at least 1), got ${step.value}`,
            this.currentLoc);
          }
          stepIsKnownPositive = true;
        } else if (
          step.type === 'UnaryExpression' &&
          step.operator === '-' &&
          step.operand.type === 'NumberLiteral'
        ) {
          throw new CompileError(
            `step in 'repeat' must be positive (at least 1), got ${-step.operand.value}`,
          this.currentLoc);
        } else {
          const st = this.staticType(step, bindings);
          if (st && !(st.kind === 'scalar' && st.name === 'number')) {
            throw new CompileError(
              `step in 'repeat' must be a number, got ${typeToString(st)}`,
            this.currentLoc);
          }
        }
      }

      // Declare loop var in the body's scope so its mangled name is fixed
      // before we emit the STOREs that initialize it.
      const bodyScope = new Scope(bindings);
      // declare() handles the shadow-against-ancestor check; remap the
      // error message to reuse "Loop variable" wording for consistency.
      let loopVarMangled: string;
      try {
        loopVarMangled = bodyScope.declare(loopVar, { kind: 'loop', type: { kind: 'scalar', name: 'number' } }, this.currentLoc);
      } catch (e) {
        if (e instanceof CompileError && /shadows outer binding|already declared/.test(e.message)) {
          throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`, this.currentLoc);
        }
        throw e;
      }

      this.compileExpr(stmt.from, out, bindings);
      this.emit(out, { op: 'STORE', name: loopVarMangled });
      this.compileExpr(stmt.to, out, bindings);
      this.emit(out, { op: 'STORE', name: limit });

      let stepTmp: string | null = null;
      if (stmt.step !== undefined) {
        stepTmp = this.freshName('step');
        this.compileExpr(stmt.step, out, bindings);
        this.emit(out, { op: 'STORE', name: stepTmp });
        if (!stepIsKnownPositive) {
          // Runtime check: step >= 1, else raise.
          this.emit(out, { op: 'LOAD', name: stepTmp });
          this.emit(out, { op: 'PUSH_INT', value: 1 });
          this.emit(out, { op: 'LT' });
          const jifSkipIdx = out.length;
          this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
          this.emit(out, {
            op: 'ERROR',
            message: `step in 'repeat' must be positive (at least 1)`,
          });
          (out[jifSkipIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
        }
      }

      const topIdx = out.length;
      this.emit(out, { op: 'LOAD', name: loopVarMangled });
      this.emit(out, { op: 'LOAD', name: limit });
      this.emit(out, { op: 'LE' });
      const jifEndIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

      const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
      this.loopStack.push(frame);
      for (const s of stmt.body) {
        this.compileStatement(s, out, bodyScope);
      }
      this.loopStack.pop();

      const continueIdx = out.length;
      this.emit(out, { op: 'LOAD', name: loopVarMangled });
      if (stepTmp !== null) {
        this.emit(out, { op: 'LOAD', name: stepTmp });
      } else {
        this.emit(out, { op: 'PUSH_INT', value: 1 });
      }
      this.emit(out, { op: 'ADD' });
      this.emit(out, { op: 'STORE', name: loopVarMangled });
      this.emit(out, { op: 'JUMP', target: topIdx });
      const exitIdx = out.length;
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
      for (const j of frame.continueJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = continueIdx;
      }
      for (const j of frame.exitJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = exitIdx;
      }
      this.emit(out, { op: 'DELETE', name: limit });
      if (stepTmp !== null) {
        this.emit(out, { op: 'DELETE', name: stepTmp });
      }
      return;
    }

    if (stmt.kind === 'list') {
      const loopVar = stmt.varName;
      if (this.outerBindings.has(loopVar) && bindings !== this.topLevelBindings) {
        throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`, this.currentLoc);
      }

      // Determine element type if statically known.
      const lt = this.staticType(stmt.list, bindings);
      let elemType: ChatterType | undefined;
      if (lt) {
        if (lt.kind !== 'list' && lt.kind !== 'uniqueList') {
          throw new CompileError(
            `'repeat with x in ...' requires a list or unique list, got ${typeToString(lt)}`,
          this.currentLoc);
        }
        elemType = lt.element.startsWith('struct:')
          ? { kind: 'struct', mangled: lt.element.slice(7) }
          : { kind: 'scalar', name: lt.element as ScalarTypeName };
      }

      const listTmp = this.freshName('list');
      const idxTmp = this.freshName('idx');
      const lenTmp = this.freshName('len');

      const bodyScope = new Scope(bindings);
      let loopVarMangled: string;
      try {
        loopVarMangled = bodyScope.declare(loopVar, { kind: 'loop', type: elemType }, this.currentLoc);
      } catch (e) {
        if (e instanceof CompileError && /shadows outer binding|already declared/.test(e.message)) {
          throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`, this.currentLoc);
        }
        throw e;
      }

      this.compileExpr(stmt.list, out, bindings);
      this.emit(out, { op: 'STORE', name: listTmp });
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'LENGTH' });
      this.emit(out, { op: 'STORE', name: lenTmp });
      this.emit(out, { op: 'PUSH_INT', value: 1 });
      this.emit(out, { op: 'STORE', name: idxTmp });

      const topIdx = out.length;
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'LOAD', name: lenTmp });
      this.emit(out, { op: 'LE' });
      const jifEndIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

      // Bind loop var to current element.
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'LIST_GET' });
      this.emit(out, { op: 'STORE', name: loopVarMangled });

      const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
      this.loopStack.push(frame);
      for (const s of stmt.body) {
        this.compileStatement(s, out, bodyScope);
      }
      this.loopStack.pop();

      const continueIdx = out.length;
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'PUSH_INT', value: 1 });
      this.emit(out, { op: 'ADD' });
      this.emit(out, { op: 'STORE', name: idxTmp });
      this.emit(out, { op: 'JUMP', target: topIdx });
      const exitIdx = out.length;
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
      for (const j of frame.continueJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = continueIdx;
      }
      for (const j of frame.exitJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = exitIdx;
      }
      this.emit(out, { op: 'DELETE', name: listTmp });
      this.emit(out, { op: 'DELETE', name: idxTmp });
      this.emit(out, { op: 'DELETE', name: lenTmp });
      return;
    }

    // while
    const wct = this.staticType(stmt.condition, bindings);
    if (wct && !(wct.kind === 'scalar' && wct.name === 'boolean')) {
      throw new CompileError(
        `Type mismatch: 'repeat while' requires a boolean, got ${typeToString(wct)}`,
      this.currentLoc);
    }
    const topIdx = out.length;
    this.compileExpr(stmt.condition, out, bindings);
    const jifEndIdx = out.length;
    this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
    const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
    this.loopStack.push(frame);
    const bodyScope = new Scope(bindings);
    for (const s of stmt.body) {
      this.compileStatement(s, out, bodyScope);
    }
    this.loopStack.pop();
    const continueIdx = out.length;
    this.emit(out, { op: 'JUMP', target: topIdx });
    const exitIdx = out.length;
    (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
    for (const j of frame.continueJumps) {
      (out[j] as { op: 'JUMP'; target: number }).target = topIdx;
    }
    for (const j of frame.exitJumps) {
      (out[j] as { op: 'JUMP'; target: number }).target = exitIdx;
    }
    // continueIdx is emitted for symmetry but unused beyond the JUMP above.
    void continueIdx;
  }

  private compileReturn(
    stmt: ReturnStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const rt = this.currentFuncReturnType;
    if (rt === undefined) {
      throw new CompileError(`'return' outside of function body`, this.currentLoc);
    }
    if (rt === null) {
      // Void function
      if (stmt.value !== null) {
        throw new CompileError(
          `void function '${this.currentFuncName}' cannot return a value`,
        this.currentLoc);
      }
      this.emit(out, { op: 'PUSH_INT', value: 0 });
      this.emit(out, { op: 'RETURN' });
      return;
    }
    // Typed function
    if (stmt.value === null) {
      throw new CompileError(
        `typed function '${this.currentFuncName}' must return a ${typeToString(rt)}`,
      this.currentLoc);
    }
    if (stmt.precall) {
      const callRt = this.compilePrecall(stmt.precall, out, bindings);
      if (!typesEqual(callRt, rt)) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(callRt)}`,
          this.currentLoc,
        );
      }
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'RETURN' });
      return;
    }
    const st = this.staticType(stmt.value, bindings);
    if (st !== null) {
      if (st.kind !== rt.kind) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
        this.currentLoc);
      }
      if (rt.kind === 'scalar' && st.kind === 'scalar' && rt.name !== st.name) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${rt.name}, but return expression has type ${st.name}`,
        this.currentLoc);
      }
      if (rt.kind === 'list' && st.kind === 'list') {
        if (rt.element !== st.element) {
          throw new CompileError(
            `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
          this.currentLoc);
        }
      }
      if (rt.kind === 'uniqueList' && st.kind === 'uniqueList') {
        if (rt.element !== st.element) {
          throw new CompileError(
            `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
          this.currentLoc);
        }
      }
      if (rt.kind === 'dict' && st.kind === 'dict') {
        if (rt.keyType !== st.keyType || rt.valueType !== st.valueType) {
          throw new CompileError(
            `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
          this.currentLoc);
        }
      }
    }
    this.compileExpr(stmt.value, out, bindings);
    if (st === null && rt.kind === 'scalar') {
      this.emit(out, {
        op: 'CHECK_TYPE',
        expected: rt.name,
        context: `function '${this.currentFuncName}' return value`,
      });
    }
    this.emit(out, { op: 'RETURN' });
  }

  private compileExpr(
    expr: Expression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    this.locStack.push(locOf(expr) ?? this.currentLoc);
    try {
      this.compileExprInner(expr, out, bindings);
    } finally {
      this.locStack.pop();
    }
  }

  private compileExprInner(
    expr: Expression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    switch (expr.type) {
      case 'NumberLiteral':
        this.emit(out, { op: 'PUSH_INT', value: expr.value });
        break;
      case 'StringLiteral':
        this.emit(out, { op: 'PUSH_STR', value: expr.value });
        break;
      case 'BooleanLiteral':
        this.emit(out, { op: 'PUSH_BOOL', value: expr.value });
        break;
      case 'IdentifierExpression':
        if (expr.name === 'accumulator') {
          if (this.hofAccStack.length === 0) {
            throw new CompileError(
              `'accumulator' can only be used inside a reduce body`,
            this.currentLoc);
          }
          this.emit(out, { op: 'LOAD', name: this.hofAccStack[this.hofAccStack.length - 1].local });
          break;
        }
        if (this.functionReturnTypes.get(expr.name) === null) {
          throw new CompileError(
            `void function '${expr.name}' cannot be used as a value`,
          this.currentLoc);
        }
        const scopeInfo = bindings.lookup(expr.name);
        if (!this.functionReturnTypes.has(expr.name)
            && !scopeInfo
            && !this.outerBindings.has(expr.name)) {
          throw new CompileError(
            `Undefined variable: '${expr.name}'`,
          this.currentLoc);
        }
        this.emit(out, { op: 'LOAD', name: scopeInfo?.mangled ?? expr.name });
        break;
      case 'ItExpression':
        if (this.hofItStack.length > 0) {
          this.emit(out, { op: 'LOAD', name: this.hofItStack[this.hofItStack.length - 1].local });
        } else {
          this.emit(out, { op: 'LOAD_IT' });
        }
        break;
      case 'BinaryExpression':
        this.compileBinary(expr, out, bindings);
        break;
      case 'UnaryExpression':
        if (expr.operator === '-') {
          const t = this.staticType(expr.operand, bindings);
          if (t && !(t.kind === 'scalar' && t.name === 'number')) {
            throw new CompileError(
              `unary '-' requires number, got ${typeToString(t)}`,
            this.currentLoc);
          }
          this.emit(out, { op: 'PUSH_INT', value: 0 });
          this.compileExpr(expr.operand, out, bindings);
          this.emit(out, { op: 'SUB' });
        } else {
          const t = this.staticType(expr.operand, bindings);
          if (t && !(t.kind === 'scalar' && t.name === 'boolean')) {
            throw new CompileError(
              `Type mismatch: 'not' requires a boolean, got ${typeToString(t)}`,
            this.currentLoc);
          }
          this.compileExpr(expr.operand, out, bindings);
          this.emit(out, { op: 'NOT' });
        }
        break;
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        if (rt === null) {
          throw new CompileError(
            `void function '${expr.name}' cannot be used as a value`,
          this.currentLoc);
        }
        this.compileCallStmt(expr, out, bindings);
        break;
      }
      case 'ListLiteral':
        this.compileListLiteral(expr, out, bindings);
        break;
      case 'UniqueListLiteral':
        this.compileUniqueListLiteral(expr, out, bindings);
        break;
      case 'DictionaryLiteral':
        this.compileDictionaryLiteral(expr, out, bindings);
        break;
      case 'DictGetExpression':
        this.compileDictGet(expr, out, bindings);
        break;
      case 'ItemAccessExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind === 'uniqueList') {
          throw new CompileError(
            `'item N of X' is a list operation; unique lists do not support random access`,
          this.currentLoc);
        }
        if (containsEndSentinel(expr.index)) {
          const tgtTmp = this.freshName('tgt');
          const lenTmp = this.freshName('len');
          this.compileExpr(expr.target, out, bindings);
          this.emit(out, { op: 'STORE', name: tgtTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.emit(out, { op: 'LENGTH' });
          this.emit(out, { op: 'STORE', name: lenTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.endLenTmpStack.push(lenTmp);
          this.compileExpr(expr.index, out, bindings);
          this.endLenTmpStack.pop();
          this.emit(out, { op: 'LIST_GET' });
          this.emit(out, { op: 'DELETE', name: tgtTmp });
          this.emit(out, { op: 'DELETE', name: lenTmp });
        } else {
          this.compileExpr(expr.target, out, bindings);
          this.compileExpr(expr.index, out, bindings);
          this.emit(out, { op: 'LIST_GET' });
        }
        break;
      }
      case 'LastItemExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind === 'uniqueList') {
          throw new CompileError(
            `'last item of X' is a list operation; unique lists do not support random access`,
          this.currentLoc);
        }
        // LOAD list; LENGTH; LIST_GET — but we need the list twice.
        // Use a fresh temp.
        const tmp = this.freshName('last');
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'STORE', name: tmp });
        this.emit(out, { op: 'LOAD', name: tmp });
        this.emit(out, { op: 'LOAD', name: tmp });
        this.emit(out, { op: 'LENGTH' });
        this.emit(out, { op: 'LIST_GET' });
        this.emit(out, { op: 'DELETE', name: tmp });
        break;
      }
      case 'LengthExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind === 'scalar' && tt.name !== 'string') {
          throw new CompileError(
            `'length of' requires a list or string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'LENGTH' });
        break;
      }
      case 'CharacterAccessExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'character N of' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        if (containsEndSentinel(expr.index)) {
          const tgtTmp = this.freshName('tgt');
          const lenTmp = this.freshName('len');
          this.compileExpr(expr.target, out, bindings);
          this.emit(out, { op: 'STORE', name: tgtTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.emit(out, { op: 'LENGTH' });
          this.emit(out, { op: 'STORE', name: lenTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.endLenTmpStack.push(lenTmp);
          this.compileExpr(expr.index, out, bindings);
          this.endLenTmpStack.pop();
          this.emit(out, { op: 'STR_CHAR_AT' });
          this.emit(out, { op: 'DELETE', name: tgtTmp });
          this.emit(out, { op: 'DELETE', name: lenTmp });
        } else {
          this.compileExpr(expr.target, out, bindings);
          this.compileExpr(expr.index, out, bindings);
          this.emit(out, { op: 'STR_CHAR_AT' });
        }
        break;
      }
      case 'LastCharacterExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'last character of' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        const tmp = this.freshName('lastch');
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'STORE', name: tmp });
        this.emit(out, { op: 'LOAD', name: tmp });
        this.emit(out, { op: 'LOAD', name: tmp });
        this.emit(out, { op: 'LENGTH' });
        this.emit(out, { op: 'STR_CHAR_AT' });
        this.emit(out, { op: 'DELETE', name: tmp });
        break;
      }
      case 'SubstringExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'characters A to B of' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        if (containsEndSentinel(expr.from) || containsEndSentinel(expr.to)) {
          const tgtTmp = this.freshName('tgt');
          const lenTmp = this.freshName('len');
          this.compileExpr(expr.target, out, bindings);
          this.emit(out, { op: 'STORE', name: tgtTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.emit(out, { op: 'LENGTH' });
          this.emit(out, { op: 'STORE', name: lenTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.endLenTmpStack.push(lenTmp);
          this.compileExpr(expr.from, out, bindings);
          this.compileExpr(expr.to, out, bindings);
          this.endLenTmpStack.pop();
          this.emit(out, { op: 'STR_SUBSTRING' });
          this.emit(out, { op: 'DELETE', name: tgtTmp });
          this.emit(out, { op: 'DELETE', name: lenTmp });
        } else {
          this.compileExpr(expr.target, out, bindings);
          this.compileExpr(expr.from, out, bindings);
          this.compileExpr(expr.to, out, bindings);
          this.emit(out, { op: 'STR_SUBSTRING' });
        }
        break;
      }
      case 'ListSliceExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind === 'uniqueList') {
          throw new CompileError(
            `'items A to B of' cannot be used on a unique list (no random access)`,
          this.currentLoc);
        }
        if (tt !== null && tt.kind !== 'list') {
          throw new CompileError(
            `'items A to B of' requires a list, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        const ft = this.staticType(expr.from, bindings);
        if (ft !== null && !(ft.kind === 'scalar' && ft.name === 'number')) {
          throw new CompileError(
            `'items A to B of' requires a number index, got ${typeToString(ft)}`,
          this.currentLoc);
        }
        const tt2 = this.staticType(expr.to, bindings);
        if (tt2 !== null && !(tt2.kind === 'scalar' && tt2.name === 'number')) {
          throw new CompileError(
            `'items A to B of' requires a number index, got ${typeToString(tt2)}`,
          this.currentLoc);
        }
        if (containsEndSentinel(expr.from) || containsEndSentinel(expr.to)) {
          const tgtTmp = this.freshName('tgt');
          const lenTmp = this.freshName('len');
          this.compileExpr(expr.target, out, bindings);
          this.emit(out, { op: 'STORE', name: tgtTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.emit(out, { op: 'LENGTH' });
          this.emit(out, { op: 'STORE', name: lenTmp });
          this.emit(out, { op: 'LOAD', name: tgtTmp });
          this.endLenTmpStack.push(lenTmp);
          this.compileExpr(expr.from, out, bindings);
          this.compileExpr(expr.to, out, bindings);
          this.endLenTmpStack.pop();
          this.emit(out, { op: 'LIST_SUBLIST' });
          this.emit(out, { op: 'DELETE', name: tgtTmp });
          this.emit(out, { op: 'DELETE', name: lenTmp });
        } else {
          this.compileExpr(expr.target, out, bindings);
          this.compileExpr(expr.from, out, bindings);
          this.compileExpr(expr.to, out, bindings);
          this.emit(out, { op: 'LIST_SUBLIST' });
        }
        break;
      }
      case 'EndIndexSentinel': {
        if (this.endLenTmpStack.length === 0) {
          throw new CompileError(
            `'end' can only be used inside an index slot of 'character', 'characters', or 'item'`,
          this.currentLoc);
        }
        const name = this.endLenTmpStack[this.endLenTmpStack.length - 1];
        this.emit(out, { op: 'LOAD', name });
        break;
      }
      case 'ReadFileLinesExpression': {
        const pt = this.staticType(expr.path, bindings);
        if (pt && !(pt.kind === 'scalar' && pt.name === 'string')) {
          throw new CompileError(
            `'lines of file' requires a string path, got ${typeToString(pt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.path, out, bindings);
        this.emit(out, { op: 'READ_FILE_LINES' });
        break;
      }
      case 'CodeOfExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'code of' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'CHAR_CODE' });
        break;
      }
      case 'CharacterFromCodeExpression': {
        const tt = this.staticType(expr.code, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'number')) {
          throw new CompileError(
            `'character of' requires a number, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.code, out, bindings);
        this.emit(out, { op: 'CHAR_FROM_CODE' });
        break;
      }
      case 'IsCharClassExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          const article = expr.charClass === 'whitespace' ? '' : 'a ';
          throw new CompileError(
            `'is ${article}${expr.charClass}' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        switch (expr.charClass) {
          case 'digit':      this.emit(out, { op: 'IS_DIGIT' }); break;
          case 'letter':     this.emit(out, { op: 'IS_LETTER' }); break;
          case 'whitespace': this.emit(out, { op: 'IS_WHITESPACE' }); break;
        }
        break;
      }
      case 'IsEmptyExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null
            && !(tt.kind === 'scalar' && tt.name === 'string')
            && tt.kind !== 'list'
            && tt.kind !== 'uniqueList'
            && tt.kind !== 'dict') {
          throw new CompileError(
            `'is empty' requires a string, list, or dictionary, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'IS_EMPTY' });
        break;
      }
      case 'MakeStructExpression': {
        const info = this.structs.get(expr.structName);
        if (!info) {
          throw new CompileError(`unknown struct '${expr.structName}'`, this.currentLoc);
        }
        // Validate fields: every declared field provided, no unknown, no duplicates.
        const provided = new Map<string, Expression>();
        for (const f of expr.fields) {
          if (provided.has(f.name)) {
            throw new CompileError(
              `duplicate field '${f.name}' in make ${expr.structName}`,
            this.currentLoc);
          }
          provided.set(f.name, f.value);
        }
        for (const f of expr.fields) {
          if (!info.fields.find(d => d.name === f.name)) {
            throw new CompileError(
              `struct '${expr.structName}' has no field '${f.name}'`,
            this.currentLoc);
          }
        }
        for (const decl of info.fields) {
          if (!provided.has(decl.name)) {
            throw new CompileError(
              `make ${expr.structName} missing field '${decl.name}'`,
            this.currentLoc);
          }
        }
        // Type-check each value statically.
        for (const decl of info.fields) {
          const v = provided.get(decl.name)!;
          const vt = this.staticType(v, bindings);
          if (vt !== null && !typesEqual(vt, decl.type)) {
            throw new CompileError(
              `Type mismatch: field '${decl.name}' of struct '${expr.structName}' expects ${typeToString(decl.type)}, got ${typeToString(vt)}`,
            this.currentLoc);
          }
        }
        // Emit values in declaration order.
        const fieldNames: string[] = [];
        for (const decl of info.fields) {
          this.compileExpr(provided.get(decl.name)!, out, bindings);
          fieldNames.push(decl.name);
        }
        this.emit(out, { op: 'MAKE_STRUCT', typeName: info.mangled, fieldNames });
        break;
      }
      case 'FieldAccessExpression': {
        const tt = this.staticType(expr.target, bindings);
        // Dictionary `keys of D` / `values of D` lowering when target is a known dict.
        if (tt && tt.kind === 'dict') {
          if (expr.fieldName === 'keys') {
            this.compileExpr(expr.target, out, bindings);
            this.emit(out, { op: 'DICT_KEYS' });
            break;
          }
          if (expr.fieldName === 'values') {
            this.compileExpr(expr.target, out, bindings);
            this.emit(out, { op: 'DICT_VALUES' });
            break;
          }
          throw new CompileError(
            `dictionary has no field '${expr.fieldName}' (use 'keys of', 'values of', or 'value of K in')`,
          this.currentLoc);
        }
        if (tt !== null && tt.kind !== 'struct') {
          throw new CompileError(
            `field access requires a struct, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        if (tt && tt.kind === 'struct') {
          // Look up info by mangled to validate field exists.
          let info: StructInfo | undefined;
          for (const v of this.structs.values()) if (v.mangled === tt.mangled) { info = v; break; }
          if (info && !info.fields.find(d => d.name === expr.fieldName)) {
            throw new CompileError(
              `struct '${unmangle(tt.mangled)}' has no field '${expr.fieldName}'`,
            this.currentLoc);
          }
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'STRUCT_GET', fieldName: expr.fieldName });
        break;
      }
      case 'StructWithExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind !== 'struct') {
          throw new CompileError(
            `'with' requires a struct, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        let info: StructInfo | undefined;
        if (tt && tt.kind === 'struct') {
          for (const v of this.structs.values()) if (v.mangled === tt.mangled) { info = v; break; }
        }
        const seenU = new Set<string>();
        for (const u of expr.updates) {
          if (seenU.has(u.name)) {
            throw new CompileError(
              `duplicate update for field '${u.name}'`,
            this.currentLoc);
          }
          seenU.add(u.name);
          if (info) {
            const decl = info.fields.find(d => d.name === u.name);
            if (!decl) {
              throw new CompileError(
                `struct '${unmangle(info.mangled)}' has no field '${u.name}'`,
              this.currentLoc);
            }
            const vt = this.staticType(u.value, bindings);
            if (vt !== null && !typesEqual(vt, decl.type)) {
              throw new CompileError(
                `Type mismatch: field '${u.name}' expects ${typeToString(decl.type)}, got ${typeToString(vt)}`,
              this.currentLoc);
            }
          }
        }
        this.compileExpr(expr.target, out, bindings);
        const fieldNames: string[] = [];
        for (const u of expr.updates) {
          this.compileExpr(u.value, out, bindings);
          fieldNames.push(u.name);
        }
        this.emit(out, { op: 'STRUCT_WITH', fieldNames });
        break;
      }
      case 'MapExpression':
        this.compileMap(expr, out, bindings);
        break;
      case 'FilterExpression':
        this.compileFilter(expr, out, bindings);
        break;
      case 'ReduceExpression':
        this.compileReduce(expr, out, bindings);
        break;
    }
  }

  // Helper: extract the element type of a list/uniqueList ChatterType as a ChatterType.
  private listElementType(lt: ChatterType | null): ChatterType | undefined {
    if (!lt || (lt.kind !== 'list' && lt.kind !== 'uniqueList')) return undefined;
    if (lt.element.startsWith('struct:')) return { kind: 'struct', mangled: lt.element.slice(7) };
    return { kind: 'scalar', name: lt.element as ScalarTypeName };
  }

  // Push HOF body context (set inHofBody=true so nested HOFs are detected).
  private withHofBody<T>(fn: () => T): T {
    const prev = this.inHofBody;
    this.inHofBody = true;
    try { return fn(); } finally { this.inHofBody = prev; }
  }

  // Common loop scaffold: compile <expr.list> into a temp; iterate with idx;
  // bind `it` to the current element; call `body` to emit the per-iteration body.
  // Cleans up temps on exit. Returns names of created temps for the caller to
  // emit additional DELETEs if needed.
  private compileHofLoop(
    listExpr: Expression,
    elemType: ChatterType | undefined,
    out: Instruction[],
    bindings: Scope,
    body: (itLocal: string) => void,
    onSourceStored?: (listTmp: string) => void,
  ): { listTmp: string; idxTmp: string; lenTmp: string; itTmp: string } {
    const listTmp = this.freshName('hof_list');
    const idxTmp = this.freshName('hof_idx');
    const lenTmp = this.freshName('hof_len');
    const itTmp = this.freshName('hof_it');

    this.compileExpr(listExpr, out, bindings);
    this.emit(out, { op: 'STORE', name: listTmp });
    if (onSourceStored) onSourceStored(listTmp);
    this.emit(out, { op: 'LOAD', name: listTmp });
    this.emit(out, { op: 'LENGTH' });
    this.emit(out, { op: 'STORE', name: lenTmp });
    this.emit(out, { op: 'PUSH_INT', value: 1 });
    this.emit(out, { op: 'STORE', name: idxTmp });

    const topIdx = out.length;
    this.emit(out, { op: 'LOAD', name: idxTmp });
    this.emit(out, { op: 'LOAD', name: lenTmp });
    this.emit(out, { op: 'LE' });
    const jifEndIdx = out.length;
    this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

    // Load current element into the synthesized `it` local.
    this.emit(out, { op: 'LOAD', name: listTmp });
    this.emit(out, { op: 'LOAD', name: idxTmp });
    this.emit(out, { op: 'LIST_GET' });
    this.emit(out, { op: 'STORE', name: itTmp });

    this.hofItStack.push({ local: itTmp, type: elemType });
    try {
      this.withHofBody(() => body(itTmp));
    } finally {
      this.hofItStack.pop();
    }

    this.emit(out, { op: 'LOAD', name: idxTmp });
    this.emit(out, { op: 'PUSH_INT', value: 1 });
    this.emit(out, { op: 'ADD' });
    this.emit(out, { op: 'STORE', name: idxTmp });
    this.emit(out, { op: 'JUMP', target: topIdx });
    const exitIdx = out.length;
    (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;

    this.emit(out, { op: 'DELETE', name: itTmp });
    this.emit(out, { op: 'DELETE', name: idxTmp });
    this.emit(out, { op: 'DELETE', name: lenTmp });
    return { listTmp, idxTmp, lenTmp, itTmp };
  }

  private compileSort(
    stmt: SortStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
    for (const k of stmt.keys) {
      this.validateHofResultOfSlot(k.key);
    }
    const lt = this.staticType(stmt.list, bindings);
    if (lt && lt.kind !== 'list') {
      throw new CompileError(
        `'sort' requires a list, got ${typeToString(lt)}`,
      this.currentLoc);
    }
    const elemType = this.listElementType(lt);

    // Plain `sort xs [ascending|descending]` (single key, no `by`).
    if (stmt.keys.length === 1 && stmt.keys[0].key === undefined) {
      if (lt && lt.kind === 'list') {
        if (lt.element !== 'number' && lt.element !== 'string' && lt.element !== 'boolean') {
          throw new CompileError(
            `'sort' without 'by KEY' requires a list of number, string, or boolean, got ${typeToString(lt)}`,
          this.currentLoc);
        }
      }
      const listTmp = this.freshName('sort_list');
      this.compileExpr(stmt.list, out, bindings);
      this.emit(out, { op: 'STORE', name: listTmp });
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'SORT_LIST', byKey: false, descending: stmt.keys[0].descending });
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'STORE_IT' });
      this.emit(out, { op: 'DELETE', name: listTmp });
      return;
    }

    // Validate each key's static type.
    const validateKey = (keyExpr: Expression): void => {
      this.hofItStack.push({ local: '__sort_key_probe__', type: elemType });
      let keyType: ChatterType | null;
      try {
        keyType = this.withHofBody(() => this.staticType(keyExpr, bindings));
      } finally { this.hofItStack.pop(); }
      if (keyType === null) {
        throw new CompileError(
          `cannot determine static type of 'sort by KEY' expression; consider using a typed function call`,
        this.currentLoc);
      }
      if (keyType.kind !== 'scalar' || (keyType.name !== 'number' && keyType.name !== 'string' && keyType.name !== 'boolean')) {
        throw new CompileError(
          `'sort by KEY' requires KEY to be number, string, or boolean, got ${typeToString(keyType)}`,
        this.currentLoc);
      }
      return;
    };
    for (const k of stmt.keys) validateKey(k.key!);

    // Single-key path: build keys list once, single SORT_LIST pass.
    if (stmt.keys.length === 1) {
      const onlyKey = stmt.keys[0];
      const keysTmp = this.freshName('hof_keys');
      // Determine key type for the keys list element.
      this.hofItStack.push({ local: '__sort_key_probe__', type: elemType });
      let keyType: ChatterType;
      try {
        keyType = this.withHofBody(() => this.staticType(onlyKey.key!, bindings))!;
      } finally { this.hofItStack.pop(); }
      this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: (keyType as { kind: 'scalar'; name: string }).name });
      this.emit(out, { op: 'STORE', name: keysTmp });
      const tmps = this.compileHofLoop(stmt.list, elemType, out, bindings, () => {
        this.emit(out, { op: 'LOAD', name: keysTmp });
        this.compileExpr(onlyKey.key!, out, bindings);
        this.emit(out, { op: 'LIST_APPEND' });
      });
      this.emit(out, { op: 'LOAD', name: tmps.listTmp });
      this.emit(out, { op: 'LOAD', name: keysTmp });
      this.emit(out, { op: 'SORT_LIST', byKey: true, descending: onlyKey.descending });
      this.emit(out, { op: 'LOAD', name: tmps.listTmp });
      this.emit(out, { op: 'STORE_IT' });
      this.emit(out, { op: 'DELETE', name: tmps.listTmp });
      this.emit(out, { op: 'DELETE', name: keysTmp });
      return;
    }

    // Multi-key path: lower to N stable single-key SORT_LIST passes in
    // REVERSE order of significance. Compile the source list once into a
    // shared temp so each pass sees the (now-reordered) same list.
    const sharedListTmp = this.freshName('hof_list');
    this.compileExpr(stmt.list, out, bindings);
    this.emit(out, { op: 'STORE', name: sharedListTmp });

    for (let i = stmt.keys.length - 1; i >= 0; i--) {
      const keyEntry = stmt.keys[i];
      // Re-derive key type for the keys list element type.
      this.hofItStack.push({ local: '__sort_key_probe__', type: elemType });
      let keyType: ChatterType;
      try {
        keyType = this.withHofBody(() => this.staticType(keyEntry.key!, bindings))!;
      } finally { this.hofItStack.pop(); }

      const keysTmp = this.freshName('hof_keys');
      this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: (keyType as { kind: 'scalar'; name: string }).name });
      this.emit(out, { op: 'STORE', name: keysTmp });

      // Iterate the (possibly reordered) sharedListTmp without re-compiling
      // the list expression. We inline a small loop here mirroring
      // compileHofLoop, but reading from sharedListTmp directly.
      const idxTmp = this.freshName('hof_idx');
      const lenTmp = this.freshName('hof_len');
      const itTmp = this.freshName('hof_it');
      this.emit(out, { op: 'LOAD', name: sharedListTmp });
      this.emit(out, { op: 'LENGTH' });
      this.emit(out, { op: 'STORE', name: lenTmp });
      this.emit(out, { op: 'PUSH_INT', value: 1 });
      this.emit(out, { op: 'STORE', name: idxTmp });
      const topIdx = out.length;
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'LOAD', name: lenTmp });
      this.emit(out, { op: 'LE' });
      const jifEndIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
      this.emit(out, { op: 'LOAD', name: sharedListTmp });
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'LIST_GET' });
      this.emit(out, { op: 'STORE', name: itTmp });
      this.hofItStack.push({ local: itTmp, type: elemType });
      try {
        this.withHofBody(() => {
          this.emit(out, { op: 'LOAD', name: keysTmp });
          this.compileExpr(keyEntry.key!, out, bindings);
          this.emit(out, { op: 'LIST_APPEND' });
        });
      } finally { this.hofItStack.pop(); }
      this.emit(out, { op: 'LOAD', name: idxTmp });
      this.emit(out, { op: 'PUSH_INT', value: 1 });
      this.emit(out, { op: 'ADD' });
      this.emit(out, { op: 'STORE', name: idxTmp });
      this.emit(out, { op: 'JUMP', target: topIdx });
      const exitIdx = out.length;
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
      this.emit(out, { op: 'DELETE', name: itTmp });
      this.emit(out, { op: 'DELETE', name: idxTmp });
      this.emit(out, { op: 'DELETE', name: lenTmp });

      this.emit(out, { op: 'LOAD', name: sharedListTmp });
      this.emit(out, { op: 'LOAD', name: keysTmp });
      this.emit(out, { op: 'SORT_LIST', byKey: true, descending: keyEntry.descending });
      this.emit(out, { op: 'DELETE', name: keysTmp });
    }

    this.emit(out, { op: 'LOAD', name: sharedListTmp });
    this.emit(out, { op: 'STORE_IT' });
    this.emit(out, { op: 'DELETE', name: sharedListTmp });
  }

  private compileMap(
    expr: MapExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
    this.validateHofResultOfSlot(expr.body);
    const lt = this.staticType(expr.list, bindings);
    if (lt && lt.kind !== 'list' && lt.kind !== 'uniqueList') {
      throw new CompileError(
        `'map' requires a list, got ${typeToString(lt)}`,
      this.currentLoc);
    }
    const elemType = this.listElementType(lt);

    // Determine result element type via body's static type with `it` bound.
    this.hofItStack.push({ local: '__map_probe__', type: elemType });
    let resultElemType: ChatterType | null;
    try {
      resultElemType = this.withHofBody(() => this.staticType(expr.body, bindings));
    } finally { this.hofItStack.pop(); }

    if (resultElemType === null) {
      throw new CompileError(
        `cannot determine static type of 'map' body; consider using a typed function call or annotating the source list`,
      this.currentLoc);
    }
    if (resultElemType.kind !== 'scalar' && resultElemType.kind !== 'struct') {
      throw new CompileError(
        `'map' body must produce a number, string, boolean, or struct, got ${typeToString(resultElemType)}`,
      this.currentLoc);
    }
    const resCode = elementCode(resultElemType)!;
    const resTmp = this.freshName('hof_res');

    this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: resCode });
    this.emit(out, { op: 'STORE', name: resTmp });

    const tmps = this.compileHofLoop(expr.list, elemType, out, bindings, (itLocal) => {
      this.emit(out, { op: 'LOAD', name: resTmp });
      this.compileExpr(expr.body, out, bindings);
      this.emit(out, { op: 'LIST_APPEND' });
    });

    this.emit(out, { op: 'LOAD', name: resTmp });
    this.emit(out, { op: 'DELETE', name: tmps.listTmp });
    this.emit(out, { op: 'DELETE', name: resTmp });
  }

  private compileFilter(
    expr: FilterExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
    this.validateHofResultOfSlot(expr.predicate);
    const lt = this.staticType(expr.list, bindings);
    if (lt && lt.kind !== 'list' && lt.kind !== 'uniqueList') {
      throw new CompileError(
        `'filter' requires a list, got ${typeToString(lt)}`,
      this.currentLoc);
    }
    const elemType = this.listElementType(lt);

    // Static type check: predicate must be boolean (or unknown).
    this.hofItStack.push({ local: '__filter_probe__', type: elemType });
    let predType: ChatterType | null;
    try {
      predType = this.withHofBody(() => this.staticType(expr.predicate, bindings));
    } finally { this.hofItStack.pop(); }

    if (predType !== null && !(predType.kind === 'scalar' && predType.name === 'boolean')) {
      throw new CompileError(
        `'filter where' requires a boolean, got ${typeToString(predType)}`,
      this.currentLoc);
    }

    // Result element type is source list element type; if unknown statically,
    // defer to runtime via MAKE_EMPTY_LIST_LIKE on the source list.
    let resCode: string | null = null;
    if (lt && (lt.kind === 'list' || lt.kind === 'uniqueList')) {
      resCode = lt.element;
    }
    const resTmp = this.freshName('hof_res');
    if (resCode !== null) {
      this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: resCode });
      this.emit(out, { op: 'STORE', name: resTmp });
    }

    const tmps = this.compileHofLoop(expr.list, elemType, out, bindings, (itLocal) => {
      this.compileExpr(expr.predicate, out, bindings);
      // Runtime guard: predicate must be boolean.
      this.emit(out, { op: 'EXPECT_BOOL_CHECK' });
      const jifSkip = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });
      this.emit(out, { op: 'LOAD', name: resTmp });
      this.emit(out, { op: 'LOAD', name: itLocal });
      this.emit(out, { op: 'LIST_APPEND' });
      (out[jifSkip] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
    }, resCode === null ? (listTmp) => {
      this.emit(out, { op: 'LOAD', name: listTmp });
      this.emit(out, { op: 'MAKE_EMPTY_LIST_LIKE' });
      this.emit(out, { op: 'STORE', name: resTmp });
    } : undefined);

    this.emit(out, { op: 'LOAD', name: resTmp });
    this.emit(out, { op: 'DELETE', name: tmps.listTmp });
    this.emit(out, { op: 'DELETE', name: resTmp });
  }

  private compileReduce(
    expr: ReduceExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
    this.validateHofResultOfSlot(expr.start);
    this.validateHofResultOfSlot(expr.body);
    const lt = this.staticType(expr.list, bindings);
    if (lt && lt.kind !== 'list' && lt.kind !== 'uniqueList') {
      throw new CompileError(
        `'reduce' requires a list, got ${typeToString(lt)}`,
      this.currentLoc);
    }
    const elemType = this.listElementType(lt);
    const startType = this.staticType(expr.start, bindings);
    if (startType !== null && startType.kind !== 'scalar' && startType.kind !== 'struct') {
      throw new CompileError(
        `'reduce starting V' requires V to be a number, string, boolean, or struct, got ${typeToString(startType)}`,
      this.currentLoc);
    }
    const accTmp = this.freshName('hof_acc');

    // Static body type check vs start type.
    this.hofItStack.push({ local: '__reduce_probe__', type: elemType });
    this.hofAccStack.push({ local: accTmp, type: startType ?? undefined });
    let bodyType: ChatterType | null;
    try {
      bodyType = this.withHofBody(() => this.staticType(expr.body, bindings));
    } finally {
      this.hofAccStack.pop();
      this.hofItStack.pop();
    }
    if (startType !== null && bodyType !== null && !typesEqual(startType, bodyType)) {
      throw new CompileError(
        `'reduce' body type ${typeToString(bodyType)} does not match starting value type ${typeToString(startType)}`,
      this.currentLoc);
    }

    // Initialize accumulator. STORE_VAR locks the type on first store.
    this.compileExpr(expr.start, out, bindings);
    this.emit(out, { op: 'STORE_VAR', name: accTmp });

    // Iterate, evaluating body and re-storing into accumulator (re-checked).
    this.hofAccStack.push({ local: accTmp, type: startType ?? bodyType ?? undefined });
    try {
      const tmps = this.compileHofLoop(expr.list, elemType, out, bindings, (itLocal) => {
        this.compileExpr(expr.body, out, bindings);
        this.emit(out, { op: 'STORE_VAR', name: accTmp });
      });
      this.emit(out, { op: 'LOAD', name: accTmp });
      this.emit(out, { op: 'DELETE', name: tmps.listTmp });
      this.emit(out, { op: 'DELETE', name: accTmp });
    } finally {
      this.hofAccStack.pop();
    }
  }

  private compileDictionaryLiteral(
    expr: DictionaryLiteral,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (expr.kind === 'empty') {
      const kCode = this.elementAnnotationToCode(expr.keyType!);
      const vCode = this.elementAnnotationToCode(expr.valueType!);
      this.emit(out, { op: 'MAKE_EMPTY_DICT', keyType: kCode, valueType: vCode });
      return;
    }
    // Infer key + value types from entries.
    let kInferred: string | null = null;
    let vInferred: string | null = null;
    for (const e of expr.entries) {
      const kt = this.staticType(e.key, bindings);
      if (kt) {
        const c = elementCode(kt);
        if (c === null) {
          throw new CompileError(`nested collections not supported in dictionary key`, this.currentLoc);
        }
        if (kInferred === null) kInferred = c;
        else if (kInferred !== c) {
          throw new CompileError(
            `Type mismatch in dictionary literal: mixed key types (${elementHuman(kInferred)} and ${elementHuman(c)})`,
          this.currentLoc);
        }
      }
      const vt = this.staticType(e.value, bindings);
      if (vt) {
        const c = elementCode(vt);
        if (c === null) {
          throw new CompileError(`nested collections not supported in dictionary value`, this.currentLoc);
        }
        if (vInferred === null) vInferred = c;
        else if (vInferred !== c) {
          throw new CompileError(
            `Type mismatch in dictionary literal: mixed value types (${elementHuman(vInferred)} and ${elementHuman(c)})`,
          this.currentLoc);
        }
      }
    }
    if (kInferred === null || vInferred === null) {
      throw new CompileError(
        `cannot infer dictionary key/value types; use 'empty dictionary from K to V' for empty dictionaries`,
      this.currentLoc);
    }
    for (const e of expr.entries) {
      this.compileExpr(e.key, out, bindings);
      this.compileExpr(e.value, out, bindings);
    }
    this.emit(out, {
      op: 'MAKE_DICT',
      count: expr.entries.length,
      keyType: kInferred,
      valueType: vInferred,
    });
  }

  private compileDictGet(
    expr: DictGetExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const dt = this.staticType(expr.dict, bindings);
    if (dt !== null && dt.kind !== 'dict') {
      throw new CompileError(
        `'value of K in X' requires a dictionary, got ${typeToString(dt)}`,
      this.currentLoc);
    }
    if (dt && dt.kind === 'dict') {
      const kt = this.staticType(expr.key, bindings);
      const kc = elementCode(kt);
      if (kc !== null && kc !== dt.keyType) {
        throw new CompileError(
          `Type mismatch: dictionary key has type ${elementHuman(dt.keyType)}, got ${elementHuman(kc)}`,
        this.currentLoc);
      }
    }
    this.compileExpr(expr.dict, out, bindings);
    this.compileExpr(expr.key, out, bindings);
    this.emit(out, { op: 'DICT_GET' });
  }

  private compileDictSet(
    stmt: DictSetStatement,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const resolved = this.lookupBindingWithOuter(stmt.dictName, bindings);
    if (!resolved) {
      throw new CompileError(
        `Cannot change value in '${stmt.dictName}': no such binding`,
      this.currentLoc);
    }
    const info = resolved.info;
    if (info.type) {
      if (info.type.kind !== 'dict') {
        throw new CompileError(
          `Cannot change value in '${stmt.dictName}': not a dictionary (type ${typeToString(info.type)})`,
        this.currentLoc);
      }
      const kt = this.staticType(stmt.key, bindings);
      const kc = elementCode(kt);
      if (kc !== null && kc !== info.type.keyType) {
        throw new CompileError(
          `Type mismatch: dictionary key has type ${elementHuman(info.type.keyType)}, got ${elementHuman(kc)}`,
        this.currentLoc);
      }
      const vt = this.staticType(stmt.value, bindings);
      const vc = elementCode(vt);
      if (vc !== null && vc !== info.type.valueType) {
        throw new CompileError(
          `Type mismatch: dictionary value has type ${elementHuman(info.type.valueType)}, got ${elementHuman(vc)}`,
        this.currentLoc);
      }
    }
    this.emit(out, { op: 'LOAD', name: info.mangled });
    this.compileExpr(stmt.key, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'DICT_SET' });
  }

  private compileUniqueListLiteral(
    expr: UniqueListLiteral,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (expr.kind === 'empty') {
      this.emit(out, { op: 'MAKE_EMPTY_UNIQUE_LIST', elementType: this.elementAnnotationToCode(expr.elementType!) });
      return;
    }
    let inferred: string | null = null;
    let allKnown = true;
    for (const e of expr.elements) {
      const t = this.staticType(e, bindings);
      if (t === null) { allKnown = false; continue; }
      const c = elementCode(t);
      if (c === null) {
        throw new CompileError(`nested lists not supported`, this.currentLoc);
      }
      if (inferred === null) inferred = c;
      else if (inferred !== c) {
        throw new CompileError(
          `Type mismatch in unique list literal: mixed element types (${elementHuman(inferred)} and ${elementHuman(c)})`,
        this.currentLoc);
      }
    }
    for (const e of expr.elements) {
      this.compileExpr(e, out, bindings);
    }
    this.emit(out, {
      op: 'MAKE_UNIQUE_LIST',
      count: expr.elements.length,
      elementType: allKnown ? inferred : null,
    });
  }

  private compileListLiteral(
    expr: ListLiteral,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (expr.kind === 'empty') {
      this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: this.elementAnnotationToCode(expr.elementType!) });
      return;
    }
    let inferred: string | null = null;
    let allKnown = true;
    for (const e of expr.elements) {
      const t = this.staticType(e, bindings);
      if (t === null) { allKnown = false; continue; }
      const c = elementCode(t);
      if (c === null) {
        throw new CompileError(`nested lists not supported`, this.currentLoc);
      }
      if (inferred === null) inferred = c;
      else if (inferred !== c) {
        throw new CompileError(
          `Type mismatch in list literal: mixed element types (${elementHuman(inferred)} and ${elementHuman(c)})`,
        this.currentLoc);
      }
    }
    for (const e of expr.elements) {
      this.compileExpr(e, out, bindings);
    }
    this.emit(out, {
      op: 'MAKE_LIST',
      count: expr.elements.length,
      elementType: allKnown ? inferred : null,
    });
  }

  private compileBinary(
    expr: BinaryExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    if (expr.operator === 'contains') {
      const lt = this.staticType(expr.left, bindings);
      if (lt !== null && lt.kind === 'scalar' && lt.name === 'string') {
        const rt = this.staticType(expr.right, bindings);
        if (rt !== null && !(rt.kind === 'scalar' && rt.name === 'string')) {
          throw new CompileError(
            `Type mismatch: 'contains' on string requires a string on the right, got ${typeToString(rt)}`,
          this.currentLoc);
        }
      } else if (lt !== null && lt.kind === 'scalar' && lt.name !== 'string') {
        throw new CompileError(
          `'contains' requires a list or string on the left, got ${typeToString(lt)}`,
        this.currentLoc);
      } else if (lt !== null && (lt.kind === 'list' || lt.kind === 'uniqueList')) {
        const rt = this.staticType(expr.right, bindings);
        const rc = elementCode(rt);
        if (rc !== null && rc !== lt.element) {
          throw new CompileError(
            `Type mismatch: 'contains' value type ${elementHuman(rc)} does not match list element type ${elementHuman(lt.element)}`,
          this.currentLoc);
        }
        if (rt && (rt.kind === 'list' || rt.kind === 'uniqueList' || rt.kind === 'dict')) {
          throw new CompileError(
            `Type mismatch: 'contains' value cannot be a list or dictionary`,
          this.currentLoc);
        }
      } else if (lt !== null && lt.kind === 'dict') {
        const rt = this.staticType(expr.right, bindings);
        const rc = elementCode(rt);
        if (rc !== null && rc !== lt.keyType) {
          throw new CompileError(
            `Type mismatch: 'contains' key type ${elementHuman(rc)} does not match dictionary key type ${elementHuman(lt.keyType)}`,
          this.currentLoc);
        }
        if (rt && (rt.kind === 'list' || rt.kind === 'uniqueList' || rt.kind === 'dict')) {
          throw new CompileError(
            `Type mismatch: 'contains' value cannot be a list or dictionary`,
          this.currentLoc);
        }
      }
      this.compileExpr(expr.left, out, bindings);
      this.compileExpr(expr.right, out, bindings);
      this.emit(out, { op: 'CONTAINS' });
      return;
    }
    if (expr.operator === 'and' || expr.operator === 'or') {
      this.compileLogicalShortCircuit(expr, out, bindings);
      return;
    }
    this.compileExpr(expr.left, out, bindings);
    this.compileExpr(expr.right, out, bindings);
    const op = expr.operator;
    // --- Static type checks (skip when either side has unknown static type) ---
    const lt = this.staticType(expr.left, bindings);
    const rt = this.staticType(expr.right, bindings);
    const isArith = (op === '+' || op === '-' || op === '*' || op === '/' || op === '**' || op === 'mod');
    const isCmp = (op === '<' || op === '<=' || op === '>' || op === '>=');
    const isEq = (op === '==' || op === '!=');
    const isLogical = (op === 'and' || op === 'or');
    if (isArith) {
      if (lt && !(lt.kind === 'scalar' && lt.name === 'number')) {
        throw new CompileError(
          `Type mismatch: arithmetic requires numbers, got ${typeToString(lt)}`,
        this.currentLoc);
      }
      if (rt && !(rt.kind === 'scalar' && rt.name === 'number')) {
        throw new CompileError(
          `Type mismatch: arithmetic requires numbers, got ${typeToString(rt)}`,
        this.currentLoc);
      }
    } else if (isCmp) {
      if (lt && !(lt.kind === 'scalar' && lt.name === 'number')) {
        throw new CompileError(
          `Type mismatch: comparison requires numbers, got ${typeToString(lt)}`,
        this.currentLoc);
      }
      if (rt && !(rt.kind === 'scalar' && rt.name === 'number')) {
        throw new CompileError(
          `Type mismatch: comparison requires numbers, got ${typeToString(rt)}`,
        this.currentLoc);
      }
    } else if (isEq) {
      if (lt && rt) {
        const compatible =
          (lt.kind === 'scalar' && rt.kind === 'scalar' && lt.name === rt.name) ||
          (lt.kind === 'list' && rt.kind === 'list' && lt.element === rt.element) ||
          (lt.kind === 'uniqueList' && rt.kind === 'uniqueList' && lt.element === rt.element) ||
          (lt.kind === 'list' && rt.kind === 'uniqueList' && lt.element === rt.element) ||
          (lt.kind === 'uniqueList' && rt.kind === 'list' && lt.element === rt.element) ||
          (lt.kind === 'struct' && rt.kind === 'struct' && lt.mangled === rt.mangled);
        if (!compatible) {
          throw new CompileError(
            `Type mismatch: cannot compare ${typeToString(lt)} and ${typeToString(rt)}`,
          this.currentLoc);
        }
      }
    } else if (isLogical) {
      // Short-circuit path is handled in compileLogicalShortCircuit; this branch
      // is unreachable but kept for the type checker.
      throw new CompileError(`unreachable: logical op '${op}' should be short-circuited`, this.currentLoc);
    }
    switch (op) {
      case '+':  this.emit(out, { op: 'ADD' }); break;
      case '-':  this.emit(out, { op: 'SUB' }); break;
      case '*':  this.emit(out, { op: 'MUL' }); break;
      case '/':  this.emit(out, { op: 'DIV' }); break;
      case '&':  this.emit(out, { op: 'CONCAT' }); break;
      case 'mod': this.emit(out, { op: 'MOD' }); break;
      case '**': this.emit(out, { op: 'POW' }); break;
      case '==': this.emit(out, { op: 'EQ' }); break;
      case '!=': this.emit(out, { op: 'NEQ' }); break;
      case '<':  this.emit(out, { op: 'LT' }); break;
      case '<=': this.emit(out, { op: 'LE' }); break;
      case '>':  this.emit(out, { op: 'GT' }); break;
      case '>=': this.emit(out, { op: 'GE' }); break;
      default:
        throw new CompileError(`Unknown operator: ${op}`, this.currentLoc);
    }
  }

  // Compile `a and b` / `a or b` with short-circuit semantics.
  // Pattern (for 'and'):
  //   <a>
  //   JUMP_BOOL_OP and end   ; if a is false, jump w/ value preserved; else pop and continue
  //   <b>
  //   EXPECT_BOOL_OP and     ; type-check b at runtime when its static type is unknown
  // end:
  // Static type checks on both operands still fire when types are statically known.
  private compileLogicalShortCircuit(
    expr: BinaryExpression,
    out: Instruction[],
    bindings: Scope,
  ): void {
    const op = expr.operator as 'and' | 'or';
    const lt = this.staticType(expr.left, bindings);
    if (lt && !(lt.kind === 'scalar' && lt.name === 'boolean')) {
      throw new CompileError(
        `Type mismatch: '${op}' requires booleans, got ${typeToString(lt)}`,
        this.currentLoc,
      );
    }
    const rt = this.staticType(expr.right, bindings);
    if (rt && !(rt.kind === 'scalar' && rt.name === 'boolean')) {
      throw new CompileError(
        `Type mismatch: '${op}' requires booleans, got ${typeToString(rt)}`,
        this.currentLoc,
      );
    }
    this.compileExpr(expr.left, out, bindings);
    const jumpIdx = out.length;
    this.emit(out, { op: 'JUMP_BOOL_OP', logicalOp: op, target: -1 });
    this.compileExpr(expr.right, out, bindings);
    this.emit(out, { op: 'EXPECT_BOOL_OP', logicalOp: op });
    (out[jumpIdx] as any).target = out.length;
  }

  // Best-effort static type inference.
  private staticType(expr: Expression, bindings: Scope): ChatterType | null {
    switch (expr.type) {
      case 'NumberLiteral': return { kind: 'scalar', name: 'number' };
      case 'StringLiteral': return { kind: 'scalar', name: 'string' };
      case 'BooleanLiteral': return { kind: 'scalar', name: 'boolean' };
      case 'UnaryExpression':
        return expr.operator === '-'
          ? { kind: 'scalar', name: 'number' }
          : { kind: 'scalar', name: 'boolean' };
      case 'BinaryExpression': {
        const op = expr.operator;
        if (op === '&') {
          return { kind: 'scalar', name: 'string' };
        }
        if (op === '+' || op === '-' || op === '*' || op === '/' || op === '**' || op === 'mod') {
          return { kind: 'scalar', name: 'number' };
        }
        return { kind: 'scalar', name: 'boolean' };
      }
      case 'IdentifierExpression': {
        if (expr.name === 'accumulator' && this.hofAccStack.length > 0) {
          return this.hofAccStack[this.hofAccStack.length - 1].type ?? null;
        }
        const info = bindings.lookup(expr.name);
        return info?.type ?? null;
      }
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        return rt ?? null;
      }
      case 'ListLiteral': {
        if (expr.kind === 'empty') {
          const code = this.elementAnnotationToCode(expr.elementType!);
          return { kind: 'list', element: code };
        }
        let inferred: string | null = null;
        for (const e of expr.elements) {
          const t = this.staticType(e, bindings);
          const c = elementCode(t);
          if (c !== null) { inferred = c; break; }
        }
        return inferred !== null ? { kind: 'list', element: inferred } : null;
      }
      case 'UniqueListLiteral': {
        if (expr.kind === 'empty') {
          const code = this.elementAnnotationToCode(expr.elementType!);
          return { kind: 'uniqueList', element: code };
        }
        let inferred: string | null = null;
        for (const e of expr.elements) {
          const t = this.staticType(e, bindings);
          const c = elementCode(t);
          if (c !== null) { inferred = c; break; }
        }
        return inferred !== null ? { kind: 'uniqueList', element: inferred } : null;
      }
      case 'DictionaryLiteral': {
        if (expr.kind === 'empty') {
          const k = this.elementAnnotationToCode(expr.keyType!);
          const v = this.elementAnnotationToCode(expr.valueType!);
          return { kind: 'dict', keyType: k, valueType: v };
        }
        let kInf: string | null = null;
        let vInf: string | null = null;
        for (const e of expr.entries) {
          if (kInf === null) {
            const c = elementCode(this.staticType(e.key, bindings));
            if (c !== null) kInf = c;
          }
          if (vInf === null) {
            const c = elementCode(this.staticType(e.value, bindings));
            if (c !== null) vInf = c;
          }
          if (kInf !== null && vInf !== null) break;
        }
        if (kInf !== null && vInf !== null) {
          return { kind: 'dict', keyType: kInf, valueType: vInf };
        }
        return null;
      }
      case 'DictGetExpression': {
        const dt = this.staticType(expr.dict, bindings);
        if (dt && dt.kind === 'dict') {
          if (dt.valueType.startsWith('struct:')) {
            return { kind: 'struct', mangled: dt.valueType.slice(7) };
          }
          return { kind: 'scalar', name: dt.valueType as ScalarTypeName };
        }
        return null;
      }
      case 'ItemAccessExpression':
      case 'LastItemExpression': {
        const tt = this.staticType((expr as any).target, bindings);
        if (tt && (tt.kind === 'list' || tt.kind === 'uniqueList')) {
          if (tt.element.startsWith('struct:')) {
            return { kind: 'struct', mangled: tt.element.slice(7) };
          }
          return { kind: 'scalar', name: tt.element as ScalarTypeName };
        }
        return null;
      }
      case 'LengthExpression':
        return { kind: 'scalar', name: 'number' };
      case 'EndIndexSentinel':
        return { kind: 'scalar', name: 'number' };
      case 'CharacterAccessExpression':
      case 'LastCharacterExpression':
      case 'SubstringExpression':
        return { kind: 'scalar', name: 'string' };
      case 'ListSliceExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt && tt.kind === 'list') {
          return { kind: 'list', element: tt.element };
        }
        return null;
      }
      case 'ReadFileLinesExpression':
        return { kind: 'list', element: 'string' };
      case 'CodeOfExpression':
        return { kind: 'scalar', name: 'number' };
      case 'CharacterFromCodeExpression':
        return { kind: 'scalar', name: 'string' };
      case 'IsCharClassExpression':
        return { kind: 'scalar', name: 'boolean' };
      case 'IsEmptyExpression':
        return { kind: 'scalar', name: 'boolean' };
      case 'MakeStructExpression': {
        const info = this.structs.get(expr.structName);
        if (!info) return null;
        return { kind: 'struct', mangled: info.mangled };
      }
      case 'FieldAccessExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt && tt.kind === 'dict') {
          if (expr.fieldName === 'keys') {
            return { kind: 'uniqueList', element: tt.keyType };
          }
          if (expr.fieldName === 'values') {
            return { kind: 'list', element: tt.valueType };
          }
          return null;
        }
        if (tt && tt.kind === 'struct') {
          let info: StructInfo | undefined;
          for (const v of this.structs.values()) if (v.mangled === tt.mangled) { info = v; break; }
          const f = info?.fields.find(d => d.name === expr.fieldName);
          return f?.type ?? null;
        }
        return null;
      }
      case 'StructWithExpression':
        return this.staticType(expr.target, bindings);
      case 'MapExpression': {
        const lt = this.staticType(expr.list, bindings);
        if (!lt || (lt.kind !== 'list' && lt.kind !== 'uniqueList')) return null;
        const et = this.listElementType(lt);
        this.hofItStack.push({ local: '__sttype__', type: et });
        try {
          const bt = this.staticType(expr.body, bindings);
          if (!bt) return null;
          const code = elementCode(bt);
          if (code === null) return null;
          return { kind: 'list', element: code };
        } finally { this.hofItStack.pop(); }
      }
      case 'FilterExpression': {
        const lt = this.staticType(expr.list, bindings);
        if (!lt || (lt.kind !== 'list' && lt.kind !== 'uniqueList')) return null;
        return { kind: 'list', element: lt.element };
      }
      case 'ReduceExpression':
        return this.staticType(expr.start, bindings);
      case 'ItExpression':
        if (this.hofItStack.length > 0) {
          return this.hofItStack[this.hofItStack.length - 1].type ?? null;
        }
        return null;
      default:
        return null;
    }
  }
}

// --- Path-termination analyzer (pure helpers) ---

export function statementTerminates(stmt: Statement): boolean {
  if (stmt.type === 'ReturnStatement') return true;
  if (stmt.type === 'FailStatement') return true;
  if (stmt.type === 'IfStatement') {
    if (stmt.elseBody === null) return false;
    for (const b of stmt.branches) {
      if (!blockTerminates(b.body)) return false;
    }
    if (!blockTerminates(stmt.elseBody)) return false;
    return true;
  }
  return false;
}

export function blockTerminates(stmts: Statement[]): boolean {
  for (const s of stmts) {
    if (statementTerminates(s)) return true;
  }
  return false;
}

export function compile(program: Program): BytecodeProgram {
  return new Compiler().compile(program);
}
