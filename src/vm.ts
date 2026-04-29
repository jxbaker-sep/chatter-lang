import { Instruction, BytecodeProgram } from './bytecode';
import * as fs from 'fs';
import { ChatterError, SourceLocation } from './errors';

export class RuntimeError extends ChatterError {
  constructor(message: string, location?: SourceLocation) {
    super(message, location);
    this.name = 'RuntimeError';
  }
}

export interface ChatterList {
  kind: 'list';
  element: string;  // 'number'|'string'|'boolean'|'struct:<mangled>'
  items: ChatterValue[];
}

export interface ChatterUniqueList {
  kind: 'uniqueList';
  element: string;  // same encoding as ChatterList.element
  items: Map<string, ChatterValue>;  // key = canonicalKey(value); insertion order preserved
  _iterCache?: ChatterValue[];       // materialized values; invalidated on mutation
}

export interface ChatterStruct {
  kind: 'struct';
  typeName: string;             // mangled
  fields: Map<string, ChatterValue>;  // insertion order = declaration order
}

export interface ChatterDict {
  kind: 'dict';
  keyType: string;              // 'number'|'string'|'boolean'|'struct:<mangled>'
  valueType: string;            // same encoding
  items: Map<string, { key: ChatterValue; value: ChatterValue }>;  // canonicalKey -> entry
}

export type ChatterValue = number | string | boolean | ChatterList | ChatterUniqueList | ChatterStruct | ChatterDict;

function isList(v: ChatterValue): v is ChatterList {
  return typeof v === 'object' && v !== null && (v as any).kind === 'list';
}

function isUniqueList(v: ChatterValue): v is ChatterUniqueList {
  return typeof v === 'object' && v !== null && (v as any).kind === 'uniqueList';
}

function isStruct(v: ChatterValue): v is ChatterStruct {
  return typeof v === 'object' && v !== null && (v as any).kind === 'struct';
}

function isDict(v: ChatterValue): v is ChatterDict {
  return typeof v === 'object' && v !== null && (v as any).kind === 'dict';
}

function isAnyList(v: ChatterValue): v is ChatterList | ChatterUniqueList {
  return isList(v) || isUniqueList(v);
}

// Canonical string key for hashing scalar/struct values into a unique-list backing Map.
// Recursive for structs (matches structural equality used by EQ).
// Strings are escaped so that `"a|b"` and `"a","b"` cannot collide.
function canonicalKey(v: ChatterValue): string {
  if (typeof v === 'number') return 'n:' + v;
  if (typeof v === 'string') return 's:' + v.length + ':' + v;
  if (typeof v === 'boolean') return v ? 'b:1' : 'b:0';
  if (isStruct(v)) {
    const parts: string[] = [];
    for (const [fname, fval] of v.fields) parts.push(fname + '=' + canonicalKey(fval));
    return 'S:' + v.typeName + '{' + parts.join(',') + '}';
  }
  // Lists are forbidden as elements; this branch should never be reached.
  return 'L?';
}

// Return the values of a unique list as an indexed array, populating a lazy cache.
function uniqueListValues(u: ChatterUniqueList): ChatterValue[] {
  if (u._iterCache === undefined) u._iterCache = Array.from(u.items.values());
  return u._iterCache;
}

// Invalidate the iteration cache after any mutation.
function invalidateUniqueListCache(u: ChatterUniqueList): void {
  u._iterCache = undefined;
}

// Strip module prefix `mN::Name` → `Name` for user-facing display.
function unmangleStructName(mangled: string): string {
  const idx = mangled.indexOf('::');
  return idx === -1 ? mangled : mangled.slice(idx + 2);
}

// Encode the element-type code for a value (used for list/unique-list element checks).
function valueElementCode(v: ChatterValue): string | null {
  if (isStruct(v)) return 'struct:' + v.typeName;
  if (isAnyList(v)) return null;  // lists never appear as elements (nested lists rejected)
  if (isDict(v)) return null;     // dicts never appear as elements
  return typeof v as string;
}

function elementCodeToHuman(code: string): string {
  if (code.startsWith('struct:')) return 'struct ' + unmangleStructName(code.slice(7));
  return code;
}

