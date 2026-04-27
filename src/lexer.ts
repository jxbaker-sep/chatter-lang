export type TokenType =
  | 'KEYWORD'
  | 'TYPE'
  | 'IDENT'
  | 'NUMBER'
  | 'STRING'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'OP'
  | 'NEWLINE'
  | 'INDENT'
  | 'DEDENT'
  | 'EOF'
  | 'COMMENT';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
  file?: string;
}

const KEYWORDS = new Set([
  'say', 'set', 'to', 'function', 'takes', 'returns', 'is', 'end', 'return',
  'true', 'false', 'not', 'and', 'or', 'if', 'else',
  'repeat', 'times', 'with', 'from', 'while', 'exit', 'next',
  'less', 'greater', 'than', 'at', 'least', 'most', 'equal',
  'var', 'change', 'add', 'subtract', 'multiply', 'divide', 'by', 'mod',
  'list', 'of', 'readonly', 'empty',
  'item', 'first', 'last', 'length', 'contains',
  'append', 'prepend', 'insert', 'in', 'remove',
  'character', 'characters',
  'read', 'file', 'lines',
  'expect',
  'use', 'export',
]);
const TYPES = new Set(['number', 'boolean', 'string']);

export function lex(source: string, filename?: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split('\n');
  const indentStack: number[] = [0];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // Find first non-whitespace character
    let col = 0;
    while (col < line.length && (line[col] === ' ' || line[col] === '\t')) {
      col++;
    }

    // Skip blank lines and comment lines entirely
    if (col >= line.length || line[col] === '#') continue;

    const indent = col;
    const currentIndent = indentStack[indentStack.length - 1];

    if (indent > currentIndent) {
      indentStack.push(indent);
      tokens.push({ type: 'INDENT', value: '', line: lineNum, col: 0 });
    } else if (indent < currentIndent) {
      while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
        indentStack.pop();
        tokens.push({ type: 'DEDENT', value: '', line: lineNum, col: 0 });
      }
      if (indentStack[indentStack.length - 1] !== indent) {
        throw new Error(`Inconsistent indentation at line ${lineNum}`);
      }
    }

    // Tokenize line content
    while (col < line.length) {
      // Skip inline whitespace
      if (line[col] === ' ' || line[col] === '\t') {
        col++;
        continue;
      }

      // Inline comment: ignore rest of line
      if (line[col] === '#') break;

      const startCol = col;

      // String literal
      if (line[col] === '"') {
        col++;
        let value = '';
        while (col < line.length && line[col] !== '"') {
          value += line[col++];
        }
        if (col >= line.length) {
          throw new Error(`Unterminated string literal at line ${lineNum}`);
        }
        col++; // consume closing quote
        tokens.push({ type: 'STRING', value, line: lineNum, col: startCol });
        continue;
      }

      // Number literal (digits, with optional `_` separator between digits)
      if (line[col] >= '0' && line[col] <= '9') {
        let value = '';
        while (col < line.length) {
          const c = line[col];
          if (c >= '0' && c <= '9') {
            value += c;
            col++;
          } else if (
            c === '_' &&
            value.length > 0 &&
            value[value.length - 1] !== '_' &&
            col + 1 < line.length &&
            line[col + 1] >= '0' && line[col + 1] <= '9'
          ) {
            // underscore separator: only between digits, no doubles
            col++;
          } else break;
        }
        tokens.push({ type: 'NUMBER', value, line: lineNum, col: startCol });
        continue;
      }

      // Operators: check ** before *
      if (line[col] === '*' && col + 1 < line.length && line[col + 1] === '*') {
        tokens.push({ type: 'OP', value: '**', line: lineNum, col: startCol });
        col += 2;
        continue;
      }
      if ('+-*/&'.includes(line[col])) {
        tokens.push({ type: 'OP', value: line[col], line: lineNum, col: startCol });
        col++;
        continue;
      }

      // Punctuation
      if (line[col] === '(') {
        tokens.push({ type: 'LPAREN', value: '(', line: lineNum, col: startCol });
        col++;
        continue;
      }
      if (line[col] === ')') {
        tokens.push({ type: 'RPAREN', value: ')', line: lineNum, col: startCol });
        col++;
        continue;
      }
      if (line[col] === ',') {
        tokens.push({ type: 'COMMA', value: ',', line: lineNum, col: startCol });
        col++;
        continue;
      }

      // Identifiers, keywords, types
      if (/[a-zA-Z_]/.test(line[col])) {
        let value = '';
        while (col < line.length && /[a-zA-Z0-9_]/.test(line[col])) {
          value += line[col++];
        }
        let type: TokenType;
        if (KEYWORDS.has(value)) type = 'KEYWORD';
        else if (TYPES.has(value)) type = 'TYPE';
        else type = 'IDENT';
        tokens.push({ type, value, line: lineNum, col: startCol });
        continue;
      }

      throw new Error(`Unexpected character '${line[col]}' at line ${lineNum}, col ${col + 1}`);
    }

    tokens.push({ type: 'NEWLINE', value: '\n', line: lineNum, col: line.length });
  }

  // Emit remaining DEDENTs
  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ type: 'DEDENT', value: '', line: lines.length, col: 0 });
  }

  tokens.push({ type: 'EOF', value: '', line: lines.length + 1, col: 0 });
  if (filename !== undefined) {
    for (const t of tokens) t.file = filename;
  }
  return tokens;
}
