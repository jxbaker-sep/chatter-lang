export type ScalarTypeName = 'number' | 'string' | 'boolean';

export type ElementTypeAnnotation =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'struct'; name: string };  // unmangled struct name

export type TypeAnnotation =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: ElementTypeAnnotation; readonly: boolean }
  | { kind: 'uniqueList'; element: ElementTypeAnnotation; readonly: false }
  | { kind: 'struct'; name: string };  // unmangled struct name

export interface Located {
  line?: number;
  col?: number;
  length?: number;
  file?: string;
}

export type Expression = (

  | BinaryExpression
  | UnaryExpression
  | IdentifierExpression
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ItExpression
  | CallStatement
  | ListLiteral
  | UniqueListLiteral
  | ItemAccessExpression
  | LastItemExpression
  | LengthExpression
  | CharacterAccessExpression
  | LastCharacterExpression
  | SubstringExpression
  | ReadFileLinesExpression
  | CodeOfExpression
  | CharacterFromCodeExpression
  | IsCharClassExpression
  | IsEmptyExpression
  | EndIndexSentinel
  | MakeStructExpression
  | FieldAccessExpression
  | StructWithExpression
) & Located;

export interface EndIndexSentinel {
  type: 'EndIndexSentinel';
}

export type Statement = (

  | SayStatement
  | ConstantDeclaration
  | VarDeclaration
  | ChangeStatement
  | ChangeItemStatement
  | CompoundAssignStatement
  | FunctionDeclaration
  | CallStatement
  | ReturnStatement
  | IfStatement
  | RepeatStatement
  | AppendStatement
  | PrependStatement
  | InsertStatement
  | RemoveItemStatement
  | RemoveValueStatement
  | ReadFileStatement
  | ExpectStatement
  | UseStatement
  | ExitRepeatStatement
  | NextRepeatStatement
  | StructDeclaration
) & Located;

export interface StructField {
  name: string;
  fieldType: TypeAnnotation;
}

export interface StructDeclaration {
  type: 'StructDeclaration';
  name: string;             // unmangled
  fields: StructField[];
  exported: boolean;
}

export interface MakeStructExpression {
  type: 'MakeStructExpression';
  structName: string;       // unmangled (will be resolved by compiler)
  fields: Array<{ name: string; value: Expression; nameLine?: number; nameCol?: number; nameLength?: number; nameFile?: string }>;
}

export interface FieldAccessExpression {
  type: 'FieldAccessExpression';
  fieldName: string;
  target: Expression;
}

export interface StructWithExpression {
  type: 'StructWithExpression';
  target: Expression;
  updates: Array<{ name: string; value: Expression }>;
}

export interface ExitRepeatStatement {
  type: 'ExitRepeatStatement';
}

export interface NextRepeatStatement {
  type: 'NextRepeatStatement';
}

export interface VarDeclaration {
  type: 'VarDeclaration';
  name: string;
  value: Expression;
  precall?: CallStatement | null;
}

export interface ChangeStatement {
  type: 'ChangeStatement';
  name: string;
  value: Expression;
  precall?: CallStatement | null;
}

export interface ChangeItemStatement {
  type: 'ChangeItemStatement';
  listName: string;
  index: Expression;
  value: Expression;
}

export interface CompoundAssignStatement {
  type: 'CompoundAssignStatement';
  op: 'add' | 'subtract' | 'multiply' | 'divide';
  name: string;
  value: Expression;
}

export interface Program {
  type: 'Program';
  body: Statement[];
}

export interface SayStatement {
  type: 'SayStatement';
  expressions: Expression[];  // nonempty invariant
}

export interface ConstantDeclaration {
  type: 'ConstantDeclaration';
  name: string;
  value: Expression;
  precall?: CallStatement | null;
}

export interface FunctionParam {
  paramType: TypeAnnotation;
  name: string;
  label: string | null;  // null for first param; non-null for each subsequent param
}

export interface FunctionDeclaration {
  type: 'FunctionDeclaration';
  name: string;
  params: FunctionParam[];
  returnType: TypeAnnotation | null;  // null = void
  body: Statement[];
  exported: boolean;
}

export interface UseStatement {
  type: 'UseStatement';
  names: string[];
  path: string;            // as written by user, no .chatter appended
  nameLocs?: Array<{ line: number; col: number; length: number; file?: string }>;
  pathLoc?: { line: number; col: number; length: number; file?: string };
}

