import {
  Program, Statement, Expression,
  SayStatement, SetStatement, FunctionDeclaration,
  CallStatement, ReturnStatement, BinaryExpression, UnaryExpression,
  IfStatement, RepeatStatement,
  VarDeclaration, ChangeStatement, ChangeItemStatement, CompoundAssignStatement,
  ListLiteral, ItemAccessExpression, FirstItemExpression, LastItemExpression,
  LengthExpression, AppendStatement, PrependStatement, InsertStatement,
  RemoveItemStatement, TypeAnnotation, ScalarTypeName,
  CharacterAccessExpression, FirstCharacterExpression, LastCharacterExpression,
  SubstringExpression,
} from './ast';
import { Instruction, FunctionDef, BytecodeProgram } from './bytecode';

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
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

class Compiler {
  private functions = new Map<string, FunctionDef>();
  private functionSignatures = new Map<string, Array<{ name: string; label: string | null; type: ChatterType }>>();
  private functionReturnTypes = new Map<string, ChatterType | null>();  // null = void
  private outerBindings = new Set<string>();
  private topLevelBindings: Bindings | null = null;
  private tempCounter = 0;
  private currentFuncReturnType: ChatterType | null | undefined = undefined;  // undefined = top-level
  private currentFuncName: string | null = null;

  private freshName(tag: string): string {
    return `_rep_${tag}_${this.tempCounter++}`;
  }

