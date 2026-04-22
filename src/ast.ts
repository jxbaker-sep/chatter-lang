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
  | FunctionDeclaration
  | CallStatement
  | ReturnStatement
  | IfStatement;

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

export interface FunctionDeclaration {
  type: 'FunctionDeclaration';
  name: string;
  params: Array<{ paramType: string; name: string }>;
  body: Statement[];
}

export interface CallStatement {
  type: 'CallStatement';
  name: string;
  args: Array<{ name: string | null; value: Expression }>;
}

export interface ReturnStatement {
  type: 'ReturnStatement';
  value: Expression;
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