export interface CallStatement {
  type: 'CallStatement';
  name: string;
  args: Array<{ name: string | null; value: Expression }>;
}

export interface ReturnStatement {
  type: 'ReturnStatement';
  value: Expression | null;
  precall?: CallStatement | null;
}

export interface BinaryExpression {
  type: 'BinaryExpression';
  operator: string;
  left: Expression;
  right: Expression;
}

export interface IdentifierExpression {
  type: 'IdentifierExpression';
  name: string;
}

export interface NumberLiteral {
  type: 'NumberLiteral';
  value: number;
}

export interface StringLiteral {
  type: 'StringLiteral';
  value: string;
}

export interface ItExpression {
  type: 'ItExpression';
}

export interface BooleanLiteral {
  type: 'BooleanLiteral';
  value: boolean;
}

export interface UnaryExpression {
  type: 'UnaryExpression';
  operator: 'not' | '-';
  operand: Expression;
}

export interface IfBranch {
  condition: Expression;
  body: Statement[];
}

export interface IfStatement {
  type: 'IfStatement';
  branches: IfBranch[];
  elseBody: Statement[] | null;
}

export type RepeatStatement =
  | { type: 'RepeatStatement'; kind: 'times'; count: Expression; body: Statement[] }
  | { type: 'RepeatStatement'; kind: 'range'; varName: string; from: Expression; to: Expression; step?: Expression; body: Statement[] }
  | { type: 'RepeatStatement'; kind: 'while'; condition: Expression; body: Statement[] }
  | { type: 'RepeatStatement'; kind: 'list'; varName: string; list: Expression; body: Statement[] };

export interface ListLiteral {
  type: 'ListLiteral';
  kind: 'nonempty' | 'empty';
  elementType: ElementTypeAnnotation | null;  // required for empty; null for nonempty (inferred)
  elements: Expression[];
}

export interface ItemAccessExpression {
  type: 'ItemAccessExpression';
  index: Expression;
  target: Expression;
}

export interface LastItemExpression {
  type: 'LastItemExpression';
  target: Expression;
}

export interface LengthExpression {
  type: 'LengthExpression';
  target: Expression;
}

export interface CharacterAccessExpression {
  type: 'CharacterAccessExpression';
  index: Expression;
  target: Expression;
}

export interface LastCharacterExpression {
  type: 'LastCharacterExpression';
  target: Expression;
}

export interface SubstringExpression {
  type: 'SubstringExpression';
  from: Expression;
  to: Expression;
  target: Expression;
}

export interface ReadFileLinesExpression {
  type: 'ReadFileLinesExpression';
  path: Expression;
}

export interface CodeOfExpression {
  type: 'CodeOfExpression';
  target: Expression;
}

export interface CharacterFromCodeExpression {
  type: 'CharacterFromCodeExpression';
  code: Expression;
}

export type CharClassName = 'digit' | 'letter' | 'whitespace';

export interface IsCharClassExpression {
  type: 'IsCharClassExpression';
  target: Expression;
  charClass: CharClassName;
}

export interface IsEmptyExpression {
  type: 'IsEmptyExpression';
  target: Expression;
}

export interface ReadFileStatement {
  type: 'ReadFileStatement';
  path: Expression;
}

export interface ExpectStatement {
  type: 'ExpectStatement';
  expression: Expression;
  source: string;
  message?: Expression;
}

export interface AppendStatement {
  type: 'AppendStatement';
  listName: string;
  value: Expression;
}

export interface PrependStatement {
  type: 'PrependStatement';
  listName: string;
  value: Expression;
}

export interface InsertStatement {
  type: 'InsertStatement';
  listName: string;
  index: Expression;
  value: Expression;
}

export interface RemoveItemStatement {
  type: 'RemoveItemStatement';
  listName: string;
  index: Expression;
}

export interface RemoveValueStatement {
  type: 'RemoveValueStatement';
  listName: string;
  value: Expression;
}

export interface UniqueListLiteral {
  type: 'UniqueListLiteral';
  kind: 'nonempty' | 'empty';
  elementType: ElementTypeAnnotation | null;  // required for empty; null for nonempty (inferred)
  elements: Expression[];
}

