import { Instruction, BytecodeProgram } from './bytecode';

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

type ChatterValue = number | string | boolean;

interface Frame {
  instructions: Instruction[];
  ip: number;
  locals: Map<string, ChatterValue>;
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
      case 'POW': {
        const b = this.pop();
        const a = this.pop();
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new RuntimeError(
            `Type mismatch: arithmetic requires numbers, got ${typeof a} and ${typeof b}`,
          );
        }
        if (instr.op === 'DIV' && b === 0) {
          throw new RuntimeError('Division by zero');
        }
        let result: number;
        switch (instr.op) {
          case 'ADD': result = a + b; break;
          case 'SUB': result = a - b; break;
          case 'MUL': result = a * b; break;
          case 'DIV': result = Math.trunc(a / b); break;
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
        if (typeof val === 'boolean') {
          console.log(val ? 'true' : 'false');
        } else {
          console.log(typeof val === 'number' ? String(val) : val);
        }
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
    }
  }

  private pop(): ChatterValue {
    if (this.stack.length === 0) {
      throw new RuntimeError('Stack underflow');
    }
    return this.stack.pop()!;
  }
}
