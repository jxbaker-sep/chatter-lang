import { Token, TokenType } from './lexer';
import { ChatterError, SourceLocation } from './errors';
import {
  Program, Statement, Expression,
  SayStatement, SetStatement, FunctionDeclaration, FunctionParam,
  CallStatement, ReturnStatement,
  BinaryExpression, UnaryExpression, IdentifierExpression,
  NumberLiteral, StringLiteral, BooleanLiteral, ItExpression,
  IfStatement, IfBranch, RepeatStatement,
  VarDeclaration, ChangeStatement, ChangeItemStatement, CompoundAssignStatement,
  ListLiteral, ItemAccessExpression, LastItemExpression,
  LengthExpression, AppendStatement, PrependStatement, InsertStatement,
  RemoveItemStatement, RemoveValueStatement, UniqueListLiteral,
  TypeAnnotation, ScalarTypeName,
  CharacterAccessExpression, LastCharacterExpression,
  SubstringExpression,
  EndIndexSentinel,
  ReadFileLinesExpression, ReadFileStatement,
  ExpectStatement, UseStatement,
  ExitRepeatStatement, NextRepeatStatement,
} from './ast';

function locOfToken(t: Token): SourceLocation {
  return { line: t.line, col: t.col, length: Math.max(1, t.value.length), file: t.file };
}

export class ParseError extends ChatterError {
  constructor(message: string, public token: Token) {
    super(message, locOfToken(token));
    this.name = 'ParseError';
  }
}

// Keywords that may NOT be used as a named-argument label in a call statement
// OR as a parameter separator label / body name in a function declaration.
// These start new statements or form expression operators.
const NAMED_ARG_STOP_KEYWORDS = new Set([
  'and', 'or', 'not', 'if', 'else', 'end',
  'true', 'false', 'is', 'say', 'set', 'function', 'takes', 'returns', 'return',
  'repeat', 'times', 'while', 'exit', 'next',
  'less', 'greater', 'than', 'at', 'least', 'most', 'equal',
  'var', 'change', 'add', 'subtract', 'multiply', 'divide', 'by', 'mod',
  'list', 'of', 'readonly', 'empty', 'unique',
  'item', 'last', 'length', 'contains',
  'append', 'prepend', 'insert', 'remove',
  'character', 'characters',
  'expect',
  'use', 'export',
]);

// Keywords that legally begin an expression (see parsePrimary / parseLogicalNot).
const EXPRESSION_START_KEYWORDS = new Set([
  'true', 'false',
  'not',
  'last',
  'length',
  'item',
  'character', 'characters',
  'empty',
  'list',
  'unique',
  'lines',
]);

function canStartExpression(tok: Token): boolean {
  if (tok.type === 'NUMBER' || tok.type === 'STRING' || tok.type === 'IDENT' || tok.type === 'LPAREN') {
    return true;
  }
  if (tok.type === 'OP' && tok.value === '-') return true;
  if (tok.type === 'KEYWORD' && EXPRESSION_START_KEYWORDS.has(tok.value)) return true;
  return false;
}

