import {
  Program, Statement, Expression, Located,
  SayStatement, SetStatement, FunctionDeclaration,
  CallStatement, ReturnStatement, BinaryExpression, UnaryExpression,
  IfStatement, RepeatStatement,
  VarDeclaration, ChangeStatement, ChangeItemStatement, CompoundAssignStatement,
  ListLiteral, ItemAccessExpression, FirstItemExpression, LastItemExpression,
  LengthExpression, AppendStatement, PrependStatement, InsertStatement,
  RemoveItemStatement, TypeAnnotation, ScalarTypeName,
  CharacterAccessExpression, FirstCharacterExpression, LastCharacterExpression,
  SubstringExpression,
  EndIndexSentinel,
  ReadFileLinesExpression, ReadFileStatement,
  ExpectStatement,
  ExitRepeatStatement, NextRepeatStatement,
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
  return { line: node.line, col: node.col, length: node.length };
}

function containsEndSentinel(expr: Expression | null | undefined): boolean {
  if (!expr) return false;
  switch (expr.type) {
    case 'EndIndexSentinel': return true;
    case 'BinaryExpression':
      return containsEndSentinel(expr.left) || containsEndSentinel(expr.right);
    case 'UnaryExpression':
      return containsEndSentinel(expr.operand);
    // Stop at nested indexable forms: their index slots have their own scope.
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
  | { kind: 'list'; element: ScalarTypeName; readonly: boolean };

function typesEqual(a: ChatterType, b: ChatterType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'scalar' && b.kind === 'scalar') return a.name === b.name;
  if (a.kind === 'list' && b.kind === 'list') {
    return a.element === b.element && a.readonly === b.readonly;
  }
  return false;
}

function typeToString(t: ChatterType): string {
  if (t.kind === 'scalar') return t.name;
  return (t.readonly ? 'readonly list of ' : 'list of ') + t.element;
}

function fromAnnotation(a: TypeAnnotation): ChatterType {
  if (a.kind === 'scalar') return { kind: 'scalar', name: a.name };
  return { kind: 'list', element: a.element, readonly: a.readonly };
}

type BindingKind = 'set' | 'var' | 'param' | 'loop';

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

export interface CompileOptions {
  moduleId?: string;
  imports?: Map<string, ImportedFunction>;
}

export interface CompiledModule {
  functions: Map<string, FunctionDef>;      // keyed by mangled names
  topLevel: Instruction[];                  // module top-level instructions
  exports: Map<string, ImportedFunction>;   // local name -> info (for loader)
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

  // Loop control stack: each entry records pending JUMP instruction indices
  // that must be patched to the loop's continue / exit targets.
  private loopStack: Array<{
    continueJumps: number[];
    exitJumps: number[];
  }> = [];

  private get currentLoc(): SourceLocation | undefined {
    return this.locStack[this.locStack.length - 1];
  }

  private emit(out: Instruction[], instr: InstructionKind): void {
    const withLoc = instr as Instruction;
    if (withLoc.loc === undefined && this.currentLoc !== undefined) {
      // Attach loc as a non-enumerable property so deep-equality checks in
      // tests (e.g. toContainEqual) ignore it while the VM can still read it.
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

  compile(program: Program): BytecodeProgram {
    const m = this.compileModule(program, {});
    return { functions: m.functions, main: m.topLevel };
  }

  compileModule(program: Program, opts: CompileOptions): CompiledModule {
    this.moduleId = opts.moduleId ?? null;
    this.imports = opts.imports ?? new Map();

    // Seed signatures / returnTypes from imports (they're callable by local name)
    for (const [localName, info] of this.imports) {
      this.functionSignatures.set(localName, info.signature);
      this.functionReturnTypes.set(localName, info.returnType);
    }

    // First pass: collect local function signatures, return types, outer bindings
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration') {
        if (this.imports.has(stmt.name)) {
          throw new CompileError(
            `name '${stmt.name}' is already defined`,
            locOf(stmt),
          );
        }
        this.functionSignatures.set(
          stmt.name,
          stmt.params.map(p => ({ name: p.name, label: p.label, type: fromAnnotation(p.paramType) })),
        );
        this.functionReturnTypes.set(
          stmt.name,
          stmt.returnType === null ? null : fromAnnotation(stmt.returnType),
        );
        const mangled = this.moduleId ? `${this.moduleId}::${stmt.name}` : stmt.name;
        this.functionMangled.set(stmt.name, mangled);
        this.localFunctions.set(stmt.name, stmt);
      }
      if (stmt.type === 'SetStatement' || stmt.type === 'VarDeclaration') {
        this.outerBindings.add(stmt.name);
      }
    }

    const topLevel: Instruction[] = [];
    const bindings: Bindings = new Map();
    this.topLevelBindings = bindings;

    for (const stmt of program.body) {
      if (stmt.type === 'UseStatement') continue;  // loader handled these
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

    return { functions: this.functions, topLevel, exports };
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
      case 'SetStatement':
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
    }
  }

  private compileExpect(
    stmt: ExpectStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
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
    // Cannot bind a readonly-list reference to a set/var binding.
    if (value.type === 'IdentifierExpression') {
      const info = bindings.get(value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot bind a readonly-list reference to a '${ctx}' binding (name '${value.name}')`,
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
    stmt: SetStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (bindings.has(stmt.name)) {
      throw new CompileError(`Duplicate binding: '${stmt.name}' is already set`, this.currentLoc);
    }
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'STORE', name: stmt.name });
      bindings.set(stmt.name, { kind: 'set', type: rt });
      return;
    }
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'set');
    this.compileExpr(stmt.value, out, bindings);
    this.emit(out, { op: 'STORE', name: stmt.name });
    const st = this.staticType(stmt.value, bindings);
    bindings.set(stmt.name, { kind: 'set', type: st ?? undefined });
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
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'var');
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
        `Cannot change '${stmt.name}': it is a ${info.kind === 'set' ? "'set' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'var'`,
      this.currentLoc);
    }
    if (stmt.precall) {
      const rt = this.compilePrecall(stmt.precall, out, bindings);
      if (info.type) {
        if (info.type.kind !== rt.kind ||
            (info.type.kind === 'scalar' && rt.kind === 'scalar' && info.type.name !== rt.name) ||
            (info.type.kind === 'list' && rt.kind === 'list' && info.type.element !== rt.element)) {
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
    // Static type check for list vars: exact match required.
    if (info.type && info.type.kind === 'list') {
      const rhs = this.staticType(stmt.value, bindings);
      if (rhs !== null && !typesEqual(rhs, info.type)) {
        throw new CompileError(
          `Type mismatch: cannot change '${stmt.name}' from ${typeToString(info.type)} to ${typeToString(rhs)}`,
        this.currentLoc);
      }
      // Prevent readonly smuggling via change
      if (rhs && rhs.kind === 'list' && rhs.readonly && !info.type.readonly) {
        throw new CompileError(
          `cannot change '${stmt.name}' to a readonly-list reference`,
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
      if (rhs && rhs.kind === 'scalar' && rhs.name !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot assign ${rhs.name} to list of ${info.type.element}`,
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
      if (rhs && rhs.kind === 'scalar' && rhs.name !== listType.element) {
        throw new CompileError(
          `Type mismatch: cannot ${op} ${rhs.name} to list of ${listType.element}`,
        this.currentLoc);
      }
      if (rhs && rhs.kind === 'list') {
        throw new CompileError(
          `Type mismatch: cannot ${op} a list value to list of ${listType.element}`,
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
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': it is a ${info.kind === 'set' ? "'set' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'var'`,
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
          `missing return in typed function '${stmt.name}'; every path must return a ${typeToString(fromAnnotation(stmt.returnType))}`,
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
        type: fromAnnotation(p.paramType),
      });
    }
    const prevReturnType = this.currentFuncReturnType;
    const prevFuncName = this.currentFuncName;
    this.currentFuncReturnType = stmt.returnType === null ? null : fromAnnotation(stmt.returnType);
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
        // Static list-type check for arguments.
        const paramType = sig[i].type;
        const argType = this.staticType(argExpr, bindings);
        if (paramType.kind === 'list' && argType && argType.kind === 'list') {
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
        } else if (paramType.kind === 'list' && argType && argType.kind === 'scalar') {
          throw new CompileError(
            `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${argType.name}`,
          this.currentLoc);
        } else if (paramType.kind === 'scalar' && argType && argType.kind === 'list') {
          throw new CompileError(
            `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${paramType.name}, got ${typeToString(argType)}`,
          this.currentLoc);
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
        if (lt.kind !== 'list') {
          throw new CompileError(
            `'repeat with x in ...' requires a list, got ${typeToString(lt)}`,
          this.currentLoc);
        }
        elemType = { kind: 'scalar', name: lt.element };
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
      if (callRt.kind !== rt.kind ||
          (callRt.kind === 'scalar' && rt.kind === 'scalar' && callRt.name !== rt.name) ||
          (callRt.kind === 'list' && rt.kind === 'list' && callRt.element !== rt.element)) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(callRt)}`,
          this.currentLoc,
        );
      }
      this.compileExpr(stmt.value, out, bindings);
      this.emit(out, { op: 'RETURN' });
      return;
    }
    // Smuggling ban: a typed function that `return NAME` where NAME is a readonly list → error.
    // (Also: the return type itself is never readonly per spec §8.)
    if (stmt.value.type === 'IdentifierExpression') {
      const info = bindings.get(stmt.value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot return readonly-list reference '${stmt.value.name}' from function '${this.currentFuncName}'`,
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
        if (this.functionReturnTypes.get(expr.name) === null) {
          throw new CompileError(
            `void function '${expr.name}' cannot be used as a value`,
          this.currentLoc);
        }
        this.emit(out, { op: 'LOAD', name: expr.name });
        break;
      case 'ItExpression':
        this.emit(out, { op: 'LOAD_IT' });
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
      case 'ItemAccessExpression': {
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
      case 'FirstItemExpression':
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'PUSH_INT', value: 1 });
        this.emit(out, { op: 'LIST_GET' });
        break;
      case 'LastItemExpression': {
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
      case 'FirstCharacterExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'first character of' requires a string, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'PUSH_INT', value: 1 });
        this.emit(out, { op: 'STR_CHAR_AT' });
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
            && tt.kind !== 'list') {
          throw new CompileError(
            `'is empty' requires a string or list, got ${typeToString(tt)}`,
          this.currentLoc);
        }
        this.compileExpr(expr.target, out, bindings);
        this.emit(out, { op: 'IS_EMPTY' });
        break;
      }
    }
  }

  private compileListLiteral(
    expr: ListLiteral,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (expr.kind === 'empty') {
      this.emit(out, { op: 'MAKE_EMPTY_LIST', elementType: expr.elementType! });
      return;
    }
    // Nonempty: static type check when knowable.
    let inferred: ScalarTypeName | null = null;
    let allKnown = true;
    for (const e of expr.elements) {
      const t = this.staticType(e, bindings);
      if (t === null) { allKnown = false; continue; }
      if (t.kind !== 'scalar') {
        throw new CompileError(`nested lists not supported`, this.currentLoc);
      }
      if (inferred === null) inferred = t.name;
      else if (inferred !== t.name) {
        throw new CompileError(
          `Type mismatch in list literal: mixed element types (${inferred} and ${t.name})`,
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
      } else if (lt !== null && lt.kind === 'list') {
        // Existing list element-type check
        const rt = this.staticType(expr.right, bindings);
        if (rt && rt.kind === 'scalar' && rt.name !== lt.element) {
          throw new CompileError(
            `Type mismatch: 'contains' value type ${rt.name} does not match list element type ${lt.element}`,
          this.currentLoc);
        }
        if (rt && rt.kind === 'list') {
          throw new CompileError(
            `Type mismatch: 'contains' value cannot be a list`,
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
    switch (expr.operator) {
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
        throw new CompileError(`Unknown operator: ${expr.operator}`, this.currentLoc);
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
        const info = bindings.get(expr.name);
        return info?.type ?? null;
      }
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        return rt ?? null;
      }
      case 'ListLiteral': {
        if (expr.kind === 'empty') {
          return { kind: 'list', element: expr.elementType!, readonly: false };
        }
        // Try to infer from first element with known type.
        let inferred: ScalarTypeName | null = null;
        for (const e of expr.elements) {
          const t = this.staticType(e, bindings);
          if (t && t.kind === 'scalar') { inferred = t.name; break; }
        }
        return inferred ? { kind: 'list', element: inferred, readonly: false } : null;
      }
      case 'ItemAccessExpression':
      case 'FirstItemExpression':
      case 'LastItemExpression': {
        const tt = this.staticType((expr as any).target, bindings);
        if (tt && tt.kind === 'list') return { kind: 'scalar', name: tt.element };
        return null;
      }
      case 'LengthExpression':
        return { kind: 'scalar', name: 'number' };
      case 'EndIndexSentinel':
        return { kind: 'scalar', name: 'number' };
      case 'CharacterAccessExpression':
      case 'FirstCharacterExpression':
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
