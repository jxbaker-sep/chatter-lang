export type ScalarTypeName = 'number' | 'string' | 'boolean';

export type TypeAnnotation =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: ScalarTypeName; readonly: boolean };

export type Expression =
  | BinaryExpression
  | UnaryExpression
  | IdentifierExpression
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ItExpression
  | CallStatement
  | ListLiteral
  | ItemAccessExpression
  | FirstItemExpression
  | LastItemExpression
  | LengthExpression
  | CharacterAccessExpression
  | FirstCharacterExpression
  | LastCharacterExpression
  | SubstringExpression
  | ReadFileLinesExpression;

export type Statement =
  | SayStatement
  | SetStatement
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
  | ReadFileStatement
  | ExpectStatement;

export interface VarDeclaration {
  type: 'VarDeclaration';
  name: string;
  value: Expression;
}

export interface ChangeStatement {
  type: 'ChangeStatement';
  name: string;
  value: Expression;
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
  expression: Expression;
}

export interface SetStatement {
  type: 'SetStatement';
  name: string;
  value: Expression;
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
}

export interface CallStatement {
  type: 'CallStatement';
  name: string;
  args: Array<{ name: string | null; value: Expression }>;
}

export interface ReturnStatement {
  type: 'ReturnStatement';
  value: Expression | null;
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
  | { type: 'RepeatStatement'; kind: 'range'; varName: string; from: Expression; to: Expression; body: Statement[] }
  | { type: 'RepeatStatement'; kind: 'while'; condition: Expression; body: Statement[] }
  | { type: 'RepeatStatement'; kind: 'list'; varName: string; list: Expression; body: Statement[] };

export interface ListLiteral {
  type: 'ListLiteral';
  kind: 'nonempty' | 'empty';
  elementType: ScalarTypeName | null;  // required for empty; null for nonempty (inferred)
  elements: Expression[];
}

export interface ItemAccessExpression {
  type: 'ItemAccessExpression';
  index: Expression;
  target: Expression;
}

export interface FirstItemExpression {
  type: 'FirstItemExpression';
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

export interface FirstCharacterExpression {
  type: 'FirstCharacterExpression';
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

export interface ReadFileStatement {
  type: 'ReadFileStatement';
  path: Expression;
}

export interface ExpectStatement {
  type: 'ExpectStatement';
  expression: Expression;
  source: string;
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

