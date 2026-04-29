import { SourceLocation } from './errors';

export type InstructionKind =

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
  | { op: 'MOD' }
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
  | { op: 'SAY_MULTI'; count: number }
  | { op: 'DROP' }  // pops and discards stack top; used at void call sites to ignore the implicit 0 left by the callee
  | { op: 'CHECK_TYPE'; expected: 'number' | 'string' | 'boolean'; context: string }  // peeks stack top; throws if type mismatches; used to enforce typed-function return types when the static type is unknown
  | { op: 'MAKE_LIST'; count: number; elementType: string | null }  // 'number'|'string'|'boolean'|'struct:<mangled>'|null (infer)
  | { op: 'MAKE_EMPTY_LIST'; elementType: string }
  | { op: 'MAKE_UNIQUE_LIST'; count: number; elementType: string | null }
  | { op: 'MAKE_EMPTY_UNIQUE_LIST'; elementType: string }
  | { op: 'UNIQUE_LIST_ADD' }    // pop value, pop unique-list, append if not already present
  | { op: 'UNIQUE_LIST_REMOVE' } // pop value, pop unique-list, remove if present (no-op otherwise)
  | { op: 'LIST_GET' }        // pop index, pop list, push element
  | { op: 'LIST_SET' }        // pop value, pop index, pop list, mutate
  | { op: 'LENGTH' }          // pop value (list or string), push number
  | { op: 'CONTAINS' }        // pop rhs, pop lhs (list or string), push boolean
  | { op: 'CONCAT' }          // pop b, pop a; both coerced to string; push a+b
  | { op: 'STR_CHAR_AT' }     // pop index, pop string, push 1-char string
  | { op: 'STR_SUBSTRING' }   // pop to, pop from, pop string, push substring
  | { op: 'LIST_APPEND' }     // pop value, pop list, mutate
  | { op: 'LIST_PREPEND' }    // pop value, pop list, mutate
  | { op: 'LIST_INSERT' }     // pop value, pop index, pop list, mutate
  | { op: 'LIST_REMOVE' }     // pop index, pop list, mutate
  | { op: 'READ_FILE_LINES' } // pop path string, push list of string
  | { op: 'CHAR_CODE' }       // pop string (single code point), push code point number
  | { op: 'CHAR_FROM_CODE' }  // pop number (0..0x10FFFF, no surrogates), push 1-code-point string
  | { op: 'IS_DIGIT' }        // pop string, push boolean
  | { op: 'IS_EMPTY' }        // pop string or list, push boolean (true iff length 0)
  | { op: 'IS_LETTER' }       // pop string, push boolean
  | { op: 'IS_WHITESPACE' }   // pop string, push boolean
  | { op: 'EXPECT'; source: string }
  | { op: 'EXPECT_BOOL_CHECK' }       // peeks top; throws "expect requires a boolean, got X" if not boolean
  | { op: 'EXPECT_FAIL_WITH_MSG' }    // pops string message; throws "expect failed: <msg>"
  | { op: 'MAKE_DICT'; count: number; keyType: string; valueType: string }
  | { op: 'MAKE_EMPTY_DICT'; keyType: string; valueType: string }
  | { op: 'DICT_GET' }
  | { op: 'DICT_SET' }
  | { op: 'DICT_REMOVE' }
  | { op: 'DICT_KEYS' }
  | { op: 'DICT_VALUES' }
  | { op: 'MAKE_STRUCT'; typeName: string; fieldNames: string[] }   // typeName is mangled
  | { op: 'STRUCT_GET'; fieldName: string }
  | { op: 'STRUCT_WITH'; fieldNames: string[] }
  | { op: 'ERROR'; message: string };

export type Instruction = InstructionKind & { loc?: SourceLocation };

export interface FunctionDef {
  name: string;
  params: string[];         // parameter names in order
  instructions: Instruction[];
}

export interface BytecodeProgram {
  functions: Map<string, FunctionDef>;
  main: Instruction[];      // top-level instructions
}
