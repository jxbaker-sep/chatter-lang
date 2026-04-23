import { Instruction, BytecodeProgram } from './bytecode';

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export interface ChatterList {
  kind: 'list';
  element: 'number' | 'string' | 'boolean';
  items: ChatterValue[];
}

export type ChatterValue = number | string | boolean | ChatterList;

function isList(v: ChatterValue): v is ChatterList {
  return typeof v === 'object' && v !== null && (v as any).kind === 'list';
}

function describe(v: ChatterValue): string {
  if (isList(v)) return `list of ${v.element}`;
  return typeof v;
}

function formatScalar(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return v;
}

function formatValue(v: ChatterValue): string {
  if (isList(v)) {
    return '[' + v.items.map(e => {
      if (isList(e)) return formatValue(e);
      if (typeof e === 'string') return `"${e}"`;
      return formatScalar(e);
    }).join(', ') + ']';
  }
  return formatScalar(v);
}

function stringify(v: ChatterValue): string {
  return formatValue(v);
}

interface Frame {
  instructions: Instruction[];
  ip: number;
  locals: Map<string, ChatterValue>;
  varTypes: Map<string, 'number' | 'string' | 'boolean' | string>;
  it: ChatterValue | null;
}

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

export class VM {
  private stack: ChatterValue[] = [];
  private callStack: Frame[] = [];

  constructor(private program: BytecodeProgram) {}

  run(): void {
    const mainFrame: Frame = {
      instructions: this.program.main,
      ip: 0,
      locals: new Map(),
      varTypes: new Map(),
      it: null,
    };
    this.callStack.push(mainFrame);
    this.executeFrame();
    this.callStack.pop();
  }

  private executeFrame(): void {
    const frame = this.callStack[this.callStack.length - 1];
    while (frame.ip < frame.instructions.length) {
      const instr = frame.instructions[frame.ip++];
      if (instr.op === 'RETURN') {
        // Return value is already on the stack from the expression before RETURN.
        return;
      }
      this.executeInstr(instr);
    }
  }

  private executeInstr(instr: Instruction): void {
    const frame = this.callStack[this.callStack.length - 1];

    switch (instr.op) {
      case 'PUSH_INT':
        this.stack.push(instr.value);
        break;

      case 'PUSH_STR':
        this.stack.push(instr.value);
        break;

      case 'PUSH_BOOL':
        this.stack.push(instr.value);
        break;

      case 'LOAD': {
        // Search current frame first, then walk up the call stack.
        for (let i = this.callStack.length - 1; i >= 0; i--) {
          if (this.callStack[i].locals.has(instr.name)) {
            this.stack.push(this.callStack[i].locals.get(instr.name)!);
            return;
          }
        }
        throw new RuntimeError(`Undefined variable: '${instr.name}'`);
      }

      case 'STORE': {
        frame.locals.set(instr.name, this.pop());
        break;
      }

      case 'STORE_VAR': {
        const val = this.pop();
        const valType = isList(val) ? `list:${val.element}` : (typeof val as string);
        const existing = frame.varTypes.get(instr.name);
        if (existing === undefined) {
          frame.varTypes.set(instr.name, valType);
        } else if (existing !== valType) {
          throw new RuntimeError(
            `Type mismatch: cannot change '${instr.name}' (expected ${existing}, got ${valType})`,
          );
        }
        frame.locals.set(instr.name, val);
        break;
      }

      case 'DELETE': {
        frame.locals.delete(instr.name);
        break;
      }

      case 'LOAD_IT': {
        if (frame.it === null) {
          throw new RuntimeError("'it' is not set in current scope");
        }
        this.stack.push(frame.it);
        break;
      }

      case 'STORE_IT': {
        frame.it = this.pop();
        break;
      }

      case 'ADD':
      case 'SUB':
      case 'MUL':
      case 'DIV':
      case 'MOD':
      case 'POW': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new RuntimeError(
            `Type mismatch: arithmetic requires numbers, got ${typeof a} and ${typeof b}`,
          );
        }
        if ((instr.op === 'DIV' || instr.op === 'MOD') && b === 0) {
          throw new RuntimeError(instr.op === 'MOD' ? 'Modulo by zero' : 'Division by zero');
        }
        let result: number;
        switch (instr.op) {
          case 'ADD': result = a + b; break;
          case 'SUB': result = a - b; break;
          case 'MUL': result = a * b; break;
          case 'DIV': result = Math.trunc(a / b); break;
          case 'MOD': result = a - Math.trunc(a / b) * b; break;
          case 'POW': result = Math.pow(a, b); break;
        }
        if (result < I32_MIN || result > I32_MAX) {
          throw new RuntimeError(`Integer overflow: result ${result} exceeds i32 range`);
        }
        this.stack.push(result);
        break;
      }

