export type Instruction =
  | { op: 'PUSH_INT'; value: number }
  | { op: 'PUSH_STR'; value: string }
  | { op: 'PUSH_BOOL'; value: boolean }
  | { op: 'LOAD'; name: string }
  | { op: 'STORE'; name: string }   // emitted for `set X to Y`
  | { op: 'STORE_VAR'; name: string }  // for `var` decl / `change`: type-locked store (records type on first store, checks on subsequent)
  | { op: 'DELETE'; name: string }  // unset a frame local (for scoped loop vars)
  | { op: 'LOAD_IT' }
  | { op: 'STORE_IT' }
  | { op: 'ADD' }
  | { op: 'SUB' }
  | { op: 'MUL' }
  | { op: 'DIV' }
  | { op: 'POW' }
  | { op: 'EQ' }
  | { op: 'NEQ' }
  | { op: 'LT' }
  | { op: 'LE' }
  | { op: 'GT' }
  | { op: 'GE' }
  | { op: 'AND' }
  | { op: 'OR' }
  | { op: 'NOT' }
  | { op: 'JUMP'; target: number }
  | { op: 'JUMP_IF_FALSE'; target: number }
  | { op: 'CALL'; name: string; argCount: number }
  | { op: 'RETURN' }
  | { op: 'SAY' }
  | { op: 'DROP' }  // pops and discards stack top; used at void call sites to ignore the implicit 0 left by the callee
  | { op: 'CHECK_TYPE'; expected: 'number' | 'string' | 'boolean'; context: string }  // peeks stack top; throws if type mismatches; used to enforce typed-function return types when the static type is unknown
  | { op: 'ERROR'; message: string };

export interface FunctionDef {
  name: string;
  params: string[];         // parameter names in order
  instructions: Instruction[];
}

export interface BytecodeProgram {
  functions: Map<string, FunctionDef>;
  main: Instruction[];      // top-level instructions
}