export function parse(tokens: Token[], source?: string): Program {
  let pos = 0;
  let indexSlotDepth = 0;
  const sourceLines: string[] | null = source !== undefined ? source.split('\n') : null;

  function tokenEndCol(t: Token): number {
    if (t.type === 'STRING') return t.col + t.value.length + 2;
    return t.col + t.value.length;
  }

  function peek(): Token {
    return tokens[pos];
  }

  function advance(): Token {
    return tokens[pos++];
  }

  function consume(type: TokenType, value?: string): Token {
    const tok = peek();
    if (tok.type !== type) {
      throw new ParseError(
        `Expected ${type}${value ? ` '${value}'` : ''} but got ${tok.type} '${tok.value}'`,
        tok,
      );
    }
    if (value !== undefined && tok.value !== value) {
      throw new ParseError(
        `Expected '${value}' but got '${tok.value}'`,
        tok,
      );
    }
    return advance();
  }

  function consumeNewline(): void {
    consume('NEWLINE');
  }

  function parseProgram(): Program {
    const body: Statement[] = [];
    let seenNonUse = false;
    while (peek().type !== 'EOF') {
      if (peek().type === 'NEWLINE') { advance(); continue; }
      const tok = peek();
      const isUse = tok.type === 'KEYWORD' && tok.value === 'use';
      if (isUse && seenNonUse) {
        throw new ParseError(
          `'use' statements must appear before any other statement`,
          tok,
        );
      }
      const stmt = parseStatement();
      if (stmt.type !== 'UseStatement') seenNonUse = true;
      body.push(stmt);
    }
    return { type: 'Program', body };
  }

  function withLoc<T extends object>(node: T, tok: Token): T {
    (node as any).line = tok.line;
    (node as any).col = tok.col;
    (node as any).length = Math.max(1, tok.value.length);
    (node as any).file = tok.file;
    return node;
  }

  function parseStatement(): Statement {
    const startTok = peek();
    const stmt = parseStatementInner();
    if ((stmt as any).line === undefined) withLoc(stmt, startTok);
    return stmt;
  }

  function parseStatementInner(): Statement {
    const tok = peek();
    if (tok.type === 'KEYWORD') {
      switch (tok.value) {
        case 'say':      return parseSayStatement();
        case 'set':      return parseSetStatement();
        case 'var':      return parseVarDeclaration();
        case 'change':   return parseChangeStatement();
        case 'add':      return parseAddStatement();
        case 'subtract': return parseSubtractStatement();
        case 'multiply': return parseMultiplyStatement();
        case 'divide':   return parseDivideStatement();
        case 'function': return parseFunctionDeclaration(false);
        case 'export':   return parseExportStatement();
        case 'use':      return parseUseStatement();
        case 'return':   return parseReturnStatement();
        case 'if':       return parseIfStatement();
        case 'repeat':   return parseRepeatStatement();
        case 'append':   return parseAppendStatement();
        case 'prepend':  return parsePrependStatement();
        case 'insert':   return parseInsertStatement();
        case 'remove':   return parseRemoveStatement();
        case 'read':     return parseReadFileStatement();
        case 'expect':   return parseExpectStatement();
        case 'exit':     return parseExitRepeatStatement();
        case 'next':     return parseNextRepeatStatement();
        default:
          throw new ParseError(`Unexpected keyword '${tok.value}'`, tok);
      }
    }
    if (tok.type === 'IDENT') {
      return parseCallStatement();
    }
    throw new ParseError(
      `Expected statement, got ${tok.type} '${tok.value}'`,
      tok,
    );
  }

  function parseSayStatement(): SayStatement {
    consume('KEYWORD', 'say');
    if (peek().type === 'NEWLINE' || peek().type === 'EOF') {
      throw new ParseError('say requires at least one expression', peek());
    }
    const expressions: Expression[] = [parseExpression()];
    while (peek().type === 'COMMA') {
      consume('COMMA');
      if (peek().type === 'NEWLINE' || peek().type === 'EOF') {
        throw new ParseError(
          "Expected expression after ',' in say statement",
          peek(),
        );
      }
      expressions.push(parseExpression());
    }
    consumeNewline();
    return { type: 'SayStatement', expressions };
  }

  function parseExpectStatement(): ExpectStatement {
    consume('KEYWORD', 'expect');
    const startTok = peek();
    let expression = parseExpression();

    // Optional `to be ...` / `to not be ...` sugar that builds the same AST
    // as the `is`-form. `be` is NOT a reserved keyword; parsed contextually
    // after `to` (or after `to not`).
    if (peek().type === 'KEYWORD' && peek().value === 'to') {
      const t1 = tokens[pos + 1];
      const t2 = tokens[pos + 2];
      if (t1?.type === 'IDENT' && t1.value === 'be') {
        advance(); // consume `to`
        advance(); // consume `be`
        expression = parseToBeTail(expression, /*negated*/ false);
      } else if (t1?.type === 'KEYWORD' && t1.value === 'not'
          && t2?.type === 'IDENT' && t2.value === 'be') {
        advance(); // consume `to`
        advance(); // consume `not`
        advance(); // consume `be`
        // `to not be empty` → `not (left is empty)`
        if (peek().type === 'KEYWORD' && peek().value === 'empty') {
          advance();
          const empty = { type: 'IsEmptyExpression', target: expression } as any;
          expression = { type: 'UnaryExpression', operator: 'not', operand: empty } as UnaryExpression;
        } else {
          // `to not be Y` → `left != right`
          const right = parseConcat();
          expression = { type: 'BinaryExpression', operator: '!=', left: expression, right } as BinaryExpression;
        }
      }
    }

    const endTok = tokens[pos - 1];
    let snippet: string;
    if (sourceLines && startTok.line === endTok.line && startTok.line >= 1 && startTok.line <= sourceLines.length) {
      const line = sourceLines[startTok.line - 1];
      snippet = line.substring(startTok.col, tokenEndCol(endTok));
    } else {
      const parts: string[] = [];
      for (let i = tokens.indexOf(startTok); i < pos; i++) {
        const t = tokens[i];
        if (t.type === 'NEWLINE' || t.type === 'INDENT' || t.type === 'DEDENT' || t.type === 'EOF') continue;
        parts.push(t.type === 'STRING' ? `"${t.value}"` : t.value);
      }
      snippet = parts.join(' ');
    }

    // Optional `, MSG_EXPR` trailing message clause.
    let message: Expression | undefined;
    if (peek().type === 'COMMA') {
      advance();
      message = parseExpression();
    }

    consumeNewline();
    return { type: 'ExpectStatement', expression, source: snippet, message };
  }

  // Parse the tail after `to be`, returning a comparison/char-class AST node
  // against `left`. Supports:
  //   to be Y                         (==)
  //   to not be Y                     (!=)   -- note: `not` appears before `be`
  //   to be less than Y               (<)
  //   to be greater than Y            (>)
  //   to be at least Y                (>=)
  //   to be at most Y                 (<=)
  //   to be a digit / a letter
  //   to be whitespace
  //
  // Called with the `to` and `be` already consumed (for the positive forms).
  // The `to not be` form is handled here too, re-routed before consuming `be`.
  function parseToBeTail(left: Expression, _negated: boolean): Expression {
    // `to be empty` — emptiness predicate (polymorphic over strings and lists).
    {
      const n0 = peek();
      if (n0.type === 'KEYWORD' && n0.value === 'empty') {
        advance();
        return { type: 'IsEmptyExpression', target: left } as any;
      }
    }
    // Char-class predicates: `a digit`, `a letter`, `whitespace`
    {
      const n0 = peek();
      const n1 = tokens[pos + 1];
      if (n0.type === 'IDENT' && n0.value === 'a'
          && n1?.type === 'IDENT' && (n1.value === 'digit' || n1.value === 'letter')) {
        advance(); advance();
        const klass = n1.value as 'digit' | 'letter';
        return { type: 'IsCharClassExpression', target: left, charClass: klass } as any;
      }
      if (n0.type === 'IDENT' && n0.value === 'whitespace') {
        advance();
        return { type: 'IsCharClassExpression', target: left, charClass: 'whitespace' } as any;
      }
    }

    // Comparison modifiers (parallel to the `is`-form handling in parseEquality).
    let op: '==' | '!=' | '<' | '<=' | '>' | '>=' = '==';
    const next = peek();
    if (next.type === 'KEYWORD' && next.value === 'less') {
      advance();
      consume('KEYWORD', 'than');
      op = '<';
    } else if (next.type === 'KEYWORD' && next.value === 'greater') {
      advance();
      consume('KEYWORD', 'than');
      op = '>';
    } else if (next.type === 'KEYWORD' && next.value === 'at') {
      advance();
      const after = peek();
      if (after.type === 'KEYWORD' && after.value === 'least') {
        advance();
        op = '>=';
      } else if (after.type === 'KEYWORD' && after.value === 'most') {
        advance();
        op = '<=';
      } else {
        throw new ParseError(
          `Expected 'least' or 'most' after 'to be at', got ${after.type} '${after.value}'`,
          after,
        );
      }
    }
    const right = parseConcat();
    return { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
  }

  function tryConsumeTheResultOf(): CallStatement | null {
    const t0 = tokens[pos];
    const t1 = tokens[pos + 1];
    const t2 = tokens[pos + 2];
    if (
      t0 && t0.type === 'IDENT' && t0.value === 'the' &&
      t1 && t1.type === 'IDENT' && t1.value === 'result' &&
      t2 && t2.type === 'KEYWORD' && t2.value === 'of'
    ) {
      advance(); advance(); advance();
      return parseCallStatement();
    }
    return null;
  }

  function parseSetStatement(): SetStatement {
    consume('KEYWORD', 'set');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'to');
    const precall = tryConsumeTheResultOf();
    if (precall) {
      const itExpr: Expression = { type: 'ItExpression' };
      return { type: 'SetStatement', name: nameTok.value, value: itExpr, precall };
    }
    const value = parseExpression();
    consumeNewline();
    return { type: 'SetStatement', name: nameTok.value, value };
  }

  function parseVarDeclaration(): VarDeclaration {
    consume('KEYWORD', 'var');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'is');
    const precall = tryConsumeTheResultOf();
    if (precall) {
      const itExpr: Expression = { type: 'ItExpression' };
      return { type: 'VarDeclaration', name: nameTok.value, value: itExpr, precall };
    }
    const value = parseExpression();
    consumeNewline();
    return { type: 'VarDeclaration', name: nameTok.value, value };
  }

  function parseChangeStatement(): ChangeStatement | ChangeItemStatement {
    consume('KEYWORD', 'change');
    // `change item EXPR of IDENT to EXPR` — list element assignment
    if (peek().type === 'KEYWORD' && peek().value === 'item') {
      advance(); // item
      const index = parseExpression();
      consume('KEYWORD', 'of');
      const nameTok = consume('IDENT');
      consume('KEYWORD', 'to');
      const value = parseExpression();
      consumeNewline();
      return { type: 'ChangeItemStatement', listName: nameTok.value, index, value };
    }
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'to');
    const precall = tryConsumeTheResultOf();
    if (precall) {
      const itExpr: Expression = { type: 'ItExpression' };
      return { type: 'ChangeStatement', name: nameTok.value, value: itExpr, precall };
    }
    const value = parseExpression();
    consumeNewline();
    return { type: 'ChangeStatement', name: nameTok.value, value };
  }

  function parseAddStatement(): CompoundAssignStatement {
    consume('KEYWORD', 'add');
    const value = parseExpression();
    consume('KEYWORD', 'to');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'CompoundAssignStatement', op: 'add', name: nameTok.value, value };
  }

  function parseSubtractStatement(): CompoundAssignStatement {
    consume('KEYWORD', 'subtract');
    const value = parseExpression();
    consume('KEYWORD', 'from');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'CompoundAssignStatement', op: 'subtract', name: nameTok.value, value };
  }

  function parseMultiplyStatement(): CompoundAssignStatement {
    consume('KEYWORD', 'multiply');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'by');
    const value = parseExpression();
    consumeNewline();
    return { type: 'CompoundAssignStatement', op: 'multiply', name: nameTok.value, value };
  }

  function parseDivideStatement(): CompoundAssignStatement {
    consume('KEYWORD', 'divide');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'by');
    const value = parseExpression();
    consumeNewline();
    return { type: 'CompoundAssignStatement', op: 'divide', name: nameTok.value, value };
  }

  function parseTypeAnnotation(allowReadonly: boolean): TypeAnnotation {
    const tok = peek();
    if (tok.type === 'KEYWORD' && tok.value === 'readonly') {
      if (!allowReadonly) {
        throw new ParseError(
          `'readonly' is only allowed in parameter type annotations`,
          tok,
        );
      }
      advance();
      // Reject `readonly unique list of …` — readonly unique list is not supported in v1.
      if (peek().type === 'KEYWORD' && peek().value === 'unique') {
        throw new ParseError(
          `'readonly unique list of T' is not supported`,
          peek(),
        );
      }
      // must be followed by `list of TYPE`
      if (!(peek().type === 'KEYWORD' && peek().value === 'list')) {
        throw new ParseError(
          `'readonly' must be followed by 'list of TYPE'`,
          peek(),
        );
      }
      advance(); // list
      consume('KEYWORD', 'of');
      const inner = parseTypeAnnotation(false);
      if (inner.kind !== 'scalar') {
        throw new ParseError(`nested lists not supported`, tok);
      }
      return { kind: 'list', element: inner.name, readonly: true };
    }
    if (tok.type === 'KEYWORD' && tok.value === 'unique') {
      advance();
      consume('KEYWORD', 'list');
      consume('KEYWORD', 'of');
      const inner = parseTypeAnnotation(false);
      if (inner.kind !== 'scalar') {
        throw new ParseError(`nested lists not supported`, tok);
      }
      return { kind: 'uniqueList', element: inner.name, readonly: false };
    }
    if (tok.type === 'KEYWORD' && tok.value === 'list') {
      advance();
      consume('KEYWORD', 'of');
      const inner = parseTypeAnnotation(false);
      if (inner.kind !== 'scalar') {
        throw new ParseError(`nested lists not supported`, tok);
      }
      return { kind: 'list', element: inner.name, readonly: false };
    }
    if (tok.type === 'TYPE') {
      advance();
      if (tok.value !== 'number' && tok.value !== 'string' && tok.value !== 'boolean') {
        throw new ParseError(`Invalid type '${tok.value}'`, tok);
      }
      return { kind: 'scalar', name: tok.value as ScalarTypeName };
    }
    throw new ParseError(
      `Expected type annotation, got ${tok.type} '${tok.value}'`,
      tok,
    );
  }

  function parseFunctionDeclaration(exported: boolean): FunctionDeclaration {
    consume('KEYWORD', 'function');
    const nameTok = consume('IDENT');

    // A valid label / body-name token is IDENT or a non-stop KEYWORD.
    const isValidParamWord = (tok: Token): boolean => {
      if (tok.type === 'IDENT') return true;
      if (tok.type === 'KEYWORD' && !NAMED_ARG_STOP_KEYWORDS.has(tok.value)) return true;
      return false;
    };

    const consumeParamBodyName = (): Token => {
      const tok = peek();
      if (tok.type === 'IDENT') { advance(); return tok; }
      if (tok.type === 'KEYWORD') {
        if (NAMED_ARG_STOP_KEYWORDS.has(tok.value)) {
          throw new ParseError(
            `Cannot use reserved keyword '${tok.value}' as parameter name`,
            tok,
          );
        }
        advance();
        return tok;
      }
      throw new ParseError(
        `Expected parameter name, got ${tok.type} '${tok.value}'`,
        tok,
      );
    };

    const params: FunctionParam[] = [];

    // Reject the legacy paren form with an explicit error mentioning `takes`.
    if (peek().type === 'LPAREN') {
      throw new ParseError(
        `Function parameters use the 'takes' form now; parentheses are no longer allowed`,
        peek(),
      );
    }

    if (peek().type === 'KEYWORD' && peek().value === 'takes') {
      advance(); // consume `takes`

      // First param: TYPE IDENT, no label.
      const t0 = parseTypeAnnotation(true);
      const n0 = consumeParamBodyName();
      params.push({ paramType: t0, name: n0.value, label: null });

      // Subsequent params: LABEL TYPE IDENT
      while (true) {
        const next = peek();
        // Stop at `is` (start of body) or `returns` (return-type clause).
        if (next.type === 'KEYWORD' && (next.value === 'is' || next.value === 'returns')) break;
        if (!isValidParamWord(next)) {
          // Produce a targeted error for stop keywords used where a label is expected.
          if (next.type === 'KEYWORD' && NAMED_ARG_STOP_KEYWORDS.has(next.value)) {
            throw new ParseError(
              `Cannot use reserved keyword '${next.value}' as a parameter label`,
              next,
            );
          }
          throw new ParseError(
            `Expected parameter label or 'is', got ${next.type} '${next.value}'`,
            next,
          );
        }
        const labelTok = advance();
        const tN = parseTypeAnnotation(true);
        const nN = consumeParamBodyName();
        params.push({ paramType: tN, name: nN.value, label: labelTok.value });
      }
    }

    // Enforce body-name uniqueness.
    const seen = new Set<string>();
    for (const p of params) {
      if (seen.has(p.name)) {
        throw new ParseError(
          `Duplicate parameter name '${p.name}' in function '${nameTok.value}'`,
          nameTok,
        );
      }
      seen.add(p.name);
    }

    // Optional `returns TYPE` clause (before `is`).
    let returnType: TypeAnnotation | null = null;
    if (peek().type === 'KEYWORD' && peek().value === 'returns') {
      advance();
      returnType = parseTypeAnnotation(false);
    }

    consume('KEYWORD', 'is');
    consumeNewline();
    consume('INDENT');

    const body: Statement[] = [];
    while (peek().type !== 'DEDENT' && peek().type !== 'EOF') {
      if (peek().type === 'NEWLINE') { advance(); continue; }
      body.push(parseStatement());
    }

    consume('DEDENT');
    consume('KEYWORD', 'end');
    consume('KEYWORD', 'function');
    consumeNewline();

    return { type: 'FunctionDeclaration', name: nameTok.value, params, returnType, body, exported };
  }

  function parseExportStatement(): FunctionDeclaration {
    const exportTok = consume('KEYWORD', 'export');
    if (peek().type !== 'KEYWORD' || peek().value !== 'function') {
      throw new ParseError(
        `'export' must be followed by 'function'`,
        peek(),
      );
    }
    const fn = parseFunctionDeclaration(true);
    (fn as any).line = exportTok.line;
    (fn as any).col = exportTok.col;
    (fn as any).length = Math.max(1, exportTok.value.length);
    (fn as any).file = exportTok.file;
    return fn;
  }

  function parseUseStatement(): UseStatement {
    const useTok = consume('KEYWORD', 'use');
    const names: string[] = [];
    const nameLocs: Array<{ line: number; col: number; length: number; file?: string }> = [];
    const firstName = consume('IDENT');
    names.push(firstName.value);
    nameLocs.push({ line: firstName.line, col: firstName.col, length: firstName.value.length, file: firstName.file });
    while (peek().type === 'COMMA') {
      consume('COMMA');
      const n = consume('IDENT');
      names.push(n.value);
      nameLocs.push({ line: n.line, col: n.col, length: n.value.length, file: n.file });
    }
    const seen = new Set<string>();
    for (let i = 0; i < names.length; i++) {
      if (seen.has(names[i])) {
        throw new ChatterError(
          `duplicate name '${names[i]}' in use statement`,
          { line: nameLocs[i].line, col: nameLocs[i].col, length: nameLocs[i].length, file: nameLocs[i].file },
        );
      }
      seen.add(names[i]);
    }
    consume('KEYWORD', 'from');
    const pathTok = consume('STRING');
    consumeNewline();
    const node: UseStatement = {
      type: 'UseStatement',
      names,
      path: pathTok.value,
      nameLocs,
      pathLoc: { line: pathTok.line, col: pathTok.col, length: pathTok.value.length + 2, file: pathTok.file },
    };
    (node as any).line = useTok.line;
    (node as any).col = useTok.col;
    (node as any).length = Math.max(1, useTok.value.length);
    (node as any).file = useTok.file;
    return node;
  }

  function parseReturnStatement(): ReturnStatement {
    consume('KEYWORD', 'return');
    if (peek().type === 'NEWLINE') {
      advance();
      return { type: 'ReturnStatement', value: null };
    }
    const precall = tryConsumeTheResultOf();
    if (precall) {
      const itExpr: Expression = { type: 'ItExpression' };
      return { type: 'ReturnStatement', value: itExpr, precall };
    }
    const value = parseExpression();
    consumeNewline();
    return { type: 'ReturnStatement', value };
  }

  function parseExitRepeatStatement(): ExitRepeatStatement {
    const exitTok = consume('KEYWORD', 'exit');
    const nextTok = peek();
    if (nextTok.type !== 'KEYWORD' || nextTok.value !== 'repeat') {
      throw new ParseError(
        `expected 'repeat' after 'exit', got ${nextTok.type} '${nextTok.value}'`,
        nextTok,
      );
    }
    advance();
    consumeNewline();
    const stmt: ExitRepeatStatement = { type: 'ExitRepeatStatement' };
    withLoc(stmt, exitTok);
    return stmt;
  }

  function parseNextRepeatStatement(): NextRepeatStatement {
    const nextKwTok = consume('KEYWORD', 'next');
    const after = peek();
    if (after.type !== 'KEYWORD' || after.value !== 'repeat') {
      throw new ParseError(
        `expected 'repeat' after 'next', got ${after.type} '${after.value}'`,
        after,
      );
    }
    advance();
    consumeNewline();
    const stmt: NextRepeatStatement = { type: 'NextRepeatStatement' };
    withLoc(stmt, nextKwTok);
    return stmt;
  }

  function parseCallStatement(): CallStatement {
    const nameTok = consume('IDENT');
    const args: Array<{ name: string | null; value: Expression }> = [];

    // First positional arg (optional): anything that can start an expression.
    if (canStartExpression(peek())) {
      args.push({ name: null, value: parseExpression() });
    }

    // Named args: (IDENT | allowed KEYWORD) followed by an expression.
    while (true) {
      const tok = peek();
      if (tok.type === 'IDENT') {
        const paramName = advance().value;
        const value = parseExpression();
        args.push({ name: paramName, value });
        continue;
      }
      if (tok.type === 'KEYWORD' && !NAMED_ARG_STOP_KEYWORDS.has(tok.value)) {
        const paramName = advance().value;
        const value = parseExpression();
        args.push({ name: paramName, value });
        continue;
      }
      break;
    }

    consumeNewline();
    return { type: 'CallStatement', name: nameTok.value, args };
  }

  function parseIfStatement(): IfStatement {
    consume('KEYWORD', 'if');
    const firstCond = parseExpression();
    consumeNewline();
    consume('INDENT');
    const firstBody = parseBlock();
    consume('DEDENT');

    const branches: IfBranch[] = [{ condition: firstCond, body: firstBody }];
    let elseBody: Statement[] | null = null;

    // Handle `else if` (chained) and a final `else`.
    while (peek().type === 'KEYWORD' && peek().value === 'else') {
      // Peek past `else` to see if it's `else if`
      const next = tokens[pos + 1];
      if (next && next.type === 'KEYWORD' && next.value === 'if') {
        advance(); // else
        advance(); // if
        const cond = parseExpression();
        consumeNewline();
        consume('INDENT');
        const body = parseBlock();
        consume('DEDENT');
        branches.push({ condition: cond, body });
        continue;
      }
      // plain else
      advance();
      consumeNewline();
      consume('INDENT');
      elseBody = parseBlock();
      consume('DEDENT');
      break;
    }

    consume('KEYWORD', 'end');
    consume('KEYWORD', 'if');
    consumeNewline();

    return { type: 'IfStatement', branches, elseBody };
  }

  function parseBlock(): Statement[] {
    const stmts: Statement[] = [];
    while (peek().type !== 'DEDENT' && peek().type !== 'EOF') {
      if (peek().type === 'NEWLINE') { advance(); continue; }
      stmts.push(parseStatement());
    }
    return stmts;
  }

  function parseRepeatStatement(): RepeatStatement {
    consume('KEYWORD', 'repeat');
    const next = peek();

    let result: RepeatStatement;

    if (next.type === 'KEYWORD' && next.value === 'with') {
      advance();
      const varTok = peek();
      if (varTok.type !== 'IDENT') {
        throw new ParseError(
          `Expected loop variable name, got ${varTok.type} '${varTok.value}'`,
          varTok,
        );
      }
      advance();
      const after = peek();
      if (after.type === 'KEYWORD' && after.value === 'in') {
        advance();
        const listExpr = parseExpression();
        result = {
          type: 'RepeatStatement',
          kind: 'list',
          varName: varTok.value,
          list: listExpr,
          body: [],
        };
      } else {
        consume('KEYWORD', 'from');
        const fromExpr = parseExpression();
        consume('KEYWORD', 'to');
        const toExpr = parseExpression();
        let stepExpr: Expression | undefined;
        if (peek().type === 'KEYWORD' && peek().value === 'by') {
          advance();
          stepExpr = parseExpression();
        }
        result = {
          type: 'RepeatStatement',
          kind: 'range',
          varName: varTok.value,
          from: fromExpr,
          to: toExpr,
          ...(stepExpr !== undefined ? { step: stepExpr } : {}),
          body: [],
        };
      }
    } else if (next.type === 'KEYWORD' && next.value === 'while') {
      advance();
      const cond = parseExpression();
      result = { type: 'RepeatStatement', kind: 'while', condition: cond, body: [] };
    } else {
      const count = parseExpression();
      consume('KEYWORD', 'times');
      result = { type: 'RepeatStatement', kind: 'times', count, body: [] };
    }

    consumeNewline();
    consume('INDENT');
    const body = parseBlock();
    consume('DEDENT');
    consume('KEYWORD', 'end');
    consume('KEYWORD', 'repeat');
    consumeNewline();

    result.body = body;
    return result;
  }

  function parseAppendStatement(): AppendStatement {
    consume('KEYWORD', 'append');
    const value = parseExpression();
    consume('KEYWORD', 'to');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'AppendStatement', listName: nameTok.value, value };
  }

  function parsePrependStatement(): PrependStatement {
    consume('KEYWORD', 'prepend');
    const value = parseExpression();
    consume('KEYWORD', 'to');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'PrependStatement', listName: nameTok.value, value };
  }

  function parseInsertStatement(): InsertStatement {
    consume('KEYWORD', 'insert');
    const value = parseExpression();
    consume('KEYWORD', 'at');
    const index = parseExpression();
    consume('KEYWORD', 'in');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'InsertStatement', listName: nameTok.value, index, value };
  }

  function parseRemoveStatement(): RemoveItemStatement | RemoveValueStatement {
    consume('KEYWORD', 'remove');
    // `remove item N from NAME` — list element-by-index removal (existing).
    // `remove EXPR from NAME` — unique-list value removal (new).
    if (peek().type === 'KEYWORD' && peek().value === 'item') {
      advance();
      const index = parseExpression();
      consume('KEYWORD', 'from');
      const nameTok = consume('IDENT');
      consumeNewline();
      return { type: 'RemoveItemStatement', listName: nameTok.value, index };
    }
    const value = parseExpression();
    consume('KEYWORD', 'from');
    const nameTok = consume('IDENT');
    consumeNewline();
    return { type: 'RemoveValueStatement', listName: nameTok.value, value };
  }

  // `read file EXPR` — sugar for reading a text file. Assigns the
  // resulting list of lines to `it`.
  function parseReadFileStatement(): ReadFileStatement {
    consume('KEYWORD', 'read');
    consume('KEYWORD', 'file');
    const path = parseExpression();
    consumeNewline();
    return { type: 'ReadFileStatement', path };
  }

  // --- Expression parsing with precedence ---

  function parseExpression(): Expression {
    const startTok = peek();
    const expr = parseLogical();
    if ((expr as any).line === undefined) withLoc(expr, startTok);
    return expr;
  }

  // Flat `and`/`or` level — no mixing without parentheses.
  function parseLogical(): Expression {
    let left = parseLogicalNot();
    let firstOp: string | null = null;
    while (peek().type === 'KEYWORD' && (peek().value === 'and' || peek().value === 'or')) {
      const op = peek().value;
      if (firstOp === null) {
        firstOp = op;
      } else if (op !== firstOp) {
        throw new ParseError(
          `Mixing 'and' and 'or' requires parentheses`,
          peek(),
        );
      }
      advance();
      const right = parseLogicalNot();
      left = { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
    }
    return left;
  }

  function parseLogicalNot(): Expression {
    if (peek().type === 'KEYWORD' && peek().value === 'not') {
      advance();
      const operand = parseLogicalNot();
      return { type: 'UnaryExpression', operator: 'not', operand } as UnaryExpression;
    }
    return parseEquality();
  }

  function parseEquality(): Expression {
    let left = parseConcat();
    while (
      (peek().type === 'KEYWORD' && peek().value === 'is') ||
      (peek().type === 'KEYWORD' && peek().value === 'contains')
    ) {
      if (peek().value === 'contains') {
        advance();
        const right = parseConcat();
        left = { type: 'BinaryExpression', operator: 'contains', left, right } as BinaryExpression;
        continue;
      }
      advance(); // consume `is`
      // `is empty` / `is not empty` — polymorphic emptiness predicate over
      // strings and lists. `empty` is a reserved keyword (from `empty list of`),
      // so this is disambiguated contextually: after `is` / `is not` it is the
      // emptiness predicate, not a list literal.
      {
        const n0 = peek();
        if (n0.type === 'KEYWORD' && n0.value === 'empty') {
          advance();
          left = { type: 'IsEmptyExpression', target: left } as any;
          continue;
        }
        if (n0.type === 'KEYWORD' && n0.value === 'not') {
          const n1 = tokens[pos + 1];
          if (n1?.type === 'KEYWORD' && n1.value === 'empty') {
            advance(); advance();
            const empty = { type: 'IsEmptyExpression', target: left } as any;
            left = { type: 'UnaryExpression', operator: 'not', operand: empty } as UnaryExpression;
            continue;
          }
        }
      }
      // Char-class predicates: `is a digit`, `is a letter`, `is whitespace`.
      // `a`, `digit`, `letter`, `whitespace` are plain identifiers (not reserved keywords);
      // we parse them contextually.
      {
        const n0 = peek();
        const n1 = tokens[pos + 1];
        // `is a digit` / `is a letter`
        if (n0.type === 'IDENT' && n0.value === 'a'
            && n1?.type === 'IDENT' && (n1.value === 'digit' || n1.value === 'letter')) {
          advance(); advance();
          const klass = n1.value as 'digit' | 'letter';
          left = { type: 'IsCharClassExpression', target: left, charClass: klass } as any;
          continue;
        }
        // `is whitespace`
        if (n0.type === 'IDENT' && n0.value === 'whitespace') {
          advance();
          left = { type: 'IsCharClassExpression', target: left, charClass: 'whitespace' } as any;
          continue;
        }
      }
      let op: '==' | '!=' | '<' | '<=' | '>' | '>=' = '==';
      const next = peek();
      if (next.type === 'KEYWORD' && next.value === 'not') {
        advance();
        op = '!=';
      } else if (next.type === 'KEYWORD' && next.value === 'less') {
        advance();
        consume('KEYWORD', 'than');
        op = '<';
        if (peek().type === 'KEYWORD' && peek().value === 'or' &&
            tokens[pos + 1]?.type === 'KEYWORD' && tokens[pos + 1]?.value === 'equal') {
          advance(); advance();
          consume('KEYWORD', 'to');
          op = '<=';
        }
      } else if (next.type === 'KEYWORD' && next.value === 'greater') {
        advance();
        consume('KEYWORD', 'than');
        op = '>';
        if (peek().type === 'KEYWORD' && peek().value === 'or' &&
            tokens[pos + 1]?.type === 'KEYWORD' && tokens[pos + 1]?.value === 'equal') {
          advance(); advance();
          consume('KEYWORD', 'to');
          op = '>=';
        }
      } else if (next.type === 'KEYWORD' && next.value === 'at') {
        advance();
        const after = peek();
        if (after.type === 'KEYWORD' && after.value === 'least') {
          advance();
          op = '>=';
        } else if (after.type === 'KEYWORD' && after.value === 'most') {
          advance();
          op = '<=';
        } else {
          throw new ParseError(
            `Expected 'least' or 'most' after 'is at', got ${after.type} '${after.value}'`,
            after,
          );
        }
      }
      const right = parseConcat();
      left = { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
    }
    return left;
  }

  function parseConcat(): Expression {
    let left = parseAdditive();
    while (peek().type === 'OP' && peek().value === '&') {
      advance();
      const right = parseAdditive();
      left = { type: 'BinaryExpression', operator: '&', left, right } as BinaryExpression;
    }
    return left;
  }

  function parseAdditive(): Expression {
    let left = parseMultiplicative();
    while (peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
      const op = advance().value;
      const right = parseMultiplicative();
      left = { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
    }
    return left;
  }

  function parseMultiplicative(): Expression {
    let left = parseExponential();
    // `**` is a distinct token so peek().value === '*' only matches single `*`
    while (
      (peek().type === 'OP' && (peek().value === '*' || peek().value === '/')) ||
      (peek().type === 'KEYWORD' && peek().value === 'mod')
    ) {
      const tok = advance();
      const op = tok.value === 'mod' ? 'mod' : tok.value;
      const right = parseExponential();
      left = { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
    }
    return left;
  }

  function parseExponential(): Expression {
    let left = parsePrimary();
    while (peek().type === 'OP' && peek().value === '**') {
      advance();
      const right = parsePrimary();
      left = { type: 'BinaryExpression', operator: '**', left, right } as BinaryExpression;
    }
    return left;
  }

  function parsePrimary(): Expression {
    const tok = peek();

    // `end` as index-slot sentinel — only inside the index slot of
    // character/characters/item forms. Elsewhere, `end` remains a reserved
    // keyword (block terminator) and parsing falls through to the usual path.
    if (indexSlotDepth > 0 && tok.type === 'KEYWORD' && tok.value === 'end') {
      advance();
      return { type: 'EndIndexSentinel' } as EndIndexSentinel;
    }

    // Unary minus: `-EXPR` where EXPR is another primary.
    // Binds tighter than `**` so `-2 ** 2` is `(-2) ** 2 = 4`. Matches how
    // most people read a negative literal.
    if (tok.type === 'OP' && tok.value === '-') {
      advance();
      const operand = parsePrimary();
      return { type: 'UnaryExpression', operator: '-', operand } as UnaryExpression;
    }

    // List literals and list-read prefix forms
    if (tok.type === 'KEYWORD') {
      if (tok.value === 'unique') {
        // `unique list of EXPR (, EXPR)*` — nonempty unique-list literal.
        advance();
        consume('KEYWORD', 'list');
        consume('KEYWORD', 'of');
        if (peek().type === 'KEYWORD' &&
            (peek().value === 'list' || peek().value === 'unique' || peek().value === 'readonly')) {
          throw new ParseError(`nested lists not supported`, peek());
        }
        const elements: Expression[] = [];
        elements.push(parsePrimary());
        while (peek().type === 'COMMA') {
          advance();
          if (peek().type === 'KEYWORD' &&
              (peek().value === 'list' || peek().value === 'unique' || peek().value === 'readonly')) {
            throw new ParseError(`nested lists not supported`, peek());
          }
          elements.push(parsePrimary());
        }
        return { type: 'UniqueListLiteral', kind: 'nonempty', elementType: null, elements } as UniqueListLiteral;
      }
      if (tok.value === 'list') {
        // `list of EXPR (, EXPR)*` — nonempty list literal.
        advance();
        consume('KEYWORD', 'of');
        // Reject nested `list of list of ...`
        if (peek().type === 'KEYWORD' && (peek().value === 'list' || peek().value === 'readonly')) {
          throw new ParseError(`nested lists not supported`, peek());
        }
        const elements: Expression[] = [];
        elements.push(parsePrimary());
        while (peek().type === 'COMMA') {
          advance();
          if (peek().type === 'KEYWORD' && (peek().value === 'list' || peek().value === 'readonly')) {
            throw new ParseError(`nested lists not supported`, peek());
          }
          elements.push(parsePrimary());
        }
        return { type: 'ListLiteral', kind: 'nonempty', elementType: null, elements } as ListLiteral;
      }
      if (tok.value === 'empty') {
        advance();
        // `empty unique list of T`
        if (peek().type === 'KEYWORD' && peek().value === 'unique') {
          advance();
          consume('KEYWORD', 'list');
          consume('KEYWORD', 'of');
          const tTok = peek();
          if (tTok.type !== 'TYPE') {
            throw new ParseError(`Expected element type after 'empty unique list of'`, tTok);
          }
          advance();
          if (tTok.value === 'list' || tTok.value === 'readonly' || tTok.value === 'unique') {
            throw new ParseError(`nested lists not supported`, tTok);
          }
          return {
            type: 'UniqueListLiteral',
            kind: 'empty',
            elementType: tTok.value as ScalarTypeName,
            elements: [],
          } as UniqueListLiteral;
        }
        consume('KEYWORD', 'list');
        consume('KEYWORD', 'of');
        const tTok = peek();
        if (tTok.type !== 'TYPE') {
          throw new ParseError(`Expected element type after 'empty list of'`, tTok);
        }
        advance();
        if (tTok.value === 'list' || tTok.value === 'readonly') {
          throw new ParseError(`nested lists not supported`, tTok);
        }
        return {
          type: 'ListLiteral',
          kind: 'empty',
          elementType: tTok.value as ScalarTypeName,
          elements: [],
        } as ListLiteral;
      }
      if (tok.value === 'item') {
        advance();
        indexSlotDepth++;
        let index: Expression;
        try { index = parseExpression(); } finally { indexSlotDepth--; }
        consume('KEYWORD', 'of');
        const target = parsePrimary();
        return { type: 'ItemAccessExpression', index, target } as ItemAccessExpression;
      }
      if (tok.value === 'last') {
        advance();
        if (peek().type === 'KEYWORD' && peek().value === 'character') {
          advance();
          consume('KEYWORD', 'of');
          const target = parsePrimary();
          return { type: 'LastCharacterExpression', target } as LastCharacterExpression;
        }
        consume('KEYWORD', 'item');
        consume('KEYWORD', 'of');
        const target = parsePrimary();
        return { type: 'LastItemExpression', target } as LastItemExpression;
      }
      if (tok.value === 'length') {
        advance();
        consume('KEYWORD', 'of');
        const target = parsePrimary();
        return { type: 'LengthExpression', target } as LengthExpression;
      }
      if (tok.value === 'character') {
        // Two forms:
        //   `character N of S`     → CharacterAccessExpression (existing)
        //   `character of N`       → CharacterFromCodeExpression (new, code point → string)
        advance();
        if (peek().type === 'KEYWORD' && peek().value === 'of') {
          advance();
          const code = parsePrimary();
          return { type: 'CharacterFromCodeExpression', code } as any;
        }
        const index = (() => {
          indexSlotDepth++;
          try { return parseExpression(); } finally { indexSlotDepth--; }
        })();
        consume('KEYWORD', 'of');
        const target = parsePrimary();
        return { type: 'CharacterAccessExpression', index, target } as CharacterAccessExpression;
      }
      if (tok.value === 'characters') {
        advance();
        let from: Expression, to: Expression;
        indexSlotDepth++;
        try {
          from = parseExpression();
          consume('KEYWORD', 'to');
          to = parseExpression();
        } finally { indexSlotDepth--; }
        consume('KEYWORD', 'of');
        const target = parsePrimary();
        return { type: 'SubstringExpression', from, to, target } as SubstringExpression;
      }
      if (tok.value === 'lines') {
        // `lines of file EXPR` — read text file into a list of strings.
        advance();
        consume('KEYWORD', 'of');
        consume('KEYWORD', 'file');
        const path = parsePrimary();
        return { type: 'ReadFileLinesExpression', path } as ReadFileLinesExpression;
      }
    }

    if (tok.type === 'NUMBER') {
      advance();
      return { type: 'NumberLiteral', value: parseInt(tok.value, 10) } as NumberLiteral;
    }

    if (tok.type === 'STRING') {
      advance();
      return { type: 'StringLiteral', value: tok.value } as StringLiteral;
    }

    if (tok.type === 'IDENT') {
      // Contextual `code of EXPR` — new expression primitive (code point of a single-char string).
      // `code` is NOT a reserved keyword: only fires when followed by `of`, so user variables
      // named `code` still work.
      if (tok.value === 'code' && tokens[pos + 1]?.type === 'KEYWORD' && tokens[pos + 1]?.value === 'of') {
        advance(); // consume 'code'
        advance(); // consume 'of'
        const target = parsePrimary();
        return { type: 'CodeOfExpression', target } as any;
      }
      advance();
      if (tok.value === 'it') {
        return { type: 'ItExpression' } as ItExpression;
      }
      return { type: 'IdentifierExpression', name: tok.value } as IdentifierExpression;
    }

    // Allow keyword tokens as identifiers in expression position (e.g. param named `to`).
    // But reserved keywords (true/false/not/and/or/if/elif/else/end/is/print/set/function/return)
    // must not be consumed here — they either form their own expression shapes or end expressions.
    if (tok.type === 'KEYWORD') {
      if (tok.value === 'true' || tok.value === 'false') {
        advance();
        return { type: 'BooleanLiteral', value: tok.value === 'true' } as BooleanLiteral;
      }
      if (NAMED_ARG_STOP_KEYWORDS.has(tok.value)) {
        throw new ParseError(
          `Unexpected keyword '${tok.value}' in expression`,
          tok,
        );
      }
      advance();
      return { type: 'IdentifierExpression', name: tok.value } as IdentifierExpression;
    }

    if (tok.type === 'LPAREN') {
      advance();
      const expr = parseExpression();
      consume('RPAREN');
      return expr;
    }

    throw new ParseError(
      `Expected expression, got ${tok.type} '${tok.value}'`,
      tok,
    );
  }

  return parseProgram();
}