      case 'CALL': {
        const funcDef = this.program.functions.get(instr.name);
        if (!funcDef) {
          throw new RuntimeError(`Undefined function: '${instr.name}'`);
        }
        // Pop args in reverse order so args[0] corresponds to params[0].
        const args: ChatterValue[] = new Array(instr.argCount);
        for (let i = instr.argCount - 1; i >= 0; i--) {
          args[i] = this.pop();
        }
        const locals = new Map<string, ChatterValue>();
        for (let i = 0; i < funcDef.params.length; i++) {
          locals.set(funcDef.params[i], args[i]);
        }
        const newFrame: Frame = {
          instructions: funcDef.instructions,
          ip: 0,
          locals,
          varTypes: new Map(),
          it: null,
        };
        this.callStack.push(newFrame);
        this.executeFrame();
        this.callStack.pop();
        // The return value was left on the stack by RETURN's expression.
        break;
      }

      case 'SAY': {
        const val = this.pop();
        if (val === undefined) {
          throw new RuntimeError('Stack underflow in SAY');
        }
        console.log(formatValue(val));
        break;
      }

      case 'EQ': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== typeof b) {
          throw new RuntimeError(
            `Type mismatch: cannot compare ${typeof a} and ${typeof b}`,
          );
        }
        this.stack.push(a === b);
        break;
      }

      case 'NEQ': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== typeof b) {
          throw new RuntimeError(
            `Type mismatch: cannot compare ${typeof a} and ${typeof b}`,
          );
        }
        this.stack.push(a !== b);
        break;
      }

      case 'LT':
      case 'LE':
      case 'GT':
      case 'GE': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new RuntimeError('Type mismatch: comparison requires numbers');
        }
        let r: boolean;
        switch (instr.op) {
          case 'LT': r = a < b; break;
          case 'LE': r = a <= b; break;
          case 'GT': r = a > b; break;
          case 'GE': r = a >= b; break;
        }
        this.stack.push(r);
        break;
      }

      case 'ERROR':
        throw new RuntimeError(instr.message);

      case 'DROP': {
        this.pop();
        break;
      }

      case 'CHECK_TYPE': {
        if (this.stack.length === 0) {
          throw new RuntimeError('Stack underflow in CHECK_TYPE');
        }
        const top = this.stack[this.stack.length - 1];
        const actual = typeof top as 'number' | 'string' | 'boolean';
        if (actual !== instr.expected) {
          throw new RuntimeError(
            `Type mismatch: ${instr.context} (expected ${instr.expected}, got ${actual})`,
          );
        }
        break;
      }

      case 'NOT': {
        const a = this.pop();
        if (typeof a !== 'boolean') {
          throw new RuntimeError(`Type mismatch: 'not' requires a boolean, got ${typeof a}`);
        }
        this.stack.push(!a);
        break;
      }

      case 'AND': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'boolean' || typeof b !== 'boolean') {
          throw new RuntimeError(
            `Type mismatch: 'and' requires booleans, got ${typeof a} and ${typeof b}`,
          );
        }
        this.stack.push(a && b);
        break;
      }

      case 'OR': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'boolean' || typeof b !== 'boolean') {
          throw new RuntimeError(
            `Type mismatch: 'or' requires booleans, got ${typeof a} and ${typeof b}`,
          );
        }
        this.stack.push(a || b);
        break;
      }

      case 'JUMP': {
        frame.ip = instr.target;
        break;
      }

      case 'JUMP_IF_FALSE': {
        const v = this.pop();
        if (typeof v !== 'boolean') {
          throw new RuntimeError(`condition must be a boolean, got ${typeof v}`);
        }
        if (!v) {
          frame.ip = instr.target;
        }
        break;
      }

      case 'RETURN':
        // Handled in executeFrame; this branch is unreachable.
        break;

      case 'MAKE_LIST': {
        const elems: ChatterValue[] = new Array(instr.count);
        for (let i = instr.count - 1; i >= 0; i--) {
          elems[i] = this.pop();
        }
        if (instr.count === 0) {
          throw new RuntimeError('MAKE_LIST with zero elements (use MAKE_EMPTY_LIST)');
        }
        let elementType: 'number' | 'string' | 'boolean';
        if (instr.elementType !== null) {
          elementType = instr.elementType;
        } else {
          const first = elems[0];
          if (isList(first)) {
            throw new RuntimeError('nested lists not supported');
          }
          elementType = typeof first as 'number' | 'string' | 'boolean';
        }
        for (let i = 0; i < elems.length; i++) {
          const e = elems[i];
          if (isList(e) || typeof e !== elementType) {
            throw new RuntimeError(
              `Type mismatch: list element ${i + 1} has type ${describe(e)}, expected ${elementType}`,
            );
          }
        }
        const list: ChatterList = { kind: 'list', element: elementType, items: elems };
        this.stack.push(list);
        break;
      }

      case 'MAKE_EMPTY_LIST': {
        const list: ChatterList = { kind: 'list', element: instr.elementType, items: [] };
        this.stack.push(list);
        break;
      }

      case 'LIST_GET': {
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'item N of X' requires a list, got ${describe(list)}`);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: list index must be a number, got ${typeof idx}`);
        }
        if (idx < 1 || idx > list.items.length) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${list.items.length} items)`);
        }
        this.stack.push(list.items[idx - 1]);
        break;
      }

      case 'LIST_SET': {
        const value = this.pop();
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'change item N of X' requires a list, got ${describe(list)}`);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: list index must be a number, got ${typeof idx}`);
        }
        if (idx < 1 || idx > list.items.length) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${list.items.length} items)`);
        }
        if (isList(value) || typeof value !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot assign ${describe(value)} to list of ${list.element}`,
          );
        }
        list.items[idx - 1] = value;
        break;
      }

      case 'LENGTH': {
        const v = this.pop();
        if (isList(v)) {
          this.stack.push(v.items.length);
          break;
        }
        if (typeof v === 'string') {
          this.stack.push(v.length);
          break;
        }
        throw new RuntimeError(`Type mismatch: 'length of X' requires a list or string, got ${describe(v)}`);
      }

      case 'CONTAINS': {
        const value = this.pop();
        const left = this.pop();
        if (typeof left === 'string') {
          if (typeof value !== 'string') {
            throw new RuntimeError(
              `Type mismatch: 'contains' on string requires a string on the right, got ${describe(value)}`,
            );
          }
          this.stack.push(left.includes(value));
          break;
        }
        if (!isList(left)) {
          throw new RuntimeError(`Type mismatch: 'contains' requires a list or string on the left, got ${describe(left)}`);
        }
        if (isList(value) || typeof value !== left.element) {
          throw new RuntimeError(
            `Type mismatch: 'contains' value type ${describe(value)} does not match list element type ${left.element}`,
          );
        }
        let found = false;
        for (const e of left.items) {
          if (e === value) { found = true; break; }
        }
        this.stack.push(found);
        break;
      }

      case 'CONCAT': {
        const b = this.pop();
        const a = this.pop();
        this.stack.push(stringify(a) + stringify(b));
        break;
      }

      case 'STR_CHAR_AT': {
        const idx = this.pop();
        const s = this.pop();
        if (typeof s !== 'string') {
          throw new RuntimeError(`Type mismatch: 'character N of X' requires a string, got ${describe(s)}`);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: character index must be a number, got ${typeof idx}`);
        }
        if (idx < 1 || idx > s.length) {
          throw new RuntimeError(`Index out of range: character ${idx} of string (length ${s.length})`);
        }
        this.stack.push(s.charAt(idx - 1));
        break;
      }

      case 'STR_SUBSTRING': {
        const to = this.pop();
        const from = this.pop();
        const s = this.pop();
        if (typeof s !== 'string') {
          throw new RuntimeError(`Type mismatch: 'characters A to B of X' requires a string, got ${describe(s)}`);
        }
        if (typeof from !== 'number' || typeof to !== 'number') {
          throw new RuntimeError(`Type mismatch: substring bounds must be numbers`);
        }
        if (from > to) {
          this.stack.push('');
          break;
        }
        if (from < 1 || to > s.length) {
          throw new RuntimeError(
            `Index out of range: characters ${from} to ${to} of string (length ${s.length})`,
          );
        }
        this.stack.push(s.substring(from - 1, to));
        break;
      }

      case 'LIST_APPEND': {
        const value = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'append' target must be a list, got ${describe(list)}`);
        }
        if (isList(value) || typeof value !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot append ${describe(value)} to list of ${list.element}`,
          );
        }
        list.items.push(value);
        break;
      }

      case 'LIST_PREPEND': {
        const value = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'prepend' target must be a list, got ${describe(list)}`);
        }
        if (isList(value) || typeof value !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot prepend ${describe(value)} to list of ${list.element}`,
          );
        }
        list.items.unshift(value);
        break;
      }

      case 'LIST_INSERT': {
        const value = this.pop();
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'insert' target must be a list, got ${describe(list)}`);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: insert position must be a number, got ${typeof idx}`);
        }
        if (idx < 1 || idx > list.items.length + 1) {
          throw new RuntimeError(`List insert position out of range: ${idx} (list has ${list.items.length} items)`);
        }
        if (isList(value) || typeof value !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot insert ${describe(value)} into list of ${list.element}`,
          );
        }
        list.items.splice(idx - 1, 0, value);
        break;
      }

      case 'LIST_REMOVE': {
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'remove' target must be a list, got ${describe(list)}`);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: remove position must be a number, got ${typeof idx}`);
        }
        if (idx < 1 || idx > list.items.length) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${list.items.length} items)`);
        }
        list.items.splice(idx - 1, 1);
        break;
      }
    }
  }

  private pop(): ChatterValue {
    if (this.stack.length === 0) {
      throw new RuntimeError('Stack underflow');
    }
    return this.stack.pop()!;
  }
}
