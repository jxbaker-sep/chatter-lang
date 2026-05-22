import { Instruction, BytecodeProgram } from './bytecode';
import * as fs from 'fs';
import { ChatterError, SourceLocation } from './errors';
import { ChatterType, STRING_TYPE, typeCode, typeToString, typesEqual } from './types';

export class RuntimeError extends ChatterError {
  constructor(message: string, location?: SourceLocation) {
    super(message, location);
    this.name = 'RuntimeError';
  }
}

export interface ChatterList {
  kind: 'list';
  element: ChatterType;
  items: ChatterValue[];
}

export interface ChatterUniqueList {
  kind: 'uniqueList';
  element: ChatterType;
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
  keyType: ChatterType;
  valueType: ChatterType;
  items: Map<string, { key: ChatterValue; value: ChatterValue }>;  // canonicalKey -> entry
}

export interface ChatterOptional {
  kind: 'optional';
  present: boolean;
  value?: ChatterValue;  // defined iff present === true
  element: ChatterType;  // inner element type
}

export type ChatterValue = number | string | boolean | ChatterList | ChatterUniqueList | ChatterStruct | ChatterDict | ChatterOptional;

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

function isOptional(v: ChatterValue): v is ChatterOptional {
  return typeof v === 'object' && v !== null && (v as any).kind === 'optional';
}

function isAnyList(v: ChatterValue): v is ChatterList | ChatterUniqueList {
  return isList(v) || isUniqueList(v);
}

function valueTypeOf(v: ChatterValue): ChatterType {
  if (typeof v === 'number') return { kind: 'scalar', name: 'number' };
  if (typeof v === 'string') return STRING_TYPE;
  if (typeof v === 'boolean') return { kind: 'scalar', name: 'boolean' };
  if (isStruct(v)) return { kind: 'struct', mangled: v.typeName };
  if (isList(v)) return { kind: 'list', element: v.element };
  if (isUniqueList(v)) return { kind: 'uniqueList', element: v.element };
  if (isOptional(v)) return { kind: 'optional', element: v.element };
  return { kind: 'dict', keyType: v.keyType, valueType: v.valueType };
}

function valueMatchesType(v: ChatterValue, expected: ChatterType): boolean {
  return typesEqual(valueTypeOf(v), expected);
}

function scalarCanonicalKey(v: number | string | boolean): string {
  if (typeof v === 'number') return 'n:' + JSON.stringify(v);
  if (typeof v === 'string') return 's:' + v.length + ':' + v;
  return v ? 'b:1' : 'b:0';
}

function canonicalKey(v: ChatterValue): string {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return scalarCanonicalKey(v);
  if (isOptional(v)) {
    if (!v.present) return 'O:none';
    return 'O:' + canonicalKey(v.value!);
  }
  if (isStruct(v)) {
    const parts: string[] = [];
    for (const [fname, fval] of v.fields) parts.push(fname + '=' + canonicalKey(fval));
    return 'S:' + v.typeName + '{' + parts.join(',') + '}';
  }
  if (isList(v)) {
    return 'L' + typeCode(v.element) + '[' + v.items.map(canonicalKey).join(',') + ']';
  }
  if (isUniqueList(v)) {
    return 'U' + typeCode(v.element) + '{' + Array.from(v.items.values()).map(canonicalKey).sort().join('|') + '}';
  }
  const entries = Array.from(v.items.values())
    .map(e => canonicalKey(e.key) + '=' + canonicalKey(e.value))
    .sort();
  return 'D' + typeCode(v.keyType) + '=>' + typeCode(v.valueType) + '{' + entries.join(',') + '}';
}

function uniqueListValues(u: ChatterUniqueList): ChatterValue[] {
  if (u._iterCache === undefined) u._iterCache = Array.from(u.items.values());
  return u._iterCache;
}

function invalidateUniqueListCache(u: ChatterUniqueList): void {
  u._iterCache = undefined;
}

// Strip module prefix and generic instantiation suffix for user-facing display.
function unmangleStructName(mangled: string): string {
  const idx = mangled.indexOf('::');
  const unprefixed = idx === -1 ? mangled : mangled.slice(idx + 2);
  const genIdx = unprefixed.indexOf('$');
  return genIdx === -1 ? unprefixed : unprefixed.slice(0, genIdx);
}

