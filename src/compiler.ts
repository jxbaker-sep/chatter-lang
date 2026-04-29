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
  EndIndexSentinel,
  ReadFileLinesExpression, ReadFileStatement,
  ExpectStatement,
  ExitRepeatStatement, NextRepeatStatement,
  StructDeclaration, StructField,
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
      return false;
    default:
      return false;
  }
}

export type ChatterType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: string; readonly: boolean }       // element string-encoded
  | { kind: 'uniqueList'; element: string; readonly: false }
  | { kind: 'dict'; keyType: string; valueType: string; readonly: boolean }
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
    return a.element === b.element && a.readonly === b.readonly;
  }
  if (a.kind === 'uniqueList' && b.kind === 'uniqueList') {
    return a.element === b.element;
  }
  if (a.kind === 'dict' && b.kind === 'dict') {
    return a.keyType === b.keyType && a.valueType === b.valueType && a.readonly === b.readonly;
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
    return (t.readonly ? 'readonly dictionary from ' : 'dictionary from ')
      + elementHuman(t.keyType) + ' to ' + elementHuman(t.valueType);
  }
  return (t.readonly ? 'readonly list of ' : 'list of ') + elementHuman(t.element);
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
}

type BindingKind = 'constant' | 'var' | 'param' | 'loop';

interface BindingInfo {
  kind: BindingKind;
  type?: ChatterType;  // statically known type
}

type Bindings = Map<string, BindingInfo>;

export interface ImportedFunction {
  mangled: string;
  signature: Array<{ name: string; label: string | null; type: ChatterType }>;
  returnType: ChatterType | null;
  paramNames: string[];
}

export interface ImportedStruct {
  mangled: string;
  fields: Array<{ name: string; type: ChatterType }>;
}

export interface CompileOptions {
  moduleId?: string;
  imports?: Map<string, ImportedFunction>;
  structImports?: Map<string, ImportedStruct>;
}

export interface CompiledModule {
  functions: Map<string, FunctionDef>;      // keyed by mangled names
  topLevel: Instruction[];                  // module top-level instructions
  exports: Map<string, ImportedFunction>;   // local name -> info (for loader)
  structExports: Map<string, ImportedStruct>;
}