function describe(v: ChatterValue): string {
  if (isStruct(v)) return 'struct ' + unmangleStructName(v.typeName);
  if (isUniqueList(v)) return 'unique list of ' + elementCodeToHuman(v.element);
  if (isList(v)) return 'list of ' + elementCodeToHuman(v.element);
  if (isDict(v)) return 'dictionary from ' + elementCodeToHuman(v.keyType) + ' to ' + elementCodeToHuman(v.valueType);
  return typeof v;
}

// Return the single Unicode code point if `s` contains exactly one code point;
// otherwise null. Handles 4-byte code points (surrogate pairs) correctly.
function singleCodePoint(s: string): number | null {
  if (s.length === 0) return null;
  const cp = s.codePointAt(0)!;
  const width = cp > 0xFFFF ? 2 : 1;
  if (s.length !== width) return null;
  return cp;
}

function formatScalar(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return v;
}

function formatValue(v: ChatterValue): string {
  if (isStruct(v)) {
    const tname = unmangleStructName(v.typeName);
    const parts: string[] = [];
    for (const [fname, fval] of v.fields) {
      const formatted = typeof fval === 'string'
        ? `"${fval}"`
        : formatValue(fval);
      parts.push(`${fname}: ${formatted}`);
    }
    return `${tname}(${parts.join(', ')})`;
  }
  if (isUniqueList(v)) {
    return '[' + uniqueListValues(v).map(e => {
      if (isAnyList(e) || isDict(e)) return formatValue(e);
      if (isStruct(e)) return formatValue(e);
      if (typeof e === 'string') return `"${e}"`;
      return formatScalar(e);
    }).join(', ') + ']';
  }
  if (isList(v)) {
    return '[' + v.items.map(e => {
      if (isAnyList(e) || isDict(e)) return formatValue(e);
      if (isStruct(e)) return formatValue(e);
      if (typeof e === 'string') return `"${e}"`;
      return formatScalar(e);
    }).join(', ') + ']';
  }
  if (isDict(v)) {
    if (v.items.size === 0) {
      return 'empty dictionary from ' + elementCodeToHuman(v.keyType) + ' to ' + elementCodeToHuman(v.valueType);
    }
    const fmt = (e: ChatterValue): string => {
      if (isAnyList(e) || isStruct(e) || isDict(e)) return formatValue(e);
      if (typeof e === 'string') return `"${e}"`;
      return formatScalar(e);
    };
    const parts: string[] = [];
    for (const entry of v.items.values()) {
      parts.push(fmt(entry.key) + ' to ' + fmt(entry.value));
    }
    return 'dictionary ' + parts.join(', ');
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

const INT_MIN = Number.MIN_SAFE_INTEGER;
const INT_MAX = Number.MAX_SAFE_INTEGER;

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
        // Lexical scoping: check current frame, then the top-level (frame 0).
        // Intermediate caller frames are NOT consulted.
        const top = this.callStack[this.callStack.length - 1];
        if (top.locals.has(instr.name)) {
          this.stack.push(top.locals.get(instr.name)!);
          return;
        }
        if (this.callStack.length > 1 && this.callStack[0].locals.has(instr.name)) {
          this.stack.push(this.callStack[0].locals.get(instr.name)!);
          return;
        }
        throw new RuntimeError(`Undefined variable: '${instr.name}'`, instr.loc);
      }

      case 'STORE': {
        frame.locals.set(instr.name, this.pop());
        break;
      }

      case 'STORE_VAR': {
        const val = this.pop();
        let valType: string;
        if (isStruct(val)) valType = 'struct:' + val.typeName;
        else if (isUniqueList(val)) valType = `uniqueList:${val.element}`;
        else if (isList(val)) valType = `list:${val.element}`;
        else if (isDict(val)) valType = `dict:${val.keyType}:${val.valueType}`;
        else valType = typeof val as string;
        const existing = frame.varTypes.get(instr.name);
        if (existing === undefined) {
          frame.varTypes.set(instr.name, valType);
        } else if (existing !== valType) {
          throw new RuntimeError(
            `Type mismatch: cannot change '${instr.name}' (expected ${existing}, got ${valType})`,
          instr.loc);
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
          throw new RuntimeError("'it' is not set in current scope", instr.loc);
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
          instr.loc);
        }
        if ((instr.op === 'DIV' || instr.op === 'MOD') && b === 0) {
          throw new RuntimeError(instr.op === 'MOD' ? 'Modulo by zero' : 'Division by zero', instr.loc);
        }
        let result: number;
        switch (instr.op) {
          case 'ADD': result = a + b; break;
          case 'SUB': result = a - b; break;
          case 'MUL': result = a * b; break;
          case 'DIV': result = Math.trunc(a / b); break;
          case 'MOD': result = a - Math.floor(a / b) * b; break;
          case 'POW': result = Math.pow(a, b); break;
        }
        if (result < INT_MIN || result > INT_MAX) {
          throw new RuntimeError(`Integer overflow: result ${result} exceeds safe integer range`, instr.loc);
        }
        this.stack.push(result);
        break;
      }

      case 'CALL': {
        const funcDef = this.program.functions.get(instr.name);
        if (!funcDef) {
          throw new RuntimeError(`Undefined function: '${instr.name}'`, instr.loc);
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
          throw new RuntimeError('Stack underflow in SAY', instr.loc);
        }
        console.log(formatValue(val));
        break;
      }

      case 'SAY_MULTI': {
        const count = instr.count;
        const vals: ChatterValue[] = new Array(count);
        for (let i = count - 1; i >= 0; i--) {
          const v = this.pop();
          if (v === undefined) {
            throw new RuntimeError('Stack underflow in SAY_MULTI', instr.loc);
          }
          vals[i] = v;
        }
        console.log(vals.map(formatValue).join(' '));
        break;
      }

      case 'EQ':
      case 'NEQ': {
        const b = this.pop();
        const a = this.pop();
        const result = this.aggregateEquals(a, b, instr.loc);
        this.stack.push(instr.op === 'EQ' ? result : !result);
        break;
      }

      case 'LT':
      case 'LE':
      case 'GT':
      case 'GE': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new RuntimeError('Type mismatch: comparison requires numbers', instr.loc);
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
        throw new RuntimeError(instr.message, instr.loc);

      case 'EXPECT': {
        const v = this.pop();
        if (typeof v !== 'boolean') {
          throw new RuntimeError(`expect requires a boolean, got ${describe(v)}`, instr.loc);
        }
        if (!v) {
          throw new RuntimeError(`expect failed: ${instr.source}`, instr.loc);
        }
        break;
      }

      case 'EXPECT_BOOL_CHECK': {
        if (this.stack.length === 0) {
          throw new RuntimeError('Stack underflow in EXPECT_BOOL_CHECK', instr.loc);
        }
        const v = this.stack[this.stack.length - 1];
        if (typeof v !== 'boolean') {
          throw new RuntimeError(`expect requires a boolean, got ${describe(v)}`, instr.loc);
        }
        break;
      }

      case 'EXPECT_FAIL_WITH_MSG': {
        const m = this.pop();
        if (typeof m !== 'string') {
          throw new RuntimeError(`expect message must be a string, got ${describe(m)}`, instr.loc);
        }
        throw new RuntimeError(`expect failed: ${m}`, instr.loc);
      }

      case 'DROP': {
        this.pop();
        break;
      }

      case 'CHECK_TYPE': {
        if (this.stack.length === 0) {
          throw new RuntimeError('Stack underflow in CHECK_TYPE', instr.loc);
        }
        const top = this.stack[this.stack.length - 1];
        const actual = typeof top as 'number' | 'string' | 'boolean';
        if (actual !== instr.expected) {
          throw new RuntimeError(
            `Type mismatch: ${instr.context} (expected ${instr.expected}, got ${actual})`,
          instr.loc);
        }
        break;
      }

      case 'NOT': {
        const a = this.pop();
        if (typeof a !== 'boolean') {
          throw new RuntimeError(`Type mismatch: 'not' requires a boolean, got ${typeof a}`, instr.loc);
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
          instr.loc);
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
          instr.loc);
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
          throw new RuntimeError(`condition must be a boolean, got ${typeof v}`, instr.loc);
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
          throw new RuntimeError('MAKE_LIST with zero elements (use MAKE_EMPTY_LIST)', instr.loc);
        }
        let elementType: string;
        if (instr.elementType !== null) {
          elementType = instr.elementType;
        } else {
          const first = elems[0];
          if (isAnyList(first)) {
            throw new RuntimeError('nested lists not supported', instr.loc);
          }
          const code = valueElementCode(first);
          if (code === null) {
            throw new RuntimeError('nested lists not supported', instr.loc);
          }
          elementType = code;
        }
        for (let i = 0; i < elems.length; i++) {
          const e = elems[i];
          if (isAnyList(e) || valueElementCode(e) !== elementType) {
            throw new RuntimeError(
              `Type mismatch: list element ${i + 1} has type ${describe(e)}, expected ${elementCodeToHuman(elementType)}`,
            instr.loc);
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

      case 'MAKE_UNIQUE_LIST': {
        const elems: ChatterValue[] = new Array(instr.count);
        for (let i = instr.count - 1; i >= 0; i--) {
          elems[i] = this.pop();
        }
        if (instr.count === 0) {
          throw new RuntimeError('MAKE_UNIQUE_LIST with zero elements (use MAKE_EMPTY_UNIQUE_LIST)', instr.loc);
        }
        let elementType: string;
        if (instr.elementType !== null) {
          elementType = instr.elementType;
        } else {
          const first = elems[0];
          if (isAnyList(first)) {
            throw new RuntimeError('nested lists not supported', instr.loc);
          }
          const code = valueElementCode(first);
          if (code === null) {
            throw new RuntimeError('nested lists not supported', instr.loc);
          }
          elementType = code;
        }
        for (let i = 0; i < elems.length; i++) {
          const e = elems[i];
          if (isAnyList(e) || valueElementCode(e) !== elementType) {
            throw new RuntimeError(
              `Type mismatch: unique list element ${i + 1} has type ${describe(e)}, expected ${elementCodeToHuman(elementType)}`,
            instr.loc);
          }
        }
        // Dedupe via canonical key — Map preserves insertion order naturally.
        const items = new Map<string, ChatterValue>();
        for (const e of elems) {
          const k = canonicalKey(e);
          if (!items.has(k)) items.set(k, e);
        }
        const uList: ChatterUniqueList = { kind: 'uniqueList', element: elementType, items };
        this.stack.push(uList);
        break;
      }

      case 'MAKE_EMPTY_UNIQUE_LIST': {
        const uList: ChatterUniqueList = { kind: 'uniqueList', element: instr.elementType, items: new Map() };
        this.stack.push(uList);
        break;
      }

      case 'UNIQUE_LIST_ADD': {
        const value = this.pop();
        const list = this.pop();
        if (!isUniqueList(list)) {
          throw new RuntimeError(`Type mismatch: 'add' target must be a unique list, got ${describe(list)}`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot add ${describe(value)} to unique list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        const k = canonicalKey(value);
        if (!list.items.has(k)) {
          list.items.set(k, value);
          invalidateUniqueListCache(list);
        }
        break;
      }

      case 'UNIQUE_LIST_REMOVE': {
        const value = this.pop();
        const list = this.pop();
        if (!isUniqueList(list)) {
          throw new RuntimeError(`Type mismatch: 'remove' target must be a unique list, got ${describe(list)}`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot remove ${describe(value)} from unique list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        if (list.items.delete(canonicalKey(value))) {
          invalidateUniqueListCache(list);
        }
        break;
      }

      case 'LIST_GET': {
        const idx = this.pop();
        const list = this.pop();
        if (!isAnyList(list)) {
          throw new RuntimeError(`Type mismatch: 'item N of X' requires a list, got ${describe(list)}`, instr.loc);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: list index must be a number, got ${typeof idx}`, instr.loc);
        }
        const len = isUniqueList(list) ? list.items.size : list.items.length;
        if (idx < 1 || idx > len) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${len} items)`, instr.loc);
        }
        const arr = isUniqueList(list) ? uniqueListValues(list) : list.items;
        this.stack.push(arr[idx - 1]);
        break;
      }

      case 'LIST_SET': {
        const value = this.pop();
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'change item N of X' requires a list, got ${describe(list)}`, instr.loc);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: list index must be a number, got ${typeof idx}`, instr.loc);
        }
        if (idx < 1 || idx > list.items.length) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${list.items.length} items)`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot assign ${describe(value)} to list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        list.items[idx - 1] = value;
        break;
      }

      case 'LENGTH': {
        const v = this.pop();
        if (isUniqueList(v)) {
          this.stack.push(v.items.size);
          break;
        }
        if (isList(v)) {
          this.stack.push(v.items.length);
          break;
        }
        if (isDict(v)) {
          this.stack.push(v.items.size);
          break;
        }
        if (typeof v === 'string') {
          this.stack.push(v.length);
          break;
        }
        throw new RuntimeError(`Type mismatch: 'length of X' requires a list, dictionary, or string, got ${describe(v)}`, instr.loc);
      }

      case 'CONTAINS': {
        const value = this.pop();
        const left = this.pop();
        if (typeof left === 'string') {
          if (typeof value !== 'string') {
            throw new RuntimeError(
              `Type mismatch: 'contains' on string requires a string on the right, got ${describe(value)}`,
            instr.loc);
          }
          this.stack.push(left.includes(value));
          break;
        }
        if (isDict(left)) {
          if (isAnyList(value) || isDict(value) || valueElementCode(value) !== left.keyType) {
            throw new RuntimeError(
              `Type mismatch: 'contains' key type ${describe(value)} does not match dictionary key type ${elementCodeToHuman(left.keyType)}`,
            instr.loc);
          }
          this.stack.push(left.items.has(canonicalKey(value)));
          break;
        }
        if (!isAnyList(left)) {
          throw new RuntimeError(`Type mismatch: 'contains' requires a list, dictionary, or string on the left, got ${describe(left)}`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== left.element) {
          throw new RuntimeError(
            `Type mismatch: 'contains' value type ${describe(value)} does not match list element type ${elementCodeToHuman(left.element)}`,
          instr.loc);
        }
        if (isUniqueList(left)) {
          this.stack.push(left.items.has(canonicalKey(value)));
          break;
        }
        let found = false;
        for (const e of left.items) {
          if (this.aggregateEquals(e, value)) { found = true; break; }
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
          throw new RuntimeError(`Type mismatch: 'character N of X' requires a string, got ${describe(s)}`, instr.loc);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: character index must be a number, got ${typeof idx}`, instr.loc);
        }
        if (idx < 1 || idx > s.length) {
          throw new RuntimeError(`Index out of range: character ${idx} of string (length ${s.length})`, instr.loc);
        }
        this.stack.push(s.charAt(idx - 1));
        break;
      }

      case 'STR_SUBSTRING': {
        const to = this.pop();
        const from = this.pop();
        const s = this.pop();
        if (typeof s !== 'string') {
          throw new RuntimeError(`Type mismatch: 'characters A to B of X' requires a string, got ${describe(s)}`, instr.loc);
        }
        if (typeof from !== 'number' || typeof to !== 'number') {
          throw new RuntimeError(`Type mismatch: substring bounds must be numbers`, instr.loc);
        }
        if (from > to) {
          this.stack.push('');
          break;
        }
        if (from < 1 || to > s.length) {
          throw new RuntimeError(
            `Index out of range: characters ${from} to ${to} of string (length ${s.length})`,
          instr.loc);
        }
        this.stack.push(s.substring(from - 1, to));
        break;
      }

      case 'LIST_APPEND': {
        const value = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'append' target must be a list, got ${describe(list)}`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot append ${describe(value)} to list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        list.items.push(value);
        break;
      }

      case 'LIST_PREPEND': {
        const value = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'prepend' target must be a list, got ${describe(list)}`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot prepend ${describe(value)} to list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        list.items.unshift(value);
        break;
      }

      case 'LIST_INSERT': {
        const value = this.pop();
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'insert' target must be a list, got ${describe(list)}`, instr.loc);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: insert position must be a number, got ${typeof idx}`, instr.loc);
        }
        if (idx < 1 || idx > list.items.length + 1) {
          throw new RuntimeError(`List insert position out of range: ${idx} (list has ${list.items.length} items)`, instr.loc);
        }
        if (isAnyList(value) || valueElementCode(value) !== list.element) {
          throw new RuntimeError(
            `Type mismatch: cannot insert ${describe(value)} into list of ${elementCodeToHuman(list.element)}`,
          instr.loc);
        }
        list.items.splice(idx - 1, 0, value);
        break;
      }

      case 'LIST_REMOVE': {
        const idx = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'remove' target must be a list, got ${describe(list)}`, instr.loc);
        }
        if (typeof idx !== 'number') {
          throw new RuntimeError(`Type mismatch: remove position must be a number, got ${typeof idx}`, instr.loc);
        }
        if (idx < 1 || idx > list.items.length) {
          throw new RuntimeError(`List index out of range: ${idx} (list has ${list.items.length} items)`, instr.loc);
        }
        list.items.splice(idx - 1, 1);
        break;
      }

      case 'READ_FILE_LINES': {
        const path = this.pop();
        if (typeof path !== 'string') {
          throw new RuntimeError(`Type mismatch: file path must be a string, got ${typeof path}`, instr.loc);
        }
        let content: string;
        try {
          content = fs.readFileSync(path, 'utf8');
        } catch (err: any) {
          const reason = err && err.code ? err.code : (err && err.message ? err.message : String(err));
          throw new RuntimeError(`could not read file '${path}': ${reason}`, instr.loc);
        }
        // Split per spec: \r\n or \n is a separator; trailing newline does not
        // produce an empty string. Empty file -> empty list.
        if (content.endsWith('\r\n')) content = content.slice(0, -2);
        else if (content.endsWith('\n')) content = content.slice(0, -1);
        const items = content.length === 0 ? [] : content.split(/\r\n|\n/);
        const list: ChatterList = { kind: 'list', element: 'string', items };
        this.stack.push(list);
        break;
      }

      case 'CHAR_CODE': {
        const s = this.pop();
        if (typeof s !== 'string') {
          throw new RuntimeError(
            `Type mismatch: 'code of' requires a string, got ${describe(s)}`, instr.loc);
        }
        const cp = singleCodePoint(s);
        if (cp === null) {
          throw new RuntimeError(
            `code of requires a single character, got ${JSON.stringify(s)}`, instr.loc);
        }
        this.stack.push(cp);
        break;
      }

      case 'CHAR_FROM_CODE': {
        const n = this.pop();
        if (typeof n !== 'number') {
          throw new RuntimeError(
            `Type mismatch: 'character of' requires a number, got ${describe(n)}`, instr.loc);
        }
        if (!Number.isInteger(n)) {
          throw new RuntimeError(
            `character of requires an integer code point, got ${n}`, instr.loc);
        }
        if (n < 0 || n > 0x10FFFF) {
          throw new RuntimeError(
            `character of requires 0..0x10FFFF, got ${n}`, instr.loc);
        }
        if (n >= 0xD800 && n <= 0xDFFF) {
          throw new RuntimeError(
            `character of surrogate halves (0xD800..0xDFFF) are not valid code points, got ${n}`, instr.loc);
        }
        this.stack.push(String.fromCodePoint(n));
        break;
      }

      case 'IS_DIGIT':
      case 'IS_LETTER':
      case 'IS_WHITESPACE': {
        const s = this.pop();
        if (typeof s !== 'string') {
          const label = instr.op === 'IS_DIGIT' ? 'is a digit'
                      : instr.op === 'IS_LETTER' ? 'is a letter'
                      : 'is whitespace';
          throw new RuntimeError(
            `Type mismatch: '${label}' requires a string, got ${describe(s)}`, instr.loc);
        }
        const cp = singleCodePoint(s);
        if (cp === null) {
          const label = instr.op === 'IS_DIGIT' ? 'is a digit'
                      : instr.op === 'IS_LETTER' ? 'is a letter'
                      : 'is whitespace';
          throw new RuntimeError(
            `'${label}' requires a single character, got ${JSON.stringify(s)}`, instr.loc);
        }
        let result: boolean;
        if (instr.op === 'IS_DIGIT') {
          result = cp >= 0x30 && cp <= 0x39;
        } else if (instr.op === 'IS_LETTER') {
          result = (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A);
        } else {
          result = cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D;
        }
        this.stack.push(result);
        break;
      }

      case 'IS_EMPTY': {
        const v = this.pop();
        if (typeof v === 'string') {
          this.stack.push(v.length === 0);
          break;
        }
        if (isUniqueList(v)) {
          this.stack.push(v.items.size === 0);
          break;
        }
        if (isList(v)) {
          this.stack.push(v.items.length === 0);
          break;
        }
        if (isDict(v)) {
          this.stack.push(v.items.size === 0);
          break;
        }
        throw new RuntimeError(
          `Type mismatch: 'is empty' requires a string, list, or dictionary, got ${describe(v)}`, instr.loc);
      }

      case 'MAKE_DICT': {
        const entries: { key: ChatterValue; value: ChatterValue }[] = new Array(instr.count);
        for (let i = instr.count - 1; i >= 0; i--) {
          const value = this.pop();
          const key = this.pop();
          entries[i] = { key, value };
        }
        const items = new Map<string, { key: ChatterValue; value: ChatterValue }>();
        for (const e of entries) {
          if (isAnyList(e.key) || isDict(e.key) || valueElementCode(e.key) !== instr.keyType) {
            throw new RuntimeError(
              `Type mismatch: dictionary key has type ${describe(e.key)}, expected ${elementCodeToHuman(instr.keyType)}`,
            instr.loc);
          }
          if (isAnyList(e.value) || isDict(e.value) || valueElementCode(e.value) !== instr.valueType) {
            throw new RuntimeError(
              `Type mismatch: dictionary value has type ${describe(e.value)}, expected ${elementCodeToHuman(instr.valueType)}`,
            instr.loc);
          }
          items.set(canonicalKey(e.key), e);
        }
        const d: ChatterDict = { kind: 'dict', keyType: instr.keyType, valueType: instr.valueType, items };
        this.stack.push(d);
        break;
      }

      case 'MAKE_EMPTY_DICT': {
        const d: ChatterDict = { kind: 'dict', keyType: instr.keyType, valueType: instr.valueType, items: new Map() };
        this.stack.push(d);
        break;
      }

      case 'DICT_GET': {
        const key = this.pop();
        const dict = this.pop();
        if (!isDict(dict)) {
          throw new RuntimeError(`Type mismatch: 'value of K in X' requires a dictionary, got ${describe(dict)}`, instr.loc);
        }
        if (isAnyList(key) || isDict(key) || valueElementCode(key) !== dict.keyType) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${elementCodeToHuman(dict.keyType)}`,
          instr.loc);
        }
        const entry = dict.items.get(canonicalKey(key));
        if (entry === undefined) {
          throw new RuntimeError(`Key not found in dictionary`, instr.loc);
        }
        this.stack.push(entry.value);
        break;
      }

      case 'DICT_SET': {
        const value = this.pop();
        const key = this.pop();
        const dict = this.pop();
        if (!isDict(dict)) {
          throw new RuntimeError(`Type mismatch: 'change value of K in X' requires a dictionary, got ${describe(dict)}`, instr.loc);
        }
        if (isAnyList(key) || isDict(key) || valueElementCode(key) !== dict.keyType) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${elementCodeToHuman(dict.keyType)}`,
          instr.loc);
        }
        if (isAnyList(value) || isDict(value) || valueElementCode(value) !== dict.valueType) {
          throw new RuntimeError(
            `Type mismatch: dictionary value has type ${describe(value)}, expected ${elementCodeToHuman(dict.valueType)}`,
          instr.loc);
        }
        dict.items.set(canonicalKey(key), { key, value });
        break;
      }

      case 'DICT_REMOVE': {
        const key = this.pop();
        const dict = this.pop();
        if (!isDict(dict)) {
          throw new RuntimeError(`Type mismatch: 'remove K from X' requires a dictionary, got ${describe(dict)}`, instr.loc);
        }
        if (isAnyList(key) || isDict(key) || valueElementCode(key) !== dict.keyType) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${elementCodeToHuman(dict.keyType)}`,
          instr.loc);
        }
        dict.items.delete(canonicalKey(key));
        break;
      }

      case 'DICT_KEYS': {
        const dict = this.pop();
        if (!isDict(dict)) {
          throw new RuntimeError(`Type mismatch: 'keys of X' requires a dictionary, got ${describe(dict)}`, instr.loc);
        }
        const items = new Map<string, ChatterValue>();
        for (const [k, entry] of dict.items) {
          items.set(k, entry.key);
        }
        const u: ChatterUniqueList = { kind: 'uniqueList', element: dict.keyType, items };
        this.stack.push(u);
        break;
      }

      case 'DICT_VALUES': {
        const dict = this.pop();
        if (!isDict(dict)) {
          throw new RuntimeError(`Type mismatch: 'values of X' requires a dictionary, got ${describe(dict)}`, instr.loc);
        }
        const items: ChatterValue[] = [];
        for (const entry of dict.items.values()) {
          items.push(entry.value);
        }
        const l: ChatterList = { kind: 'list', element: dict.valueType, items };
        this.stack.push(l);
        break;
      }

      case 'MAKE_STRUCT': {
        const fields = new Map<string, ChatterValue>();
        const vals: ChatterValue[] = new Array(instr.fieldNames.length);
        for (let i = instr.fieldNames.length - 1; i >= 0; i--) {
          vals[i] = this.pop();
        }
        for (let i = 0; i < instr.fieldNames.length; i++) {
          fields.set(instr.fieldNames[i], vals[i]);
        }
        const s: ChatterStruct = { kind: 'struct', typeName: instr.typeName, fields };
        this.stack.push(s);
        break;
      }

      case 'STRUCT_GET': {
        const target = this.pop();
        if (!isStruct(target)) {
          throw new RuntimeError(
            `Type mismatch: '${instr.fieldName} of X' requires a struct, got ${describe(target)}`,
            instr.loc);
        }
        if (!target.fields.has(instr.fieldName)) {
          throw new RuntimeError(
            `struct ${unmangleStructName(target.typeName)} has no field '${instr.fieldName}'`,
            instr.loc);
        }
        this.stack.push(target.fields.get(instr.fieldName)!);
        break;
      }

      case 'STRUCT_WITH': {
        const overrides: ChatterValue[] = new Array(instr.fieldNames.length);
        for (let i = instr.fieldNames.length - 1; i >= 0; i--) {
          overrides[i] = this.pop();
        }
        const base = this.pop();
        if (!isStruct(base)) {
          throw new RuntimeError(
            `Type mismatch: 'X with FIELD V' requires a struct, got ${describe(base)}`,
            instr.loc);
        }
        for (const fn of instr.fieldNames) {
          if (!base.fields.has(fn)) {
            throw new RuntimeError(
              `struct ${unmangleStructName(base.typeName)} has no field '${fn}'`,
              instr.loc);
          }
        }
        const newFields = new Map<string, ChatterValue>(base.fields);
        for (let i = 0; i < instr.fieldNames.length; i++) {
          newFields.set(instr.fieldNames[i], overrides[i]);
        }
        const s: ChatterStruct = { kind: 'struct', typeName: base.typeName, fields: newFields };
        this.stack.push(s);
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

  private aggregateEquals(a: ChatterValue, b: ChatterValue, loc?: SourceLocation): boolean {
    // struct <-> struct: same type, every field equal (recursive).
    if (isStruct(a) && isStruct(b)) {
      if (a.typeName !== b.typeName) {
        throw new RuntimeError(
          `Type mismatch: cannot compare ${describe(a)} and ${describe(b)}`,
          loc,
        );
      }
      for (const [k, va] of a.fields) {
        const vb = b.fields.get(k);
        if (vb === undefined) return false;
        if (!this.aggregateEquals(va, vb, loc)) return false;
      }
      return true;
    }
    if (isStruct(a) || isStruct(b)) {
      throw new RuntimeError(
        `Type mismatch: cannot compare ${describe(a)} and ${describe(b)}`,
        loc,
      );
    }
    // unique-list <-> unique-list: order-independent set equality via canonical keys.
    if (isUniqueList(a) && isUniqueList(b)) {
      if (a.element !== b.element) return false;
      if (a.items.size !== b.items.size) return false;
      for (const k of a.items.keys()) {
        if (!b.items.has(k)) return false;
      }
      return true;
    }
    // unique-list <-> list (either direction): same element type, same length, same order
    // (insertion order, as preserved by the unique list's backing Map).
    if ((isUniqueList(a) && isList(b)) || (isList(a) && isUniqueList(b))) {
      const ua = isUniqueList(a) ? uniqueListValues(a) : a.items;
      const ub = isUniqueList(b) ? uniqueListValues(b) : (b as ChatterList).items;
      const aElem = (a as ChatterList | ChatterUniqueList).element;
      const bElem = (b as ChatterList | ChatterUniqueList).element;
      if (aElem !== bElem) return false;
      if (ua.length !== ub.length) return false;
      for (let i = 0; i < ua.length; i++) {
        if (!this.aggregateEquals(ua[i], ub[i], loc)) return false;
      }
      return true;
    }
    // list <-> list: existing reference equality.
    if (isList(a) && isList(b)) {
      return a === b;
    }
    if (typeof a !== typeof b) {
      throw new RuntimeError(
        `Type mismatch: cannot compare ${describe(a)} and ${describe(b)}`,
        loc,
      );
    }
    return a === b;
  }
}
