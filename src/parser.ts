import { Token, TokenType } from './lexer';
import {
  Program, Statement, Expression,
  SayStatement, SetStatement, FunctionDeclaration, FunctionParam,
  CallStatement, ReturnStatement,
  BinaryExpression, UnaryExpression, IdentifierExpression,
  NumberLiteral, StringLiteral, BooleanLiteral, ItExpression,
  IfStatement, IfBranch, RepeatStatement,
  VarDeclaration, ChangeStatement, CompoundAssignStatement,
} from './ast';

export class ParseError extends Error {
  constructor(message: string, public token: Token) {
    super(message);
    this.name = 'ParseError';
  }
}

// Keywords that may NOT be used as a named-argument label in a call statement
// OR as a parameter separator label / body name in a function declaration.
// These start new statements or form expression operators.
const NAMED_ARG_STOP_KEYWORDS = new Set([
  'and', 'or', 'not', 'if', 'else', 'end',
  'true', 'false', 'is', 'say', 'set', 'function', 'takes', 'return',
  'repeat', 'times', 'while',
  'less', 'greater', 'than', 'at', 'least', 'most', 'equal',
  'var', 'change', 'add', 'subtract', 'multiply', 'divide', 'by',
]);

export function parse(tokens: Token[]): Program {
  let pos = 0;

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
        `Expected ${type}${value ? ` '${value}'` : ''} but got ${tok.type} '${tok.value}' at line ${tok.line}`,
        tok,
      );
    }
    if (value !== undefined && tok.value !== value) {
      throw new ParseError(
        `Expected '${value}' but got '${tok.value}' at line ${tok.line}`,
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
    while (peek().type !== 'EOF') {
      if (peek().type === 'NEWLINE') { advance(); continue; }
      body.push(parseStatement());
    }
    return { type: 'Program', body };
  }

  function parseStatement(): Statement {
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
        case 'function': return parseFunctionDeclaration();
        case 'return':   return parseReturnStatement();
        case 'if':       return parseIfStatement();
        case 'repeat':   return parseRepeatStatement();
        default:
          throw new ParseError(`Unexpected keyword '${tok.value}' at line ${tok.line}`, tok);
      }
    }
    if (tok.type === 'IDENT') {
      return parseCallStatement();
    }
    throw new ParseError(
      `Expected statement at line ${tok.line}, got ${tok.type} '${tok.value}'`,
      tok,
    );
  }

  function parseSayStatement(): SayStatement {
    consume('KEYWORD', 'say');
    const expression = parseExpression();
    consumeNewline();
    return { type: 'SayStatement', expression };
  }

  function parseSetStatement(): SetStatement {
    consume('KEYWORD', 'set');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'to');
    const value = parseExpression();
    consumeNewline();
    return { type: 'SetStatement', name: nameTok.value, value };
  }

  function parseVarDeclaration(): VarDeclaration {
    consume('KEYWORD', 'var');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'is');
    const value = parseExpression();
    consumeNewline();
    return { type: 'VarDeclaration', name: nameTok.value, value };
  }

  function parseChangeStatement(): ChangeStatement {
    consume('KEYWORD', 'change');
    const nameTok = consume('IDENT');
    consume('KEYWORD', 'to');
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

  function parseFunctionDeclaration(): FunctionDeclaration {
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
            `Cannot use reserved keyword '${tok.value}' as parameter name at line ${tok.line}`,
            tok,
          );
        }
        advance();
        return tok;
      }
      throw new ParseError(
        `Expected parameter name at line ${tok.line}, got ${tok.type} '${tok.value}'`,
        tok,
      );
    };

    const params: FunctionParam[] = [];

    // Reject the legacy paren form with an explicit error mentioning `takes`.
    if (peek().type === 'LPAREN') {
      throw new ParseError(
        `Function parameters use the 'takes' form now; parentheses are no longer allowed (line ${peek().line})`,
        peek(),
      );
    }

    if (peek().type === 'KEYWORD' && peek().value === 'takes') {
      advance(); // consume `takes`

      // First param: TYPE IDENT, no label.
      const t0 = consume('TYPE');
      const n0 = consumeParamBodyName();
      params.push({ paramType: t0.value, name: n0.value, label: null });

      // Subsequent params: LABEL TYPE IDENT
      while (true) {
        const next = peek();
        // Stop at `is` (start of body).
        if (next.type === 'KEYWORD' && next.value === 'is') break;
        if (!isValidParamWord(next)) {
          // Produce a targeted error for stop keywords used where a label is expected.
          if (next.type === 'KEYWORD' && NAMED_ARG_STOP_KEYWORDS.has(next.value)) {
            throw new ParseError(
              `Cannot use reserved keyword '${next.value}' as a parameter label at line ${next.line}`,
              next,
            );
          }
          throw new ParseError(
            `Expected parameter label or 'is' at line ${next.line}, got ${next.type} '${next.value}'`,
            next,
          );
        }
        const labelTok = advance();
        const tN = consume('TYPE');
        const nN = consumeParamBodyName();
        params.push({ paramType: tN.value, name: nN.value, label: labelTok.value });
      }
    }

    // Enforce body-name uniqueness.
    const seen = new Set<string>();
    for (const p of params) {
      if (seen.has(p.name)) {
        throw new ParseError(
          `Duplicate parameter name '${p.name}' in function '${nameTok.value}' at line ${nameTok.line}`,
          nameTok,
        );
      }
      seen.add(p.name);
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
    // Optional `end function` qualifier
    if (peek().type === 'KEYWORD' && peek().value === 'function') {
      advance();
    }
    consumeNewline();

    return { type: 'FunctionDeclaration', name: nameTok.value, params, body };
  }

  function parseReturnStatement(): ReturnStatement {
    consume('KEYWORD', 'return');
    const value = parseExpression();
    consumeNewline();
    return { type: 'ReturnStatement', value };
  }

  function parseCallStatement(): CallStatement {
    const nameTok = consume('IDENT');
    const args: Array<{ name: string | null; value: Expression }> = [];

    // First positional arg (optional): NUMBER, STRING, IDENT, or parenthesised expr.
    // Boolean literals (true/false) are also allowed as positional args.
    const first = peek();
    const isBoolKw = first.type === 'KEYWORD' && (first.value === 'true' || first.value === 'false');
    if (
      first.type === 'NUMBER' ||
      first.type === 'STRING' ||
      first.type === 'IDENT' ||
      first.type === 'LPAREN' ||
      isBoolKw
    ) {
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
    // Optional `end if` qualifier
    if (peek().type === 'KEYWORD' && peek().value === 'if') {
      advance();
    }
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
          `Expected loop variable name at line ${varTok.line}, got ${varTok.type} '${varTok.value}'`,
          varTok,
        );
      }
      advance();
      consume('KEYWORD', 'from');
      const fromExpr = parseExpression();
      consume('KEYWORD', 'to');
      const toExpr = parseExpression();
      result = {
        type: 'RepeatStatement',
        kind: 'range',
        varName: varTok.value,
        from: fromExpr,
        to: toExpr,
        body: [],
      };
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
    if (peek().type === 'KEYWORD' && peek().value === 'repeat') {
      advance();
    }
    consumeNewline();

    result.body = body;
    return result;
  }

  // --- Expression parsing with precedence ---

  function parseExpression(): Expression {
    return parseLogical();
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
          `Mixing 'and' and 'or' requires parentheses at line ${peek().line}`,
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
    let left = parseAdditive();
    // `is` and `is not` replace `==` and `!=`. `is` is a KEYWORD.
    // Ambiguity with `is` as function-body opener is resolved structurally:
    // function decls consume their `is` before the NEWLINE, so here we only
    // encounter `is` mid-expression.
    while (peek().type === 'KEYWORD' && peek().value === 'is') {
      advance(); // consume `is`
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
            `Expected 'least' or 'most' after 'is at' at line ${after.line}, got ${after.type} '${after.value}'`,
            after,
          );
        }
      }
      const right = parseAdditive();
      left = { type: 'BinaryExpression', operator: op, left, right } as BinaryExpression;
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
    while (peek().type === 'OP' && (peek().value === '*' || peek().value === '/')) {
      const op = advance().value;
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

    if (tok.type === 'NUMBER') {
      advance();
      return { type: 'NumberLiteral', value: parseInt(tok.value, 10) } as NumberLiteral;
    }

    if (tok.type === 'STRING') {
      advance();
      return { type: 'StringLiteral', value: tok.value } as StringLiteral;
    }

    if (tok.type === 'IDENT') {
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
          `Unexpected keyword '${tok.value}' in expression at line ${tok.line}`,
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
      `Expected expression at line ${tok.line}, got ${tok.type} '${tok.value}'`,
      tok,
    );
  }

  return parseProgram();
}