export class Compiler {
  private functions = new Map<string, FunctionDef>();
  private functionSignatures = new Map<string, Array<{ name: string; label: string | null; type: ChatterType }>>();
  private functionReturnTypes = new Map<string, ChatterType | null>();  // null = void
  private functionMangled = new Map<string, string>();   // local name -> mangled
  private outerBindings = new Set<string>();
  private topLevelBindings: Bindings | null = null;
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
    if (this.moduleId && this.outerBindings.has(name)) {
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

  // Resolve a TypeAnnotation to a ChatterType using the struct registry.
  // Throws CompileError for unknown struct names.
  private fromAnnotation(a: TypeAnnotation, loc?: SourceLocation): ChatterType {
    if (a.kind === 'scalar') return { kind: 'scalar', name: a.name };
    if (a.kind === 'struct') {
      const info = this.structs.get(a.name);
      if (!info) {
        throw new CompileError(`unknown struct '${a.name}'`, loc ?? this.currentLoc);
      }
      return { kind: 'struct', mangled: info.mangled };
    }
    if (a.kind === 'dict') {
      const kCode = this.elementAnnotationToCode(a.keyType, loc);
      const vCode = this.elementAnnotationToCode(a.valueType, loc);
      return { kind: 'dict', keyType: kCode, valueType: vCode, readonly: a.readonly };
    }
    // list/uniqueList
    const elem = a.element;
    let elemCode: string;
    if (elem.kind === 'scalar') {
      elemCode = elem.name;
    } else {
      const info = this.structs.get(elem.name);
      if (!info) {
        throw new CompileError(`unknown struct '${elem.name}'`, loc ?? this.currentLoc);
      }
      elemCode = 'struct:' + info.mangled;
    }
    if (a.kind === 'uniqueList') {
      return { kind: 'uniqueList', element: elemCode, readonly: false };
    }
    return { kind: 'list', element: elemCode, readonly: a.readonly };
  }

  private elementAnnotationToCode(e: ElementTypeAnnotation, loc?: SourceLocation): string {
    if (e.kind === 'scalar') return e.name;
    const info = this.structs.get(e.name);
    if (!info) {
      throw new CompileError(`unknown struct '${e.name}'`, loc ?? this.currentLoc);
    }
    return 'struct:' + info.mangled;
  }

  compile(program: Program): BytecodeProgram {
    const m = this.compileModule(program, {});
    return { functions: m.functions, main: m.topLevel };
  }

  compileModule(program: Program, opts: CompileOptions): CompiledModule {
    this.moduleId = opts.moduleId ?? null;
    this.imports = opts.imports ?? new Map();
    const structImports = opts.structImports ?? new Map<string, ImportedStruct>();

    // Pass 1a: register all structs (local + imported) by local name.
    // Imported structs first.
    for (const [localName, info] of structImports) {
      this.structs.set(localName, {
        mangled: info.mangled,
        fields: info.fields,
        exported: false,
        imported: true,
      });
    }

    // Local struct declarations: collect names with mangled, fields filled later.
    for (const stmt of program.body) {
      if (stmt.type !== 'StructDeclaration') continue;
      if (this.structs.has(stmt.name)) {
        throw new CompileError(
          `name '${stmt.name}' is already defined`,
          locOf(stmt),
        );
      }
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
        if (this.imports.has(stmt.name) || this.structs.has(stmt.name)) {
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
      }
    }

    const topLevel: Instruction[] = [];
    const bindings: Bindings = new Map();
    this.topLevelBindings = bindings;

    for (const stmt of program.body) {
      if (stmt.type === 'UseStatement') continue;
      if (stmt.type === 'StructDeclaration') continue;  // already processed in pass 1
      this.compileStatement(stmt, topLevel, bindings);
    }

    // Post-process: apply mangling to binding names (outer) and function-call names
    const rewriteInstrs = (instrs: Instruction[]) => {
      for (const i of instrs) {
        if (i.op === 'LOAD' || i.op === 'STORE' || i.op === 'STORE_VAR' || i.op === 'DELETE') {
          i.name = this.mangleBinding(i.name);
        } else if (i.op === 'CALL') {
          i.name = this.mangleFunction(i.name);
        }
      }
    };
    rewriteInstrs(topLevel);
    for (const fdef of this.functions.values()) {
      rewriteInstrs(fdef.instructions);
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
      });
    }

