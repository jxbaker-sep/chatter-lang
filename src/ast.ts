export type Expression =
  | BinaryExpression
  | UnaryExpression
  | IdentifierExpression
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ItExpression
  | CallStatement;

export type Statement =
  | SayStatement
  | SetStatement
  | VarDeclaration
  | ChangeStatement
  | CompoundAssignStatement
  | FunctionDeclaration
  | CallStatement
  | ReturnStatement
  | IfStatement
  | RepeatStatement;

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
  paramType: string;
  name: string;
  label: string | null;  // null for first param; non-null for each subsequent param
}

export interface FunctionDeclaration {
  type: 'FunctionDeclaration';
  name: string;
  params: FunctionParam[];
  returnType: 'number' | 'string' | 'boolean' | null;  // null = void
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
  operator: 'not';
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
  | { type: 'RepeatStatement'; kind: 'while'; condition: Expression; body: Statement[] };
