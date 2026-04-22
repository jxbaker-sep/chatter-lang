import {
  Program, Statement, Expression,
  SayStatement, SetStatement, FunctionDeclaration,
  CallStatement, ReturnStatement, BinaryExpression, UnaryExpression,
  IfStatement, RepeatStatement,
  VarDeclaration, ChangeStatement, CompoundAssignStatement,
} from './ast';
import { Instruction, FunctionDef, BytecodeProgram } from './bytecode';

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

type ChatterType = 'number' | 'string' | 'boolean';
type BindingKind = 'set' | 'var' | 'param' | 'loop';

interface BindingInfo {
  kind: BindingKind;
  type?: ChatterType;  // statically known type (locked for var, declared for param, always number for loop)
}

type Bindings = Map<string, BindingInfo>;

class Compiler {
  private functions = new Map<string, FunctionDef>();
  private functionSignatures = new Map<string, Array<{ name: string; label: string | null }>>();
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
          stmt.params.map(p => ({ name: p.name, label: p.label })),
        );
        this.functionReturnTypes.set(stmt.name, stmt.returnType);
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

  private compileSet(
    stmt: SetStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    if (bindings.has(stmt.name)) {
      throw new CompileError(`Duplicate binding: '${stmt.name}' is already set`);
    }
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE', name: stmt.name });
    bindings.set(stmt.name, { kind: 'set', type: this.staticType(stmt.value, bindings) ?? undefined });
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
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE_VAR', name: stmt.name });
    bindings.set(stmt.name, {
      kind: 'var',
      type: this.staticType(stmt.value, bindings) ?? undefined,
    });
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
    this.compileExpr(stmt.value, out, bindings);
    out.push({ op: 'STORE_VAR', name: stmt.name });
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
    if (info.type !== undefined && info.type !== 'number') {
      throw new CompileError(
        `Cannot ${stmt.op} '${stmt.name}': its type is ${info.type}, not number`,
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
          `missing return in typed function '${stmt.name}'; every path must return a ${stmt.returnType}`,
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
        type: (p.paramType === 'number' || p.paramType === 'string' || p.paramType === 'boolean')
          ? p.paramType as ChatterType
          : undefined,
      });
    }
    const prevReturnType = this.currentFuncReturnType;
    const prevFuncName = this.currentFuncName;
    this.currentFuncReturnType = stmt.returnType;
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
    // Typed functions: no implicit return — path analysis guarantees every path returns.
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
          // Find the first unbound param whose label matches this argument name.
          // (Duplicate labels bind in declaration order.)
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
        this.compileExpr(bound[i]!, out, bindings);
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

      bindings.set(loopVar, { kind: 'loop', type: 'number' });
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
      // Emit implicit-0 + RETURN so the call site (which will DROP) sees a value.
      out.push({ op: 'PUSH_INT', value: 0 });
      out.push({ op: 'RETURN' });
      return;
    }
    // Typed function
    if (stmt.value === null) {
      throw new CompileError(
        `typed function '${this.currentFuncName}' must return a ${rt}`,
      );
    }
    const st = this.staticType(stmt.value, bindings);
    if (st !== null && st !== rt) {
      throw new CompileError(
        `Type mismatch: function '${this.currentFuncName}' declared to return ${rt}, but return expression has type ${st}`,
      );
    }
    this.compileExpr(stmt.value, out, bindings);
    if (st === null) {
      // Static type unknown — emit runtime check.
      out.push({
        op: 'CHECK_TYPE',
        expected: rt,
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
    }
  }

  private compileBinary(
    expr: BinaryExpression,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    this.compileExpr(expr.left, out, bindings);
    this.compileExpr(expr.right, out, bindings);
    switch (expr.operator) {
      case '+':  out.push({ op: 'ADD' }); break;
      case '-':  out.push({ op: 'SUB' }); break;
      case '*':  out.push({ op: 'MUL' }); break;
      case '/':  out.push({ op: 'DIV' }); break;
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

  // Best-effort static type inference for literals and trivial expressions.
  // Returns null if the type is not trivially knowable.
  private staticType(expr: Expression, bindings: Bindings): ChatterType | null {
    switch (expr.type) {
      case 'NumberLiteral': return 'number';
      case 'StringLiteral': return 'string';
      case 'BooleanLiteral': return 'boolean';
      case 'UnaryExpression': return 'boolean';
      case 'BinaryExpression': {
        const op = expr.operator;
        if (op === '+' || op === '-' || op === '*' || op === '/' || op === '**') return 'number';
        return 'boolean';
      }
      case 'IdentifierExpression': {
        const info = bindings.get(expr.name);
        return info?.type ?? null;
      }
      case 'CallStatement': {
        const rt = this.functionReturnTypes.get(expr.name);
        return rt ?? null;  // undefined (unknown fn) or null (void) → null
      }
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
  // repeat bodies may run zero times → never terminating
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
