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
  private functionSignatures = new Map<string, string[]>();
  private outerBindings = new Set<string>();
  private topLevelBindings: Bindings | null = null;
  private tempCounter = 0;

  private freshName(tag: string): string {
    return `_rep_${tag}_${this.tempCounter++}`;
  }

  compile(program: Program): BytecodeProgram {
    // First pass: collect function signatures and outer bindings
    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration') {
        this.functionSignatures.set(stmt.name, stmt.params.map(p => p.name));
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
      case 'CallStatement':
        this.compileCallStmt(stmt, out, bindings);
        out.push({ op: 'STORE_IT' });
        break;
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
    for (const bodyStmt of stmt.body) {
      this.compileStatement(bodyStmt, instructions, funcBindings);
    }
  }

  private compileCallStmt(
    stmt: CallStatement,
    out: Instruction[],
    bindings: Bindings,
  ): void {
    const params = this.functionSignatures.get(stmt.name);

    if (params !== undefined) {
      const argMap = new Map<string, Expression>();
      for (const arg of stmt.args) {
        if (arg.name === null) {
          if (params.length > 0) {
            argMap.set(params[0], arg.value);
          }
        } else {
          argMap.set(arg.name, arg.value);
        }
      }

      for (const param of params) {
        const val = argMap.get(param);
        if (val === undefined) {
          throw new CompileError(
            `Missing argument for parameter '${param}' in call to '${stmt.name}'`,
          );
        }
        this.compileExpr(val, out, bindings);
      }

      out.push({ op: 'CALL', name: stmt.name, argCount: params.length });
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
    this.compileExpr(stmt.value, out, bindings);
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
      case 'CallStatement':
        this.compileCallStmt(expr, out, bindings);
        break;
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
      default:
        return null;
    }
  }
}

export function compile(program: Program): BytecodeProgram {
  return new Compiler().compile(program);
}