    return { functions: this.functions, topLevel, exports, structExports };
  }

  private compileStatement(
    stmt: Statement,
    out: Instruction[],
    bindings: Bindings,
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
    bindings: Bindings,
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
    }
  }

  private compileExpect(
    stmt: ExpectStatement,
    out: Instruction[],
    bindings: Bindings,
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

  private compileReadFileStatement(
    stmt: ReadFileStatement,
    out: Instruction[],
    bindings: Bindings,
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
    bindings: Bindings,
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

  private checkNotReadonlySmuggle(value: Expression, bindings: Bindings, ctx: string): void {
    // Cannot bind a readonly-list / readonly-dict reference to a set/var binding.
    if (value.type === 'IdentifierExpression') {
      const info = bindings.get(value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot bind a readonly-list reference to a '${ctx}' binding (name '${value.name}')`,
        this.currentLoc);
      }
      if (info?.type && info.type.kind === 'dict' && info.type.readonly) {
        throw new CompileError(
          `cannot bind a readonly-dictionary reference to a '${ctx}' binding (name '${value.name}')`,
        this.currentLoc);
      }
    }
  }

  private compilePrecall(
    precall: CallStatement,
    out: Instruction[],
    bindings: Bindings,
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

  private compileSet(
    stmt: ConstantDeclaration,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (bindings.has(stmt.name)) {
      throw new CompileError(`Duplicate binding: '${stmt.name}' is already declared`, this.currentLoc);
    }
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'STORE', name: stmt.name });
      bindings.set(stmt.name, { kind: 'constant', type: rt });
      return;
    }
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'constant');
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'STORE', name: stmt.name });
    const st = this.staticType(stmt.value, bindings);
    bindings.set(stmt.name, { kind: 'constant', type: st ?? undefined });
  }

  private compileVarDecl(
    stmt: VarDeclaration,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (bindings.has(stmt.name)) {
      throw new CompileError(
        `Duplicate binding: '${stmt.name}' is already declared`,
      this.currentLoc);
    }
    if (bindings !== this.topLevelBindings && this.outerBindings.has(stmt.name)) {
      throw new CompileError(
        `Variable '${stmt.name}' shadows outer binding`,
      this.currentLoc);
    }
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'STORE_VAR', name: stmt.name });
      bindings.set(stmt.name, { kind: 'var', type: rt });
      return;
    }
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'variable');
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'STORE_VAR', name: stmt.name });
    const st = this.staticType(stmt.value, bindings);
    bindings.set(stmt.name, { kind: 'var', type: st ?? undefined });
  }

  private compileChange(
    stmt: ChangeStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const info = bindings.get(stmt.name);
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
      this.emit(out, { op: 'STORE_VAR', name: stmt.name });
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
      // Prevent readonly smuggling via change
      if (rhs && rhs.kind === 'list' && rhs.readonly && info.type.kind === 'list' && !info.type.readonly) {
        throw new CompileError(
          `cannot change '${stmt.name}' to a readonly-list reference`,
        this.currentLoc);
      }
      if (rhs && rhs.kind === 'dict' && rhs.readonly && info.type.kind === 'dict' && !info.type.readonly) {
        throw new CompileError(
          `cannot change '${stmt.name}' to a readonly-dictionary reference`,
        this.currentLoc);
      }
    }
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'STORE_VAR', name: stmt.name });
  }

  private compileChangeItem(
    stmt: ChangeItemStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const info = bindings.get(stmt.listName);
    if (!info) {
      throw new CompileError(
        `Cannot change item of '${stmt.listName}': no such binding`,
      this.currentLoc);
    }
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
      if (info.type.readonly) {
        throw new CompileError(
          `Cannot change item of '${stmt.listName}': it is a readonly list reference`,
        this.currentLoc);
      }
      const rhs = this.staticType(stmt.value, bindings);
      const rc = elementCode(rhs);
      if (rc !== null && rc !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot assign ${elementHuman(rc)} to list of ${elementHuman(info.type.element)}`,
        this.currentLoc);
      }
    }
    // Emit: LOAD list; <index>; <value>; LIST_SET
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_SET' });
  }

  private compileListMutationTarget(listName: string, bindings: Bindings, op: string): ChatterType | null {
    const info = bindings.get(listName);
    if (!info) {
      throw new CompileError(`Cannot ${op} to '${listName}': no such binding`, this.currentLoc);
    }
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
    if (info.type && info.type.kind === 'list' && info.type.readonly) {
      throw new CompileError(
        `Cannot ${op} to '${listName}': it is a readonly list reference`,
      this.currentLoc);
    }
    return info.type ?? null;
  }

  private checkElementType(
    listType: ChatterType | null,
    value: Expression,
    bindings: Bindings,
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
    bindings: Bindings,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'append');
    this.checkElementType(lt, stmt.value, bindings, 'append');
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_APPEND' });
  }

  private compilePrepend(
    stmt: PrependStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'prepend');
    this.checkElementType(lt, stmt.value, bindings, 'prepend');
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_PREPEND' });
  }

  private compileInsert(
    stmt: InsertStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'insert');
    this.checkElementType(lt, stmt.value, bindings, 'insert');
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'LIST_INSERT' });
  }

  private compileRemove(
    stmt: RemoveItemStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    this.compileListMutationTarget(stmt.listName, bindings, 'remove');
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    this.emit(out, { op: 'LIST_REMOVE' });
  }

  private compileRemoveValue(
    stmt: RemoveValueStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const info = bindings.get(stmt.listName);
    if (!info) {
      throw new CompileError(
        `Cannot remove value from '${stmt.listName}': no such binding`,
      this.currentLoc);
    }
    if (info.type) {
      if (info.type.kind === 'list') {
        throw new CompileError(
          `'remove EXPR from NAME' is not a list operation; use 'remove item N from NAME' (name '${stmt.listName}')`,
        this.currentLoc);
      }
      if (info.type.kind === 'dict') {
        if (info.type.readonly) {
          throw new CompileError(
            `Cannot remove from '${stmt.listName}': it is a readonly dictionary reference`,
          this.currentLoc);
        }
        const rhs = this.staticType(stmt.value, bindings);
        const rc = elementCode(rhs);
        if (rc !== null && rc !== info.type.keyType) {
          throw new CompileError(
            `Type mismatch: dictionary key has type ${elementHuman(info.type.keyType)}, got ${elementHuman(rc)}`,
          this.currentLoc);
        }
        this.emit(out, { op: 'LOAD', name: stmt.listName });
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
    this.emit(out, { op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'UNIQUE_LIST_REMOVE' });
  }

  private compileCompoundAssign(
    stmt: CompoundAssignStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const info = bindings.get(stmt.name);
    if (!info) {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': no such variable declared in this function`,
      this.currentLoc);
    }
    // `add EXPR to NAME` is overloaded: for unique-list bindings, route to UNIQUE_LIST_ADD.
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
      this.emit(out, { op: 'LOAD', name: stmt.name });
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'UNIQUE_LIST_ADD' });
      return;
    }
    // `add EXPR to NAME` on a list → helpful error pointing at append/prepend/insert at.
    if (stmt.op === 'add' && info.type && info.type.kind === 'list') {
      throw new CompileError(
        `'add' cannot insert into a list (use 'append', 'prepend', or 'insert at' for '${stmt.name}')`,
      this.currentLoc);
    }
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': it is a ${info.kind === 'constant' ? "'constant' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'variable'`,
      this.currentLoc);
    }
    if (info.type !== undefined && !(info.type.kind === 'scalar' && info.type.name === 'number')) {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': its type is ${typeToString(info.type)}, not number`,
      this.currentLoc);
    }
    // Emit: LOAD name; <value>; OP; STORE_VAR name
    this.emit(out, { op: 'LOAD', name: stmt.name });
    this.compileExpr(stmt.value, out, bindings);
    switch (stmt.op) {
      case 'add':      this.emit(out, { op: 'ADD' }); break;
      case 'subtract': this.emit(out, { op: 'SUB' }); break;
      case 'multiply': this.emit(out, { op: 'MUL' }); break;
      case 'divide':   this.emit(out, { op: 'DIV' }); break;
    }
    this.emit(out, { op: 'STORE_VAR', name: stmt.name });
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

    const funcBindings: Bindings = new Map();
    for (const p of stmt.params) {
      funcBindings.set(p.name, {
        kind: 'param',
        type: this.fromAnnotation(p.paramType),
      });
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
  }

  private compileCallStmt(
    stmt: CallStatement,
    out: Instruction[],
    bindings: Bindings,
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
            // Widening: mutable → readonly OK. Narrowing: readonly → mutable rejected.
            if (argType.readonly && !paramType.readonly) {
              throw new CompileError(
                `Cannot pass readonly-list reference to mutable-list param '${sig[i].name}' in call to '${stmt.name}'`,
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
            // Widening: mutable → readonly OK. Narrowing: readonly → mutable rejected.
            if (argType.readonly && !paramType.readonly) {
              throw new CompileError(
                `Cannot pass readonly-dictionary reference to mutable-dictionary param '${sig[i].name}' in call to '${stmt.name}'`,
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
    bindings: Bindings,
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

      for (const s of branch.body) {
        this.compileStatement(s, out, bindings);
      }

      const exitIdx = out.length;
      this.emit(out, { op: 'JUMP', target: -1 });
      exitJumps.push(exitIdx);

      (out[jifIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
    }

    if (stmt.elseBody) {
      for (const s of stmt.elseBody) {
        this.compileStatement(s, out, bindings);
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
    bindings: Bindings,
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
      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
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
      if (bindings.has(loopVar) || this.outerBindings.has(loopVar)) {
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

      this.compileExpr(stmt.from, out, bindings);
      this.emit(out, { op: 'STORE', name: loopVar });
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
      this.emit(out, { op: 'LOAD', name: loopVar });
      this.emit(out, { op: 'LOAD', name: limit });
      this.emit(out, { op: 'LE' });
      const jifEndIdx = out.length;
      this.emit(out, { op: 'JUMP_IF_FALSE', target: -1 });

      bindings.set(loopVar, { kind: 'loop', type: { kind: 'scalar', name: 'number' } });
      const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
      this.loopStack.push(frame);
      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
      }
      this.loopStack.pop();
      bindings.delete(loopVar);

      const continueIdx = out.length;
      this.emit(out, { op: 'LOAD', name: loopVar });
      if (stepTmp !== null) {
        this.emit(out, { op: 'LOAD', name: stepTmp });
      } else {
        this.emit(out, { op: 'PUSH_INT', value: 1 });
      }
      this.emit(out, { op: 'ADD' });
      this.emit(out, { op: 'STORE', name: loopVar });
      this.emit(out, { op: 'JUMP', target: topIdx });
      const exitIdx = out.length;
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = exitIdx;
      for (const j of frame.continueJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = continueIdx;
      }
      for (const j of frame.exitJumps) {
        (out[j] as { op: 'JUMP'; target: number }).target = exitIdx;
      }
      this.emit(out, { op: 'DELETE', name: loopVar });
      this.emit(out, { op: 'DELETE', name: limit });
      if (stepTmp !== null) {
        this.emit(out, { op: 'DELETE', name: stepTmp });
      }
      return;
    }

    if (stmt.kind === 'list') {
      const loopVar = stmt.varName;
      if (bindings.has(loopVar) || this.outerBindings.has(loopVar)) {
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
      this.emit(out, { op: 'STORE', name: loopVar });

      bindings.set(loopVar, { kind: 'loop', type: elemType });
      const frame = { continueJumps: [] as number[], exitJumps: [] as number[] };
      this.loopStack.push(frame);
      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
      }
      this.loopStack.pop();
      bindings.delete(loopVar);

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
      this.emit(out, { op: 'DELETE', name: loopVar });
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
    for (const s of stmt.body) {
      this.compileStatement(s, out, bindings);
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
    bindings: Bindings,
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
    // Smuggling ban: a typed function that `return NAME` where NAME is a readonly list/dict → error.
    // (Also: the return type itself is never readonly per spec §8.)
    if (stmt.value.type === 'IdentifierExpression') {
      const info = bindings.get(stmt.value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot return readonly-list reference '${stmt.value.name}' from function '${this.currentFuncName}'`,
        this.currentLoc);
      }
      if (info?.type && info.type.kind === 'dict' && info.type.readonly) {
        throw new CompileError(
          `cannot return readonly-dictionary reference '${stmt.value.name}' from function '${this.currentFuncName}'`,
        this.currentLoc);
      }
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
        if (st.readonly && !rt.readonly) {
          throw new CompileError(
            `cannot return readonly-list reference from function '${this.currentFuncName}'`,
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
        if (st.readonly && !rt.readonly) {
          throw new CompileError(
            `cannot return readonly-dictionary reference from function '${this.currentFuncName}'`,
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
    bindings: Bindings,
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
    bindings: Bindings,
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
        if (!this.functionReturnTypes.has(expr.name)
            && !bindings.has(expr.name)
            && !this.outerBindings.has(expr.name)) {
          throw new CompileError(
            `Undefined variable: '${expr.name}'`,
          this.currentLoc);
        }
        this.emit(out, { op: 'LOAD', name: expr.name });
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
    bindings: Bindings,
    body: (itLocal: string) => void,
  ): { listTmp: string; idxTmp: string; lenTmp: string; itTmp: string } {
    const listTmp = this.freshName('hof_list');
    const idxTmp = this.freshName('hof_idx');
    const lenTmp = this.freshName('hof_len');
    const itTmp = this.freshName('hof_it');

    this.compileExpr(listExpr, out, bindings);
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
    bindings: Bindings,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
    const lt = this.staticType(stmt.list, bindings);
    if (lt && lt.kind !== 'list') {
      throw new CompileError(
        `'sort' requires a list, got ${typeToString(lt)}`,
      this.currentLoc);
    }
    const elemType = this.listElementType(lt);
    // Without a key expression, the list element type itself must be number or string.
    if (!stmt.key) {
      if (lt && lt.kind === 'list') {
        if (lt.element !== 'number' && lt.element !== 'string') {
          throw new CompileError(
            `'sort' without 'by KEY' requires a list of number or string, got ${typeToString(lt)}`,
          this.currentLoc);
        }
      }
      this.compileExpr(stmt.list, out, bindings);
      this.emit(out, { op: 'SORT_LIST', byKey: false, descending: stmt.descending });
      return;
    }

    // by KEY: build a parallel keys list, then sort items by keys.
    // Determine key type statically.
    this.hofItStack.push({ local: '__sort_key_probe__', type: elemType });
    let keyType: ChatterType | null;
    try {
      keyType = this.withHofBody(() => this.staticType(stmt.key!, bindings));
    } finally { this.hofItStack.pop(); }

    if (keyType === null) {
      throw new CompileError(
        `cannot determine static type of 'sort by KEY' expression; consider using a typed function call`,
      this.currentLoc);
    }
    if (keyType.kind !== 'scalar' || (keyType.name !== 'number' && keyType.name !== 'string')) {
      throw new CompileError(
        `'sort by KEY' requires KEY to be number or string, got ${typeToString(keyType)}`,
      this.currentLoc);
    }
    const keysTmp = this.freshName('hof_keys');

    // Compile source list once into listTmp (via compileHofLoop's listTmp).
    // We want SORT_LIST to operate on the SAME list reference, so pass the
    // *original* listTmp into SORT_LIST's stack.

    // Pre-create the keys list.
    this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: keyType.name });
    this.emit(out, { op: 'STORE', name: keysTmp });

    const tmps = this.compileHofLoop(stmt.list, elemType, out, bindings, (itLocal) => {
      this.emit(out, { op: 'LOAD', name: keysTmp });
      this.compileExpr(stmt.key!, out, bindings);
      this.emit(out, { op: 'LIST_APPEND' });
    });

    this.emit(out, { op: 'LOAD', name: tmps.listTmp });
    this.emit(out, { op: 'LOAD', name: keysTmp });
    this.emit(out, { op: 'SORT_LIST', byKey: true, descending: stmt.descending });

    this.emit(out, { op: 'DELETE', name: tmps.listTmp });
    this.emit(out, { op: 'DELETE', name: keysTmp });
  }

  private compileMap(
    expr: MapExpression,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
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
    bindings: Bindings,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
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

    // Result element type is source list element type (or 'number' fallback when unknown).
    let resCode: string | null = null;
    if (lt && (lt.kind === 'list' || lt.kind === 'uniqueList')) {
      resCode = lt.element;
    }
    if (resCode === null) {
      throw new CompileError(
        `cannot determine static element type for 'filter'; annotate the source list`,
      this.currentLoc);
    }
    const resTmp = this.freshName('hof_res');
    this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: resCode });
    this.emit(out, { op: 'STORE', name: resTmp });

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
    });

    this.emit(out, { op: 'LOAD', name: resTmp });
    this.emit(out, { op: 'DELETE', name: tmps.listTmp });
    this.emit(out, { op: 'DELETE', name: resTmp });
  }

  private compileReduce(
    expr: ReduceExpression,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (this.inHofBody) {
      throw new CompileError(
        `cannot nest higher-order list operations`,
      this.currentLoc);
    }
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
    bindings: Bindings,
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
    bindings: Bindings,
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
    bindings: Bindings,
  ): void {
    const info = bindings.get(stmt.dictName);
    if (!info) {
      throw new CompileError(
        `Cannot change value in '${stmt.dictName}': no such binding`,
      this.currentLoc);
    }
    if (info.type) {
      if (info.type.kind !== 'dict') {
        throw new CompileError(
          `Cannot change value in '${stmt.dictName}': not a dictionary (type ${typeToString(info.type)})`,
        this.currentLoc);
      }
      if (info.type.readonly) {
        throw new CompileError(
          `Cannot change value in '${stmt.dictName}': it is a readonly dictionary reference`,
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
    this.emit(out, { op: 'LOAD', name: stmt.dictName });
    this.compileExpr(stmt.key, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'DICT_SET' });
  }

  private compileUniqueListLiteral(
    expr: UniqueListLiteral,
    out: Instruction[],
    bindings: Bindings,
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
    bindings: Bindings,
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
    bindings: Bindings,
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
      if (lt && !(lt.kind === 'scalar' && lt.name === 'boolean')) {
        throw new CompileError(
          `Type mismatch: '${op}' requires booleans, got ${typeToString(lt)}`,
        this.currentLoc);
      }
      if (rt && !(rt.kind === 'scalar' && rt.name === 'boolean')) {
        throw new CompileError(
          `Type mismatch: '${op}' requires booleans, got ${typeToString(rt)}`,
        this.currentLoc);
      }
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
      case 'and': this.emit(out, { op: 'AND' }); break;
      case 'or':  this.emit(out, { op: 'OR' }); break;
      default:
        throw new CompileError(`Unknown operator: ${op}`, this.currentLoc);
    }
  }

  // Best-effort static type inference.
  private staticType(expr: Expression, bindings: Bindings): ChatterType | null {
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
        const info = bindings.get(expr.name);
        return info?.type ?? null;
      }
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        return rt ?? null;
      }
      case 'ListLiteral': {
        if (expr.kind === 'empty') {
          const code = this.elementAnnotationToCode(expr.elementType!);
          return { kind: 'list', element: code, readonly: false };
        }
        let inferred: string | null = null;
        for (const e of expr.elements) {
          const t = this.staticType(e, bindings);
          const c = elementCode(t);
          if (c !== null) { inferred = c; break; }
        }
        return inferred !== null ? { kind: 'list', element: inferred, readonly: false } : null;
      }
      case 'UniqueListLiteral': {
        if (expr.kind === 'empty') {
          const code = this.elementAnnotationToCode(expr.elementType!);
          return { kind: 'uniqueList', element: code, readonly: false };
        }
        let inferred: string | null = null;
        for (const e of expr.elements) {
          const t = this.staticType(e, bindings);
          const c = elementCode(t);
          if (c !== null) { inferred = c; break; }
        }
        return inferred !== null ? { kind: 'uniqueList', element: inferred, readonly: false } : null;
      }
      case 'DictionaryLiteral': {
        if (expr.kind === 'empty') {
          const k = this.elementAnnotationToCode(expr.keyType!);
          const v = this.elementAnnotationToCode(expr.valueType!);
          return { kind: 'dict', keyType: k, valueType: v, readonly: false };
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
          return { kind: 'dict', keyType: kInf, valueType: vInf, readonly: false };
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
      case 'ReadFileLinesExpression':
        return { kind: 'list', element: 'string', readonly: false };
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
            return { kind: 'uniqueList', element: tt.keyType, readonly: false };
          }
          if (expr.fieldName === 'values') {
            return { kind: 'list', element: tt.valueType, readonly: false };
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
          return { kind: 'list', element: code, readonly: false };
        } finally { this.hofItStack.pop(); }
      }
      case 'FilterExpression': {
        const lt = this.staticType(expr.list, bindings);
        if (!lt || (lt.kind !== 'list' && lt.kind !== 'uniqueList')) return null;
        return { kind: 'list', element: lt.element, readonly: false };
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