  compile(program: Program): BytecodeProgram {
    // First pass: collect function signatures, return types, and outer bindings
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration') {
        this.functionSignatures.set(
          stmt.name,
          stmt.params.map(p => ({ name: p.name, label: p.label, type: fromAnnotation(p.paramType) })),
        );
        this.functionReturnTypes.set(
          stmt.name,
          stmt.returnType === null ? null : fromAnnotation(stmt.returnType),
        );
      }
      if (stmt.type === 'SetStatement' || stmt.type === 'VarDeclaration') {
        this.outerBindings.add(stmt.name);
      }
    }

    const main: Instruction[] = [];
    const bindings: Bindings = new Map();
    this.topLevelBindings = bindings;

    for (const stmt of program.body) {
      this.compileStatement(stmt, main, bindings);
    }

    return { functions: this.functions, main };
  }

  private compileStatement(
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
          out.push({ op: 'DROP' });
        } else {
          out.push({ op: 'STORE_IT' });
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
    }
  }

  private compileSay(
    stmt: SayStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    this.compileExpr(stmt.expression, out, bindings);
    out.push({ op: 'SAY' });
  }

  private checkNotReadonlySmuggle(value: Expression, bindings: Bindings, ctx: string): void {
    // Cannot bind a readonly-list reference to a set/var binding.
    if (value.type === 'IdentifierExpression') {
      const info = bindings.get(value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot bind a readonly-list reference to a '${ctx}' binding (name '${value.name}')`,
        );
      }
    }
  }

  private compileSet(
    stmt: SetStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (bindings.has(stmt.name)) {
      throw new CompileError(`Duplicate binding: '${stmt.name}' is already set`);
    }
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'set');
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE', name: stmt.name });
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
      );
    }
    if (bindings !== this.topLevelBindings && this.outerBindings.has(stmt.name)) {
      throw new CompileError(
        `Variable '${stmt.name}' shadows outer binding`,
      );
    }
    this.checkNotReadonlySmuggle(stmt.value, bindings, 'var');
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE_VAR', name: stmt.name });
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
      );
    }
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot change '${stmt.name}': it is a ${info.kind === 'set' ? "'set' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'var'`,
      );
    }
    // Static type check for list vars: exact match required.
    if (info.type && info.type.kind === 'list') {
      const rhs = this.staticType(stmt.value, bindings);
      if (rhs !== null && !typesEqual(rhs, info.type)) {
        throw new CompileError(
          `Type mismatch: cannot change '${stmt.name}' from ${typeToString(info.type)} to ${typeToString(rhs)}`,
        );
      }
      // Prevent readonly smuggling via change
      if (rhs && rhs.kind === 'list' && rhs.readonly && !info.type.readonly) {
        throw new CompileError(
          `cannot change '${stmt.name}' to a readonly-list reference`,
        );
      }
    }
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE_VAR', name: stmt.name });
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
      );
    }
    if (!info.type || info.type.kind !== 'list') {
      if (info.type) {
        throw new CompileError(
          `Cannot change item of '${stmt.listName}': not a list (type ${typeToString(info.type)})`,
        );
      }
    } else {
      if (info.type.readonly) {
        throw new CompileError(
          `Cannot change item of '${stmt.listName}': it is a readonly list reference`,
        );
      }
      const rhs = this.staticType(stmt.value, bindings);
      if (rhs && rhs.kind === 'scalar' && rhs.name !== info.type.element) {
        throw new CompileError(
          `Type mismatch: cannot assign ${rhs.name} to list of ${info.type.element}`,
        );
      }
    }
    // Emit: LOAD list; <index>; <value>; LIST_SET
    out.push({ op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'LIST_SET' });
  }

  private compileListMutationTarget(listName: string, bindings: Bindings, op: string): ChatterType | null {
    const info = bindings.get(listName);
    if (!info) {
      throw new CompileError(`Cannot ${op} to '${listName}': no such binding`);
    }
    if (info.type && info.type.kind !== 'list') {
      throw new CompileError(
        `Cannot ${op} to '${listName}': not a list (type ${typeToString(info.type)})`,
      );
    }
    if (info.type && info.type.kind === 'list' && info.type.readonly) {
      throw new CompileError(
        `Cannot ${op} to '${listName}': it is a readonly list reference`,
      );
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
        );
      }
      if (rhs && rhs.kind === 'list') {
        throw new CompileError(
          `Type mismatch: cannot ${op} a list value to list of ${listType.element}`,
        );
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
    out.push({ op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'LIST_APPEND' });
  }

  private compilePrepend(
    stmt: PrependStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'prepend');
    this.checkElementType(lt, stmt.value, bindings, 'prepend');
    out.push({ op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'LIST_PREPEND' });
  }

  private compileInsert(
    stmt: InsertStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const lt = this.compileListMutationTarget(stmt.listName, bindings, 'insert');
    this.checkElementType(lt, stmt.value, bindings, 'insert');
    out.push({ op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'LIST_INSERT' });
  }

  private compileRemove(
    stmt: RemoveItemStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    this.compileListMutationTarget(stmt.listName, bindings, 'remove');
    out.push({ op: 'LOAD', name: stmt.listName });
    this.compileExpr(stmt.index, out, bindings);
    out.push({ op: 'LIST_REMOVE' });
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
      );
    }
    if (info.kind !== 'var') {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': it is a ${info.kind === 'set' ? "'set' binding (immutable)" : info.kind === 'param' ? 'parameter' : 'loop variable'}, not a 'var'`,
      );
    }
    if (info.type !== undefined && !(info.type.kind === 'scalar' && info.type.name === 'number')) {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': its type is ${typeToString(info.type)}, not number`,
      );
    }
    // Emit: LOAD name; <value>; OP; STORE_VAR name
    out.push({ op: 'LOAD', name: stmt.name });
    this.compileExpr(stmt.value, out, bindings);
    switch (stmt.op) {
      case 'add':      out.push({ op: 'ADD' }); break;
      case 'subtract': out.push({ op: 'SUB' }); break;
      case 'multiply': out.push({ op: 'MUL' }); break;
      case 'divide':   out.push({ op: 'DIV' }); break;
    }
    out.push({ op: 'STORE_VAR', name: stmt.name });
  }

  private compileFuncDecl(stmt: FunctionDeclaration): void {
    const params = stmt.params.map(p => p.name);

    // Params may not shadow outer-scope bindings
    for (const param of params) {
      if (this.outerBindings.has(param)) {
        throw new CompileError(
          `Parameter '${param}' in function '${stmt.name}' shadows outer binding`,
        );
      }
    }

    // Typed functions: every execution path must end with an explicit `return EXPR`.
    if (stmt.returnType !== null) {
      if (!blockTerminates(stmt.body)) {
        throw new CompileError(
          `missing return in typed function '${stmt.name}'; every path must return a ${typeToString(fromAnnotation(stmt.returnType))}`,
        );
      }
    }

    const instructions: Instruction[] = [];
    const funcDef: FunctionDef = { name: stmt.name, params, instructions };
    this.functions.set(stmt.name, funcDef);

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
      instructions.push({ op: 'PUSH_INT', value: 0 });
      instructions.push({ op: 'RETURN' });
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
            );
          }
          if (sig.length === 0) {
            throw new CompileError(
              `Function '${stmt.name}' takes no arguments`,
            );
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
              );
            }
            throw new CompileError(
              `Unknown argument label '${arg.name}' in call to '${stmt.name}'`,
            );
          }
          bound[idx] = arg.value;
        }
      }

      for (let i = 0; i < sig.length; i++) {
        if (bound[i] === undefined) {
          throw new CompileError(
            `Missing argument for parameter '${sig[i].name}' in call to '${stmt.name}'`,
          );
        }
        const argExpr = bound[i]!;
        // Static list-type check for arguments.
        const paramType = sig[i].type;
        const argType = this.staticType(argExpr, bindings);
        if (paramType.kind === 'list' && argType && argType.kind === 'list') {
          if (argType.element !== paramType.element) {
            throw new CompileError(
              `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${typeToString(argType)}`,
            );
          }
          // Widening: mutable → readonly OK. Narrowing: readonly → mutable rejected.
          if (argType.readonly && !paramType.readonly) {
            throw new CompileError(
              `Cannot pass readonly-list reference to mutable-list param '${sig[i].name}' in call to '${stmt.name}'`,
            );
          }
        } else if (paramType.kind === 'list' && argType && argType.kind === 'scalar') {
          throw new CompileError(
            `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${typeToString(paramType)}, got ${argType.name}`,
          );
        } else if (paramType.kind === 'scalar' && argType && argType.kind === 'list') {
          throw new CompileError(
            `Type mismatch in call to '${stmt.name}' arg '${sig[i].name}': expected ${paramType.name}, got ${typeToString(argType)}`,
          );
        }
        this.compileExpr(argExpr, out, bindings);
      }

      out.push({ op: 'CALL', name: stmt.name, argCount: sig.length });
    } else {
      for (const arg of stmt.args) {
        this.compileExpr(arg.value, out, bindings);
      }
      out.push({ op: 'CALL', name: stmt.name, argCount: stmt.args.length });
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
      out.push({ op: 'JUMP_IF_FALSE', target: -1 });

      for (const s of branch.body) {
        this.compileStatement(s, out, bindings);
      }

      const exitIdx = out.length;
      out.push({ op: 'JUMP', target: -1 });
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
      out.push({ op: 'STORE', name: limit });
      out.push({ op: 'PUSH_INT', value: 0 });
      out.push({ op: 'STORE', name: counter });

      out.push({ op: 'LOAD', name: limit });
      out.push({ op: 'PUSH_INT', value: 0 });
      out.push({ op: 'LT' });
      const jifNegIdx = out.length;
      out.push({ op: 'JUMP_IF_FALSE', target: -1 });
      out.push({ op: 'ERROR', message: 'repeat count cannot be negative' });
      (out[jifNegIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;

      const topIdx = out.length;
      out.push({ op: 'LOAD', name: counter });
      out.push({ op: 'LOAD', name: limit });
      out.push({ op: 'LT' });
      const jifEndIdx = out.length;
      out.push({ op: 'JUMP_IF_FALSE', target: -1 });

      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
      }

      out.push({ op: 'LOAD', name: counter });
      out.push({ op: 'PUSH_INT', value: 1 });
      out.push({ op: 'ADD' });
      out.push({ op: 'STORE', name: counter });
      out.push({ op: 'JUMP', target: topIdx });
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
      return;
    }

    if (stmt.kind === 'range') {
      const loopVar = stmt.varName;
      if (bindings.has(loopVar) || this.outerBindings.has(loopVar)) {
        throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`);
      }

      const limit = this.freshName('limit');

      this.compileExpr(stmt.from, out, bindings);
      out.push({ op: 'STORE', name: loopVar });
      this.compileExpr(stmt.to, out, bindings);
      out.push({ op: 'STORE', name: limit });

      const topIdx = out.length;
      out.push({ op: 'LOAD', name: loopVar });
      out.push({ op: 'LOAD', name: limit });
      out.push({ op: 'LE' });
      const jifEndIdx = out.length;
      out.push({ op: 'JUMP_IF_FALSE', target: -1 });

      bindings.set(loopVar, { kind: 'loop', type: { kind: 'scalar', name: 'number' } });
      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
      }
      bindings.delete(loopVar);

      out.push({ op: 'LOAD', name: loopVar });
      out.push({ op: 'PUSH_INT', value: 1 });
      out.push({ op: 'ADD' });
      out.push({ op: 'STORE', name: loopVar });
      out.push({ op: 'JUMP', target: topIdx });
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
      out.push({ op: 'DELETE', name: loopVar });
      out.push({ op: 'DELETE', name: limit });
      return;
    }

    if (stmt.kind === 'list') {
      const loopVar = stmt.varName;
      if (bindings.has(loopVar) || this.outerBindings.has(loopVar)) {
        throw new CompileError(`Loop variable '${loopVar}' shadows outer binding`);
      }

      // Determine element type if statically known.
      const lt = this.staticType(stmt.list, bindings);
      let elemType: ChatterType | undefined;
      if (lt) {
        if (lt.kind !== 'list') {
          throw new CompileError(
            `'repeat with x in ...' requires a list, got ${typeToString(lt)}`,
          );
        }
        elemType = { kind: 'scalar', name: lt.element };
      }

      const listTmp = this.freshName('list');
      const idxTmp = this.freshName('idx');
      const lenTmp = this.freshName('len');

      this.compileExpr(stmt.list, out, bindings);
      out.push({ op: 'STORE', name: listTmp });
      out.push({ op: 'LOAD', name: listTmp });
      out.push({ op: 'LENGTH' });
      out.push({ op: 'STORE', name: lenTmp });
      out.push({ op: 'PUSH_INT', value: 1 });
      out.push({ op: 'STORE', name: idxTmp });

      const topIdx = out.length;
      out.push({ op: 'LOAD', name: idxTmp });
      out.push({ op: 'LOAD', name: lenTmp });
      out.push({ op: 'LE' });
      const jifEndIdx = out.length;
      out.push({ op: 'JUMP_IF_FALSE', target: -1 });

      // Bind loop var to current element.
      out.push({ op: 'LOAD', name: listTmp });
      out.push({ op: 'LOAD', name: idxTmp });
      out.push({ op: 'LIST_GET' });
      out.push({ op: 'STORE', name: loopVar });

      bindings.set(loopVar, { kind: 'loop', type: elemType });
      for (const s of stmt.body) {
        this.compileStatement(s, out, bindings);
      }
      bindings.delete(loopVar);

      out.push({ op: 'LOAD', name: idxTmp });
      out.push({ op: 'PUSH_INT', value: 1 });
      out.push({ op: 'ADD' });
      out.push({ op: 'STORE', name: idxTmp });
      out.push({ op: 'JUMP', target: topIdx });
      (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
      out.push({ op: 'DELETE', name: loopVar });
      out.push({ op: 'DELETE', name: listTmp });
      out.push({ op: 'DELETE', name: idxTmp });
      out.push({ op: 'DELETE', name: lenTmp });
      return;
    }

    // while
    const topIdx = out.length;
    this.compileExpr(stmt.condition, out, bindings);
    const jifEndIdx = out.length;
    out.push({ op: 'JUMP_IF_FALSE', target: -1 });
    for (const s of stmt.body) {
      this.compileStatement(s, out, bindings);
    }
    out.push({ op: 'JUMP', target: topIdx });
    (out[jifEndIdx] as { op: 'JUMP_IF_FALSE'; target: number }).target = out.length;
  }

  private compileReturn(
    stmt: ReturnStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const rt = this.currentFuncReturnType;
    if (rt === undefined) {
      throw new CompileError(`'return' outside of function body`);
    }
    if (rt === null) {
      // Void function
      if (stmt.value !== null) {
        throw new CompileError(
          `void function '${this.currentFuncName}' cannot return a value`,
        );
      }
      out.push({ op: 'PUSH_INT', value: 0 });
      out.push({ op: 'RETURN' });
      return;
    }
    // Typed function
    if (stmt.value === null) {
      throw new CompileError(
        `typed function '${this.currentFuncName}' must return a ${typeToString(rt)}`,
      );
    }
    // Smuggling ban: a typed function that `return NAME` where NAME is a readonly list → error.
    // (Also: the return type itself is never readonly per spec §8.)
    if (stmt.value.type === 'IdentifierExpression') {
      const info = bindings.get(stmt.value.name);
      if (info?.type && info.type.kind === 'list' && info.type.readonly) {
        throw new CompileError(
          `cannot return readonly-list reference '${stmt.value.name}' from function '${this.currentFuncName}'`,
        );
      }
    }
    const st = this.staticType(stmt.value, bindings);
    if (st !== null) {
      if (st.kind !== rt.kind) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
        );
      }
      if (rt.kind === 'scalar' && st.kind === 'scalar' && rt.name !== st.name) {
        throw new CompileError(
          `Type mismatch: function '${this.currentFuncName}' declared to return ${rt.name}, but return expression has type ${st.name}`,
        );
      }
      if (rt.kind === 'list' && st.kind === 'list') {
        if (rt.element !== st.element) {
          throw new CompileError(
            `Type mismatch: function '${this.currentFuncName}' declared to return ${typeToString(rt)}, but return expression has type ${typeToString(st)}`,
          );
        }
        if (st.readonly && !rt.readonly) {
          throw new CompileError(
            `cannot return readonly-list reference from function '${this.currentFuncName}'`,
          );
        }
      }
    }
    this.compileExpr(stmt.value, out, bindings);
    if (st === null && rt.kind === 'scalar') {
      out.push({
        op: 'CHECK_TYPE',
        expected: rt.name,
        context: `function '${this.currentFuncName}' return value`,
      });
    }
    out.push({ op: 'RETURN' });
  }

  private compileExpr(
    expr: Expression,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    switch (expr.type) {
      case 'NumberLiteral':
        out.push({ op: 'PUSH_INT', value: expr.value });
        break;
      case 'StringLiteral':
        out.push({ op: 'PUSH_STR', value: expr.value });
        break;
      case 'BooleanLiteral':
        out.push({ op: 'PUSH_BOOL', value: expr.value });
        break;
      case 'IdentifierExpression':
        if (this.functionReturnTypes.get(expr.name) === null) {
          throw new CompileError(
            `void function '${expr.name}' cannot be used as a value`,
          );
        }
        out.push({ op: 'LOAD', name: expr.name });
        break;
      case 'ItExpression':
        out.push({ op: 'LOAD_IT' });
        break;
      case 'BinaryExpression':
        this.compileBinary(expr, out, bindings);
        break;
      case 'UnaryExpression':
        this.compileExpr(expr.operand, out, bindings);
        out.push({ op: 'NOT' });
        break;
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        if (rt === null) {
          throw new CompileError(
            `void function '${expr.name}' cannot be used as a value`,
          );
        }
        this.compileCallStmt(expr, out, bindings);
        break;
      }
      case 'ListLiteral':
        this.compileListLiteral(expr, out, bindings);
        break;
      case 'ItemAccessExpression':
        this.compileExpr(expr.target, out, bindings);
        this.compileExpr(expr.index, out, bindings);
        out.push({ op: 'LIST_GET' });
        break;
      case 'FirstItemExpression':
        this.compileExpr(expr.target, out, bindings);
        out.push({ op: 'PUSH_INT', value: 1 });
        out.push({ op: 'LIST_GET' });
        break;
      case 'LastItemExpression': {
        // LOAD list; LENGTH; LIST_GET — but we need the list twice.
        // Use a fresh temp.
        const tmp = this.freshName('last');
        this.compileExpr(expr.target, out, bindings);
        out.push({ op: 'STORE', name: tmp });
        out.push({ op: 'LOAD', name: tmp });
        out.push({ op: 'LOAD', name: tmp });
        out.push({ op: 'LENGTH' });
        out.push({ op: 'LIST_GET' });
        out.push({ op: 'DELETE', name: tmp });
        break;
      }
      case 'LengthExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && tt.kind === 'scalar' && tt.name !== 'string') {
          throw new CompileError(
            `'length of' requires a list or string, got ${typeToString(tt)}`,
          );
        }
        this.compileExpr(expr.target, out, bindings);
        out.push({ op: 'LENGTH' });
        break;
      }
      case 'CharacterAccessExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'character N of' requires a string, got ${typeToString(tt)}`,
          );
        }
        this.compileExpr(expr.target, out, bindings);
        this.compileExpr(expr.index, out, bindings);
        out.push({ op: 'STR_CHAR_AT' });
        break;
      }
      case 'FirstCharacterExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'first character of' requires a string, got ${typeToString(tt)}`,
          );
        }
        this.compileExpr(expr.target, out, bindings);
        out.push({ op: 'PUSH_INT', value: 1 });
        out.push({ op: 'STR_CHAR_AT' });
        break;
      }
      case 'LastCharacterExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'last character of' requires a string, got ${typeToString(tt)}`,
          );
        }
        const tmp = this.freshName('lastch');
        this.compileExpr(expr.target, out, bindings);
        out.push({ op: 'STORE', name: tmp });
        out.push({ op: 'LOAD', name: tmp });
        out.push({ op: 'LOAD', name: tmp });
        out.push({ op: 'LENGTH' });
        out.push({ op: 'STR_CHAR_AT' });
        out.push({ op: 'DELETE', name: tmp });
        break;
      }
      case 'SubstringExpression': {
        const tt = this.staticType(expr.target, bindings);
        if (tt !== null && !(tt.kind === 'scalar' && tt.name === 'string')) {
          throw new CompileError(
            `'characters A to B of' requires a string, got ${typeToString(tt)}`,
          );
        }
        this.compileExpr(expr.target, out, bindings);
        this.compileExpr(expr.from, out, bindings);
        this.compileExpr(expr.to, out, bindings);
        out.push({ op: 'STR_SUBSTRING' });
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
      out.push({ op: 'MAKE_EMPTY_LIST', elementType: expr.elementType! });
      return;
    }
    // Nonempty: static type check when knowable.
    let inferred: ScalarTypeName | null = null;
    let allKnown = true;
    for (const e of expr.elements) {
      const t = this.staticType(e, bindings);
      if (t === null) { allKnown = false; continue; }
      if (t.kind !== 'scalar') {
        throw new CompileError(`nested lists not supported`);
      }
      if (inferred === null) inferred = t.name;
      else if (inferred !== t.name) {
        throw new CompileError(
          `Type mismatch in list literal: mixed element types (${inferred} and ${t.name})`,
        );
      }
    }
    for (const e of expr.elements) {
      this.compileExpr(e, out, bindings);
    }
    out.push({
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
          );
        }
      } else if (lt !== null && lt.kind === 'scalar' && lt.name !== 'string') {
        throw new CompileError(
          `'contains' requires a list or string on the left, got ${typeToString(lt)}`,
        );
      } else if (lt !== null && lt.kind === 'list') {
        // Existing list element-type check
        const rt = this.staticType(expr.right, bindings);
        if (rt && rt.kind === 'scalar' && rt.name !== lt.element) {
          throw new CompileError(
            `Type mismatch: 'contains' value type ${rt.name} does not match list element type ${lt.element}`,
          );
        }
        if (rt && rt.kind === 'list') {
          throw new CompileError(
            `Type mismatch: 'contains' value cannot be a list`,
          );
        }
      }
      this.compileExpr(expr.left, out, bindings);
      this.compileExpr(expr.right, out, bindings);
      out.push({ op: 'CONTAINS' });
      return;
    }
    this.compileExpr(expr.left, out, bindings);
    this.compileExpr(expr.right, out, bindings);
    switch (expr.operator) {
      case '+':  out.push({ op: 'ADD' }); break;
      case '-':  out.push({ op: 'SUB' }); break;
      case '*':  out.push({ op: 'MUL' }); break;
      case '/':  out.push({ op: 'DIV' }); break;
      case '&':  out.push({ op: 'CONCAT' }); break;
      case 'mod': out.push({ op: 'MOD' }); break;
      case '**': out.push({ op: 'POW' }); break;
      case '==': out.push({ op: 'EQ' }); break;
      case '!=': out.push({ op: 'NEQ' }); break;
      case '<':  out.push({ op: 'LT' }); break;
      case '<=': out.push({ op: 'LE' }); break;
      case '>':  out.push({ op: 'GT' }); break;
      case '>=': out.push({ op: 'GE' }); break;
      case 'and': out.push({ op: 'AND' }); break;
      case 'or':  out.push({ op: 'OR' }); break;
      default:
        throw new CompileError(`Unknown operator: ${expr.operator}`);
    }
  }

  // Best-effort static type inference.
  private staticType(expr: Expression, bindings: Bindings): ChatterType | null {
    switch (expr.type) {
      case 'NumberLiteral': return { kind: 'scalar', name: 'number' };
      case 'StringLiteral': return { kind: 'scalar', name: 'string' };
      case 'BooleanLiteral': return { kind: 'scalar', name: 'boolean' };
      case 'UnaryExpression': return { kind: 'scalar', name: 'boolean' };
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
      case 'CharacterAccessExpression':
      case 'FirstCharacterExpression':
      case 'LastCharacterExpression':
      case 'SubstringExpression':
        return { kind: 'scalar', name: 'string' };
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