function describe(v: ChatterValue): string {
  return typeToString(valueTypeOf(v));
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

interface Frame {
  instructions: Instruction[];
  ip: number;
  locals: Map<string, ChatterValue>;          // used by main/top-level frame
  localsArr: ChatterValue[] | null;           // used by function frames (slot-indexed)
  varTypes: Map<string, 'number' | 'string' | 'boolean' | string> | null;
  varTypesArr: (string | undefined)[] | null;  // parallel to localsArr, lazy
  it: ChatterValue | null;
}

const INT_MIN = Number.MIN_SAFE_INTEGER;
const INT_MAX = Number.MAX_SAFE_INTEGER;

// Sentinel empty Map shared across all function frames. Function bodies
// never STORE into frame.locals (they use STORE_SLOT into localsArr), so
// this Map remains read-only at runtime — sharing one instance is safe and
// saves allocating an empty Map per pooled frame.
const EMPTY_MAP: Map<string, ChatterValue> = new Map();

export class VM {
  private stack: ChatterValue[] = [];
  private callStack: Frame[] = [];
  // Tracks struct values currently being rendered by a custom formatter,
  // keyed by reference identity. Used to detect direct recursion (a
  // formatter that re-renders its own value). Sequential renders of the
  // same value (e.g. `list of p, p`) are fine because each add/remove pair
  // is balanced.
  private currentlyFormatting: Set<ChatterStruct> = new Set();

  // Frame pool: hot reuse of Frame objects across CALL/return to avoid
  // allocating a fresh { locals, varTypes, ... } pair per call.
  private framePool: Frame[] = [];

  private acquireFrame(instructions: Instruction[], slotCount: number): Frame {
    const f = this.framePool.pop();
    if (f !== undefined) {
      f.instructions = instructions;
      f.ip = 0;
      // Resize/clear the slot array in place.
      const arr = f.localsArr!;
      arr.length = slotCount;
      for (let i = 0; i < slotCount; i++) arr[i] = undefined as unknown as ChatterValue;
      f.it = null;
      return f;
    }
    return {
      instructions,
      ip: 0,
      locals: EMPTY_MAP,
      localsArr: new Array(slotCount),
      varTypes: null,
      varTypesArr: null,
      it: null,
    };
  }

  private releaseFrame(f: Frame): void {
    if (f.varTypesArr !== null) {
      // Clear so the next acquirer doesn't see stale type-locks.
      const a = f.varTypesArr;
      for (let i = 0; i < a.length; i++) a[i] = undefined;
    }
    this.framePool.push(f);
  }

  constructor(private program: BytecodeProgram) {}

  // Render a value to its display string. Structs with a registered
  // custom formatter (see program.structFormatters) invoke the formatter
  // synchronously through a freshly-pushed frame; all other values use
  // the default formatting (recursing into elements).
  private formatValue(v: ChatterValue): string {
    if (isOptional(v)) {
      if (!v.present) return 'none';
      return this.formatValue(v.value!);
    }
    if (isStruct(v)) {
      const formatterName = this.program.structFormatters?.get(v.typeName);
      if (formatterName) {
        if (this.currentlyFormatting.has(v)) {
          throw new RuntimeError(
            `recursive formatter for struct '${unmangleStructName(v.typeName)}'`,
          );
        }
        this.currentlyFormatting.add(v);
        try {
          return this.runFormatter(formatterName, v);
        } finally {
          this.currentlyFormatting.delete(v);
        }
      }
      const tname = unmangleStructName(v.typeName);
      const parts: string[] = [];
      for (const [fname, fval] of v.fields) {
        const formatted = typeof fval === 'string'
          ? `"${fval}"`
          : this.formatValue(fval);
        parts.push(`${fname}: ${formatted}`);
      }
      return `${tname}(${parts.join(', ')})`;
    }
    if (isUniqueList(v)) {
      return '[' + uniqueListValues(v).map(e => {
        if (isAnyList(e) || isDict(e) || isOptional(e)) return this.formatValue(e);
        if (isStruct(e)) return this.formatValue(e);
        if (typeof e === 'string') return `"${e}"`;
        return formatScalar(e as number | string | boolean);
      }).join(', ') + ']';
    }
    if (isList(v)) {
      return '[' + v.items.map(e => {
        if (isAnyList(e) || isDict(e) || isOptional(e)) return this.formatValue(e);
        if (isStruct(e)) return this.formatValue(e);
        if (typeof e === 'string') return `"${e}"`;
        return formatScalar(e as number | string | boolean);
      }).join(', ') + ']';
    }
    if (isDict(v)) {
      if (v.items.size === 0) {
        return 'empty dictionary from ' + typeToString(v.keyType) + ' to ' + typeToString(v.valueType);
      }
      const fmt = (e: ChatterValue): string => {
        if (isAnyList(e) || isStruct(e) || isDict(e) || isOptional(e)) return this.formatValue(e);
        if (typeof e === 'string') return `"${e}"`;
        return formatScalar(e as number | string | boolean);
      };
      const parts: string[] = [];
      for (const entry of v.items.values()) {
        parts.push(fmt(entry.key) + ' to ' + fmt(entry.value));
      }
      return 'dictionary ' + parts.join(', ');
    }
    return formatScalar(v as number | string | boolean);
  }

  private stringify(v: ChatterValue): string {
    return this.formatValue(v);
  }

  // Synchronously invoke a struct's format function and return its (string)
  // result. The formatter is a synthetic FunctionDef with a single `it`
  // param; we push a fresh frame and run it to completion.
  private runFormatter(formatterName: string, value: ChatterStruct): string {
    const fdef = this.program.functions.get(formatterName);
    if (!fdef) {
      throw new RuntimeError(`Missing formatter function '${formatterName}'`);
    }
    const slotCount = fdef.slotCount ?? fdef.params.length;
    const frame = this.acquireFrame(fdef.instructions, slotCount);
    // Format functions take a single `it` param at slot 0 (per
    // compileFormatThunk).
    frame.localsArr![0] = value;
    this.callStack.push(frame);
    this.executeFrame();
    this.callStack.pop();
    this.releaseFrame(frame);
    const result = this.stack.pop();
    if (typeof result !== 'string') {
      throw new RuntimeError(
        `'format is' body must produce a string, got ${describe(result as ChatterValue)}`,
      );
    }
    return result;
  }

  run(): void {
    const mainFrame: Frame = {
      instructions: this.program.main,
      ip: 0,
      locals: new Map(),
      localsArr: null,
      varTypes: null,
      varTypesArr: null,
      it: null,
    };
    this.callStack.push(mainFrame);
    this.executeFrame();
    this.callStack.pop();
  }

  private opCounts: Map<string, number> = new Map();
  private opTimes: Map<string, number> = new Map();
  private static PROFILE = !!process.env.CHATTER_PROFILE;

  private executeFrame(): void {
    const frame = this.callStack[this.callStack.length - 1];
    const instructions = frame.instructions;
    if (VM.PROFILE) {
      while (frame.ip < instructions.length) {
        const instr = instructions[frame.ip++];
        if (instr.op === 'RETURN') return;
        const __t0 = process.hrtime.bigint();
        this.executeInstr(instr, frame);
        const __t1 = process.hrtime.bigint();
        const __d = Number(__t1 - __t0);
        this.opCounts.set(instr.op, (this.opCounts.get(instr.op) || 0) + 1);
        this.opTimes.set(instr.op, (this.opTimes.get(instr.op) || 0) + __d);
      }
      return;
    }
    while (frame.ip < instructions.length) {
      const instr = instructions[frame.ip++];
      if (instr.op === 'RETURN') return;
      this.executeInstr(instr, frame);
    }
  }

  dumpOpProfile(): void {
    const rows: Array<{op: string; count: number; ns: number}> = [];
    for (const [op, count] of this.opCounts) {
      rows.push({ op, count, ns: this.opTimes.get(op) || 0 });
    }
    rows.sort((a, b) => b.ns - a.ns);
    const total = rows.reduce((a, b) => a + b.ns, 0);
    console.error('op,count,total_ms,pct,ns_per_call');
    for (const r of rows.slice(0, 25)) {
      console.error(`${r.op},${r.count},${(r.ns/1e6).toFixed(1)},${(r.ns/total*100).toFixed(1)}%,${(r.ns/r.count).toFixed(0)}`);
    }
  }

  private executeInstr(instr: Instruction, frame: Frame): void {
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
        // Globals (frame[0]) — emitted only at module-init top level or for
        // cross-module names like `m0::foo`. Function-frame locals use
        // LOAD_SLOT (see below). At top-level execution this.callStack
        // length is 1 and frame === callStack[0], so the first lookup is on
        // the only frame. From inside a function, frame.locals is the
        // shared EMPTY_MAP and we fall through to frame[0].
        // Globals live in callStack[0].locals. From a function frame,
        // frame.locals is the EMPTY_MAP sentinel — skip it and go direct
        // to the top frame. Function locals use LOAD_SLOT.
        const globals = this.callStack[0].locals;
        const v = globals.get(instr.name);
        if (v !== undefined) {
          this.stack.push(v);
          return;
        }
        throw new RuntimeError(`Undefined variable: '${instr.name}'`, instr.loc);
      }

      case 'LOAD_SLOT': {
        const v = frame.localsArr![instr.slot];
        if (v === undefined) {
          throw new RuntimeError(`Undefined variable: '${instr.name}'`, instr.loc);
        }
        this.stack.push(v);
        return;
      }

      case 'STORE': {
        frame.locals.set(instr.name, this.pop());
        break;
      }

      case 'STORE_SLOT': {
        frame.localsArr![instr.slot] = this.pop();
        break;
      }

      case 'STORE_VAR': {
        const val = this.pop();
        const valType = typeCode(valueTypeOf(val));
        let vts = frame.varTypes;
        if (vts === null) {
          vts = new Map();
          frame.varTypes = vts;
          vts.set(instr.name, valType);
        } else {
          const existing = vts.get(instr.name);
          if (existing === undefined) {
            vts.set(instr.name, valType);
          } else if (existing !== valType) {
            throw new RuntimeError(
              `Type mismatch: cannot change '${instr.name}' (expected ${existing}, got ${valType})`,
            instr.loc);
          }
        }
        frame.locals.set(instr.name, val);
        break;
      }

      case 'STORE_VAR_SLOT': {
        const val = this.pop();
        const valType = typeCode(valueTypeOf(val));
        let vta = frame.varTypesArr;
        if (vta === null) {
          vta = new Array(frame.localsArr!.length);
          frame.varTypesArr = vta;
          vta[instr.slot] = valType;
        } else {
          const existing = vta[instr.slot];
          if (existing === undefined) {
            vta[instr.slot] = valType;
          } else if (existing !== valType) {
            throw new RuntimeError(
              `Type mismatch: cannot change '${instr.name}' (expected ${existing}, got ${valType})`,
            instr.loc);
          }
        }
        frame.localsArr![instr.slot] = val;
        break;
      }

      case 'DELETE': {
        frame.locals.delete(instr.name);
        break;
      }

      case 'DELETE_SLOT': {
        frame.localsArr![instr.slot] = undefined as unknown as ChatterValue;
        if (frame.varTypesArr !== null) {
          frame.varTypesArr[instr.slot] = undefined;
        }
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
        // Resolve + cache the target function on first execution. Subsequent
        // calls skip the Map lookup entirely.
        let funcDef = instr.cachedFn;
        if (funcDef === undefined) {
          const fd = this.program.functions.get(instr.name);
          if (!fd) {
            throw new RuntimeError(`Undefined function: '${instr.name}'`, instr.loc);
          }
          funcDef = fd;
          instr.cachedFn = fd;
        }
        // Acquire a frame from the pool (or alloc fresh) sized for this
        // function's slot table, and bind args directly into slots 0..n-1.
        const slotCount = funcDef.slotCount ?? funcDef.params.length;
        const newFrame = this.acquireFrame(funcDef.instructions, slotCount);
        const paramCount = funcDef.params.length;
        const argCount = instr.argCount;
        const stack = this.stack;
        const localsArr = newFrame.localsArr!;
        const baseIdx = stack.length - argCount;
        for (let i = 0; i < paramCount; i++) {
          localsArr[i] = stack[baseIdx + i];
        }
        stack.length = baseIdx;
        this.callStack.push(newFrame);
        this.executeFrame();
        this.callStack.pop();
        this.releaseFrame(newFrame);
        // The return value was left on the stack by RETURN's expression.
        break;
      }

      case 'SAY': {
        const val = this.pop();
        if (val === undefined) {
          throw new RuntimeError('Stack underflow in SAY', instr.loc);
        }
        console.log(this.formatValue(val));
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
        console.log(vals.map(v => this.formatValue(v)).join(' '));
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

      case 'FAIL': {
        const m = this.pop();
        if (typeof m !== 'string') {
          throw new RuntimeError(`fail message must be a string, got ${describe(m)}`, instr.loc);
        }
        throw new RuntimeError(`fail: ${m}`, instr.loc);
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

      case 'JUMP_BOOL_OP': {
        const v = this.stack[this.stack.length - 1];
        if (typeof v !== 'boolean') {
          throw new RuntimeError(
            `Type mismatch: '${instr.logicalOp}' requires booleans, got ${typeof v}`,
            instr.loc,
          );
        }
        const shortCircuit = instr.logicalOp === 'and' ? !v : v;
        if (shortCircuit) {
          frame.ip = instr.target;
        } else {
          this.stack.pop();
        }
        break;
      }

      case 'EXPECT_BOOL_OP': {
        const v = this.stack[this.stack.length - 1];
        if (typeof v !== 'boolean') {
          throw new RuntimeError(
            `Type mismatch: '${instr.logicalOp}' requires booleans, got ${typeof v}`,
            instr.loc,
          );
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
        let elementType: ChatterType;
        if (instr.elementType !== null) {
          elementType = instr.elementType;
        } else {
          elementType = valueTypeOf(elems[0]);
        }
        for (let i = 0; i < elems.length; i++) {
          const e = elems[i];
          if (!valueMatchesType(e, elementType)) {
            throw new RuntimeError(
              `Type mismatch: list element ${i + 1} has type ${describe(e)}, expected ${typeToString(elementType)}`,
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

      case 'MAKE_EMPTY_LIST_LIKE': {
        const src = this.pop();
        if (typeof src !== 'object' || src === null || (src.kind !== 'list' && src.kind !== 'uniqueList')) {
          throw new RuntimeError(`'filter' requires a list, got ${describe(src as ChatterValue)}`, instr.loc);
        }
        const list: ChatterList = { kind: 'list', element: src.element, items: [] };
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
        let elementType: ChatterType;
        if (instr.elementType !== null) {
          elementType = instr.elementType;
        } else {
          elementType = valueTypeOf(elems[0]);
        }
        for (let i = 0; i < elems.length; i++) {
          const e = elems[i];
          if (!valueMatchesType(e, elementType)) {
            throw new RuntimeError(
              `Type mismatch: unique list element ${i + 1} has type ${describe(e)}, expected ${typeToString(elementType)}`,
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
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot add ${describe(value)} to unique list of ${typeToString(list.element)}`,
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
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot remove ${describe(value)} from unique list of ${typeToString(list.element)}`,
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
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot assign ${describe(value)} to list of ${typeToString(list.element)}`,
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
          if (!valueMatchesType(value, left.keyType)) {
            throw new RuntimeError(
              `Type mismatch: 'contains' key type ${describe(value)} does not match dictionary key type ${typeToString(left.keyType)}`,
            instr.loc);
          }
          this.stack.push(left.items.has(canonicalKey(value)));
          break;
        }
        if (!isAnyList(left)) {
          throw new RuntimeError(`Type mismatch: 'contains' requires a list, dictionary, or string on the left, got ${describe(left)}`, instr.loc);
        }
        if (!valueMatchesType(value, left.element)) {
          throw new RuntimeError(
            `Type mismatch: 'contains' value type ${describe(value)} does not match list element type ${typeToString(left.element)}`,
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
        this.stack.push(this.stringify(a) + this.stringify(b));
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

      case 'LIST_SUBLIST': {
        const to = this.pop();
        const from = this.pop();
        const lst = this.pop();
        if (!isList(lst)) {
          throw new RuntimeError(`Type mismatch: 'items A to B of X' requires a list, got ${describe(lst)}`, instr.loc);
        }
        if (typeof from !== 'number' || typeof to !== 'number') {
          throw new RuntimeError(`Type mismatch: sublist bounds must be numbers`, instr.loc);
        }
        if (from > to) {
          const empty: ChatterList = { kind: 'list', element: lst.element, items: [] };
          this.stack.push(empty);
          break;
        }
        if (from < 1 || to > lst.items.length) {
          throw new RuntimeError(
            `Index out of range: items ${from} to ${to} of list (length ${lst.items.length})`,
          instr.loc);
        }
        const sliced: ChatterList = { kind: 'list', element: lst.element, items: lst.items.slice(from - 1, to) };
        this.stack.push(sliced);
        break;
      }

      case 'LIST_APPEND': {
        const value = this.pop();
        const list = this.pop();
        if (!isList(list)) {
          throw new RuntimeError(`Type mismatch: 'append' target must be a list, got ${describe(list)}`, instr.loc);
        }
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot append ${describe(value)} to list of ${typeToString(list.element)}`,
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
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot prepend ${describe(value)} to list of ${typeToString(list.element)}`,
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
        if (!valueMatchesType(value, list.element)) {
          throw new RuntimeError(
            `Type mismatch: cannot insert ${describe(value)} into list of ${typeToString(list.element)}`,
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

      case 'SORT_LIST': {
        const desc = instr.descending;
        if (instr.byKey) {
          const keys = this.pop();
          const list = this.pop();
          if (!isList(list)) {
            throw new RuntimeError(`Type mismatch: 'sort' target must be a list, got ${describe(list)}`, instr.loc);
          }
          if (!isList(keys)) {
            throw new RuntimeError(`Type mismatch: sort keys must be a list, got ${describe(keys)}`, instr.loc);
          }
          if (keys.items.length !== list.items.length) {
            throw new RuntimeError(`internal sort error: keys length mismatch`, instr.loc);
          }
          if (!(keys.element.kind === 'scalar' && (keys.element.name === 'number' || keys.element.name === 'string' || keys.element.name === 'boolean'))) {
            throw new RuntimeError(`'sort by KEY' keys must be number, string, or boolean, got ${typeToString(keys.element)}`, instr.loc);
          }
          // Build paired indices and stable-sort.
          const n = list.items.length;
          const indices: number[] = new Array(n);
          for (let i = 0; i < n; i++) indices[i] = i;
          const ks = keys.items;
          indices.sort((a, b) => {
            const ka = ks[a] as any;
            const kb = ks[b] as any;
            let c: number;
            if (typeof ka === 'number' && typeof kb === 'number') c = ka - kb;
            else if (typeof ka === 'boolean' && typeof kb === 'boolean') c = Number(ka) - Number(kb);
            else c = String(ka) < String(kb) ? -1 : (String(ka) > String(kb) ? 1 : 0);
            if (c === 0) return a - b;  // stability fallback (Array.sort already stable in ES2019+)
            return desc ? -c : c;
          });
          const sorted = new Array(n);
          for (let i = 0; i < n; i++) sorted[i] = list.items[indices[i]];
          for (let i = 0; i < n; i++) list.items[i] = sorted[i];
        } else {
          const list = this.pop();
          if (!isList(list)) {
            throw new RuntimeError(`Type mismatch: 'sort' target must be a list, got ${describe(list)}`, instr.loc);
          }
          if (!(list.element.kind === 'scalar' && (list.element.name === 'number' || list.element.name === 'string' || list.element.name === 'boolean'))) {
            throw new RuntimeError(`'sort' without 'by KEY' requires a list of number, string, or boolean, got list of ${typeToString(list.element)}`, instr.loc);
          }
          const items = list.items;
          // Decorate with original index for stability.
          const n = items.length;
          const indices: number[] = new Array(n);
          for (let i = 0; i < n; i++) indices[i] = i;
          indices.sort((a, b) => {
            const va = items[a] as any;
            const vb = items[b] as any;
            let c: number;
            if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
            else if (typeof va === 'boolean' && typeof vb === 'boolean') c = Number(va) - Number(vb);
            else c = String(va) < String(vb) ? -1 : (String(va) > String(vb) ? 1 : 0);
            if (c === 0) return a - b;
            return desc ? -c : c;
          });
          const sorted = new Array(n);
          for (let i = 0; i < n; i++) sorted[i] = items[indices[i]];
          for (let i = 0; i < n; i++) items[i] = sorted[i];
        }
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
        const list: ChatterList = { kind: 'list', element: STRING_TYPE, items };
        this.stack.push(list);
        break;
      }

      case 'LOAD_ARGS': {
        // Fresh mutable list of string each call — mutating the returned
        // list never affects subsequent `args` calls.
        const items: ChatterValue[] = (this.program.args ?? []).slice();
        const list: ChatterList = { kind: 'list', element: STRING_TYPE, items };
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
          if (!valueMatchesType(e.key, instr.keyType)) {
            throw new RuntimeError(
              `Type mismatch: dictionary key has type ${describe(e.key)}, expected ${typeToString(instr.keyType)}`,
            instr.loc);
          }
          if (!valueMatchesType(e.value, instr.valueType)) {
            throw new RuntimeError(
              `Type mismatch: dictionary value has type ${describe(e.value)}, expected ${typeToString(instr.valueType)}`,
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
        if (!valueMatchesType(key, dict.keyType)) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${typeToString(dict.keyType)}`,
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
        if (!valueMatchesType(key, dict.keyType)) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${typeToString(dict.keyType)}`,
          instr.loc);
        }
        if (!valueMatchesType(value, dict.valueType)) {
          throw new RuntimeError(
            `Type mismatch: dictionary value has type ${describe(value)}, expected ${typeToString(dict.valueType)}`,
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
        if (!valueMatchesType(key, dict.keyType)) {
          throw new RuntimeError(
            `Type mismatch: dictionary key has type ${describe(key)}, expected ${typeToString(dict.keyType)}`,
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

      case 'PUSH_NONE': {
        this.stack.push({ kind: 'optional', present: false, element: instr.element });
        break;
      }

      case 'WRAP_OPTIONAL': {
        const val = this.pop();
        const elem = valueTypeOf(val);
        this.stack.push({ kind: 'optional', present: true, value: val, element: elem });
        break;
      }

      case 'UNWRAP_OPTIONAL': {
        const val = this.pop();
        if (!isOptional(val)) {
          throw new RuntimeError(
            `tried to use the value of an absent optional — should have been narrowed`,
            instr.loc);
        }
        if (!val.present) {
          throw new RuntimeError(
            `tried to use the value of an absent optional — should have been narrowed`,
            instr.loc);
        }
        this.stack.push(val.value!);
        break;
      }

      case 'IS_NONE': {
        const val = this.pop();
        if (!isOptional(val)) {
          throw new RuntimeError(`IS_NONE requires an optional value`, instr.loc);
        }
        this.stack.push(!val.present);
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
    // optional <-> optional: structural equality
    if (isOptional(a) && isOptional(b)) {
      if (!typesEqual(a.element, b.element)) {
        throw new RuntimeError(
          `Type mismatch: cannot compare ${describe(a)} and ${describe(b)}`,
          loc,
        );
      }
      if (!a.present && !b.present) return true;
      if (!a.present || !b.present) return false;
      return this.aggregateEquals(a.value!, b.value!, loc);
    }
    // optional <-> non-optional: auto-lift lenient comparison
    if (isOptional(a)) {
      if (!a.present) return false;
      return this.aggregateEquals(a.value!, b, loc);
    }
    if (isOptional(b)) {
      if (!b.present) return false;
      return this.aggregateEquals(a, b.value!, loc);
    }
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

    if (isList(a) && isList(b)) {
      if (!typesEqual(a.element, b.element)) return false;
      if (a.items.length !== b.items.length) return false;
      for (let i = 0; i < a.items.length; i++) {
        if (!this.aggregateEquals(a.items[i], b.items[i], loc)) return false;
      }
      return true;
    }

    // unique-list <-> unique-list: order-independent set equality via canonical keys.
    if (isUniqueList(a) && isUniqueList(b)) {
      if (!typesEqual(a.element, b.element)) return false;
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
      if (!typesEqual(aElem, bElem)) return false;
      if (ua.length !== ub.length) return false;
      for (let i = 0; i < ua.length; i++) {
        if (!this.aggregateEquals(ua[i], ub[i], loc)) return false;
      }
      return true;
    }

    if (isDict(a) && isDict(b)) {
      if (!typesEqual(a.keyType, b.keyType) || !typesEqual(a.valueType, b.valueType)) return false;
      if (a.items.size !== b.items.size) return false;
      for (const [k, entryA] of a.items) {
        const entryB = b.items.get(k);
        if (entryB === undefined) return false;
        if (!this.aggregateEquals(entryA.value, entryB.value, loc)) return false;
      }
      return true;
    }

    if (isAnyList(a) || isAnyList(b) || isDict(a) || isDict(b)) {
      throw new RuntimeError(
        `Type mismatch: cannot compare ${describe(a)} and ${describe(b)}`,
        loc,
      );
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
