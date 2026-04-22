export type Instruction =
  | { op: 'PUSH_INT'; value: number }
  | { op: 'PUSH_STR'; value: string }
  | { op: 'PUSH_BOOL'; value: boolean }
  | { op: 'LOAD'; name: string }
  | { op: 'STORE'; name: string }   // emitted for `set X to Y`
  | { op: 'LOAD_IT' }
  | { op: 'STORE_IT' }
  | { op: 'ADD' }
  | { op: 'SUB' }
  | { op: 'MUL' }
  | { op: 'DIV' }
  | { op: 'POW' }
  | { op: 'EQ' }
  | { op: 'NEQ' }
  | { op: 'AND' }
  | { op: 'OR' }
  | { op: 'NOT' }
  | { op: 'JUMP'; target: number }
  | { op: 'JUMP_IF_FALSE'; target: number }
  | { op: 'CALL'; name: string; argCount: number }
  | { op: 'RETURN' }
  | { op: 'SAY' };

export interface FunctionDef {
  name: string;
  params: string[];         // parameter names in order
  instructions: Instruction[];
}

export interface BytecodeProgram {
  functions: Map<string, FunctionDef>;
  main: Instruction[];      // top-level instructions
}
