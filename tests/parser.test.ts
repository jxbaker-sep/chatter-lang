import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';
import { FunctionDeclaration, SetStatement, CallStatement, ReturnStatement, BinaryExpression } from '../src/ast';

function parseSource(src: string) {
  return parse(lex(src));
}

describe('Parser', () => {
  test('parses say statement with string literal', () => {
    const ast = parseSource('say "Hello World"');
    expect(ast.body).toHaveLength(1);
    expect(ast.body[0]).toMatchObject({
      type: 'SayStatement',
      expressions: [{ type: 'StringLiteral', value: 'Hello World' }],
    });
  });

  test('parses set statement', () => {
    const ast = parseSource('set foo to 5');
    expect(ast.body[0]).toMatchObject({
      type: 'SetStatement',
      name: 'foo',
      value: { type: 'NumberLiteral', value: 5 },
    });
  });

  test('parses function declaration with single param', () => {
    const ast = parseSource('function double takes number a is\n    return a * 2\nend');
    expect(ast.body[0]).toMatchObject({
      type: 'FunctionDeclaration',
      name: 'double',
      params: [{ paramType: { kind: 'scalar', name: 'number' }, name: 'a', label: null }],
      body: [{
        type: 'ReturnStatement',
        value: {
          type: 'BinaryExpression',
          operator: '*',
          left:  { type: 'IdentifierExpression', name: 'a' },
          right: { type: 'NumberLiteral', value: 2 },
        },
      }],
    });
  });

  test('parses function declaration with zero params (no `takes`)', () => {
    const ast = parseSource('function greet is\n    say "hi"\nend');
    expect(ast.body[0]).toMatchObject({
      type: 'FunctionDeclaration',
      name: 'greet',
      params: [],
    });
  });

  test('parses function declaration with keyword label/body name (`to`)', () => {
    const src = 'function raise takes number a to number to is\n    return a ** to\nend';
    const ast = parseSource(src);
    const decl = ast.body[0] as FunctionDeclaration;
    expect(decl.params).toEqual([
      { paramType: { kind: 'scalar', name: 'number' }, name: 'a',  label: null },
      { paramType: { kind: 'scalar', name: 'number' }, name: 'to', label: 'to' },
    ]);
    expect((decl.body[0] as ReturnStatement).value).toMatchObject({
      type: 'BinaryExpression',
      operator: '**',
      left:  { type: 'IdentifierExpression', name: 'a' },
      right: { type: 'IdentifierExpression', name: 'to' },
    });
  });

  test('parses function decl with distinct separator label and body name', () => {
    const src = 'function raise takes number base to number exponent is\n    return base ** exponent\nend';
    const ast = parseSource(src);
    const decl = ast.body[0] as FunctionDeclaration;
    expect(decl.params).toEqual([
      { paramType: { kind: 'scalar', name: 'number' }, name: 'base',     label: null },
      { paramType: { kind: 'scalar', name: 'number' }, name: 'exponent', label: 'to' },
    ]);
  });

  test('parses function decl with duplicate labels (with ... with ...)', () => {
    const src = 'function sum3 takes number a with number b with number c is\n    return a + b + c\nend';
    const ast = parseSource(src);
    const decl = ast.body[0] as FunctionDeclaration;
    expect(decl.params).toEqual([
      { paramType: { kind: 'scalar', name: 'number' }, name: 'a', label: null },
      { paramType: { kind: 'scalar', name: 'number' }, name: 'b', label: 'with' },
      { paramType: { kind: 'scalar', name: 'number' }, name: 'c', label: 'with' },
    ]);
  });

  test('rejects legacy paren form with a helpful error', () => {
    expect(() => parseSource('function f(number a) is\n    return a\nend'))
      .toThrow(/takes/);
  });

  test('rejects duplicate body names', () => {
    expect(() =>
      parseSource('function bad takes number a with number a is\n    return a\nend'),
    ).toThrow(/[Dd]uplicate parameter/);
  });

  test('rejects stop-keyword as a separator label', () => {
    expect(() =>
      parseSource('function bad takes number a end number b is\n    return a\nend'),
    ).toThrow(/reserved keyword/);
  });

  test('parses call statement with positional arg (identifier)', () => {
    const ast = parseSource('double foo');
    expect(ast.body[0]).toMatchObject({
      type: 'CallStatement',
      name: 'double',
      args: [{ name: null, value: { type: 'IdentifierExpression', name: 'foo' } }],
    });
  });

  test('parses call statement with `it` as positional arg', () => {
    const ast = parseSource('double it');
    expect(ast.body[0]).toMatchObject({
      type: 'CallStatement',
      name: 'double',
      args: [{ name: null, value: { type: 'ItExpression' } }],
    });
  });

  test('parses call with named args (keyword param name)', () => {
    const ast = parseSource('raise foo to bar');
    expect(ast.body[0]).toMatchObject({
      type: 'CallStatement',
      name: 'raise',
      args: [
        { name: null,  value: { type: 'IdentifierExpression', name: 'foo' } },
        { name: 'to',  value: { type: 'IdentifierExpression', name: 'bar' } },
      ],
    });
  });

  test('parses call with no args', () => {
    const ast = parseSource('noop\n');
    // 'noop\n' – the NEWLINE comes from the source; parseSource adds a newline
    const ast2 = parse(lex('noop'));
    expect(ast2.body[0]).toMatchObject({ type: 'CallStatement', name: 'noop', args: [] });
  });

  test('operator precedence: + lower than *', () => {
    const ast = parseSource('set x to 2 + 3 * 4');
    const setStmt = ast.body[0] as SetStatement;
    // Should be 2 + (3 * 4)
    expect(setStmt.value).toMatchObject({
      type: 'BinaryExpression',
      operator: '+',
      left:  { type: 'NumberLiteral', value: 2 },
      right: {
        type: 'BinaryExpression',
        operator: '*',
        left:  { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 4 },
      },
    });
  });

  test('operator precedence: ** higher than *', () => {
    const ast = parseSource('set x to 2 * 3 ** 4');
    const setStmt = ast.body[0] as SetStatement;
    // Should be 2 * (3 ** 4)
    expect(setStmt.value).toMatchObject({
      type: 'BinaryExpression',
      operator: '*',
      left: { type: 'NumberLiteral', value: 2 },
      right: {
        type: 'BinaryExpression',
        operator: '**',
        left:  { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 4 },
      },
    });
  });

  test('parses hello_world.chatter without error', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../examples/hello_world.chatter'),
      'utf-8',
    );
    const ast = parseSource(source);
    expect(ast.type).toBe('Program');
    expect(ast.body.length).toBeGreaterThan(5);
    const funcNames = ast.body
      .filter(s => s.type === 'FunctionDeclaration')
      .map(s => (s as FunctionDeclaration).name);
    expect(funcNames).toEqual(['double', 'quadruple', 'raise']);
  });

  test('set baz to it produces ItExpression', () => {
    const ast = parseSource('set baz to it');
    expect((ast.body[0] as SetStatement).value).toMatchObject({ type: 'ItExpression' });
  });

  describe('booleans, logical ops, equality, if', () => {
    test('true / false parse as BooleanLiteral', () => {
      const ast = parseSource('set x to true\nset y to false');
      expect((ast.body[0] as SetStatement).value).toMatchObject({ type: 'BooleanLiteral', value: true });
      expect((ast.body[1] as SetStatement).value).toMatchObject({ type: 'BooleanLiteral', value: false });
    });

    test('`not a is b` parses as not (a is b) (equality binds tighter than not)', () => {
      const ast = parseSource('set r to not a is b');
      expect((ast.body[0] as SetStatement).value).toMatchObject({
        type: 'UnaryExpression',
        operator: 'not',
        operand: {
          type: 'BinaryExpression',
          operator: '==',
          left:  { type: 'IdentifierExpression', name: 'a' },
          right: { type: 'IdentifierExpression', name: 'b' },
        },
      });
    });

    test('chained `a and b and c` parses fine (flat)', () => {
      expect(() => parseSource('set r to a and b and c')).not.toThrow();
    });

    test('`(a and b) or c` parses fine (parens reset context)', () => {
      expect(() => parseSource('set r to (a and b) or c')).not.toThrow();
    });

    test('`a and b or c` raises ParseError mentioning parentheses', () => {
      expect(() => parseSource('set r to a and b or c')).toThrow(/parentheses/);
    });

    test('if / else if / else / end produces correct AST', () => {
      const src = [
        'if a is 1',
        '    say "one"',
        'else if a is 2',
        '    say "two"',
        'else',
        '    say "other"',
        'end',
      ].join('\n');
      const ast = parseSource(src);
      const ifStmt = ast.body[0] as any;
      expect(ifStmt.type).toBe('IfStatement');
      expect(ifStmt.branches).toHaveLength(2);
      expect(ifStmt.branches[0].condition).toMatchObject({
        type: 'BinaryExpression', operator: '==',
      });
      expect(ifStmt.branches[0].body[0]).toMatchObject({ type: 'SayStatement' });
      expect(ifStmt.branches[1].condition).toMatchObject({
        type: 'BinaryExpression', operator: '==',
      });
      expect(ifStmt.elseBody).not.toBeNull();
      expect(ifStmt.elseBody).toHaveLength(1);
    });

    test('if without else has elseBody === null', () => {
      const ast = parseSource('if a\n    say 1\nend');
      const ifStmt = ast.body[0] as any;
      expect(ifStmt.elseBody).toBeNull();
      expect(ifStmt.branches).toHaveLength(1);
    });

    test('`is not` produces BinaryExpression with operator !=', () => {
      const ast = parseSource('set r to a is not b');
      expect((ast.body[0] as SetStatement).value).toMatchObject({
        type: 'BinaryExpression',
        operator: '!=',
        left:  { type: 'IdentifierExpression', name: 'a' },
        right: { type: 'IdentifierExpression', name: 'b' },
      });
    });

    test('optional `end if` accepted on if-statement', () => {
      const ast = parseSource('if a\n    say 1\nend if');
      expect(ast.body[0]).toMatchObject({ type: 'IfStatement' });
    });

    test('optional `end function` accepted on function decl', () => {
      const ast = parseSource('function f takes number a is\n    return a\nend function');
      expect(ast.body[0]).toMatchObject({ type: 'FunctionDeclaration', name: 'f' });
    });

    test('`==` is no longer tokenised as an operator (tokenisation error)', () => {
      expect(() => parseSource('if a == b\n    say 1\nend')).toThrow();
    });

    test('`elif` is no longer a keyword (parse error)', () => {
      expect(() => parseSource('if a\n    say 1\nelif b\n    say 2\nend')).toThrow();
    });
  });

  describe('repeat statements', () => {
    test('repeat N times produces RepeatStatement kind=times', () => {
      const ast = parseSource('repeat 3 times\n    say "hi"\nend repeat');
      expect(ast.body[0]).toMatchObject({
        type: 'RepeatStatement',
        kind: 'times',
        count: { type: 'NumberLiteral', value: 3 },
      });
      const rep = ast.body[0] as any;
      expect(rep.body).toHaveLength(1);
      expect(rep.body[0]).toMatchObject({ type: 'SayStatement' });
    });

    test('repeat with i from A to B produces kind=range', () => {
      const ast = parseSource('repeat with i from 1 to 10\n    say i\nend repeat');
      expect(ast.body[0]).toMatchObject({
        type: 'RepeatStatement',
        kind: 'range',
        varName: 'i',
        from: { type: 'NumberLiteral', value: 1 },
        to: { type: 'NumberLiteral', value: 10 },
      });
    });

    test('repeat while cond produces kind=while', () => {
      const ast = parseSource('repeat while false\n    say "x"\nend repeat');
      expect(ast.body[0]).toMatchObject({
        type: 'RepeatStatement',
        kind: 'while',
        condition: { type: 'BooleanLiteral', value: false },
      });
    });

    test('`end` alone (without `repeat`) is valid', () => {
      const ast = parseSource('repeat 2 times\n    say "x"\nend');
      expect(ast.body[0]).toMatchObject({ type: 'RepeatStatement', kind: 'times' });
    });

    test('`end repeat` is valid', () => {
      const ast = parseSource('repeat 2 times\n    say "x"\nend repeat');
      expect(ast.body[0]).toMatchObject({ type: 'RepeatStatement', kind: 'times' });
    });

    test('range expression boundaries can be expressions', () => {
      const ast = parseSource('repeat with i from 1 + 1 to 2 * 5\n    say i\nend');
      expect(ast.body[0]).toMatchObject({
        type: 'RepeatStatement',
        kind: 'range',
        from: { type: 'BinaryExpression', operator: '+' },
        to:   { type: 'BinaryExpression', operator: '*' },
      });
    });
  });

  describe('var / change / compound assign', () => {
    test('var x is EXPR produces VarDeclaration', () => {
      const ast = parseSource('var x is 5');
      expect(ast.body[0]).toMatchObject({
        type: 'VarDeclaration',
        name: 'x',
        value: { type: 'NumberLiteral', value: 5 },
      });
    });

    test('var without initializer is a parse error', () => {
      expect(() => parseSource('var x')).toThrow();
    });

    test('change x to EXPR produces ChangeStatement', () => {
      const ast = parseSource('change x to 7');
      expect(ast.body[0]).toMatchObject({
        type: 'ChangeStatement',
        name: 'x',
        value: { type: 'NumberLiteral', value: 7 },
      });
    });

    test('add EXPR to NAME produces CompoundAssignStatement op=add', () => {
      const ast = parseSource('add 3 to n');
      expect(ast.body[0]).toMatchObject({
        type: 'CompoundAssignStatement', op: 'add', name: 'n',
        value: { type: 'NumberLiteral', value: 3 },
      });
    });

    test('subtract EXPR from NAME', () => {
      const ast = parseSource('subtract 3 from n');
      expect(ast.body[0]).toMatchObject({
        type: 'CompoundAssignStatement', op: 'subtract', name: 'n',
      });
    });

    test('multiply NAME by EXPR', () => {
      const ast = parseSource('multiply n by 4');
      expect(ast.body[0]).toMatchObject({
        type: 'CompoundAssignStatement', op: 'multiply', name: 'n',
        value: { type: 'NumberLiteral', value: 4 },
      });
    });

    test('divide NAME by EXPR', () => {
      const ast = parseSource('divide n by 2');
      expect(ast.body[0]).toMatchObject({
        type: 'CompoundAssignStatement', op: 'divide', name: 'n',
      });
    });

    test('add accepts a full expression on the RHS', () => {
      const ast = parseSource('add 2 + 3 to n');
      expect(ast.body[0]).toMatchObject({
        type: 'CompoundAssignStatement', op: 'add', name: 'n',
        value: { type: 'BinaryExpression', operator: '+' },
      });
    });
  });

  describe('comparison operators', () => {
    function getCond(src: string): BinaryExpression {
      const ast = parseSource(src);
      return (ast.body[0] as any).branches[0].condition as BinaryExpression;
    }

    test('is less than → <', () => {
      expect(getCond('if a is less than b\n    say 1\nend')).toMatchObject({
        type: 'BinaryExpression', operator: '<',
        left: { type: 'IdentifierExpression', name: 'a' },
        right: { type: 'IdentifierExpression', name: 'b' },
      });
    });

    test('is greater than → >', () => {
      expect(getCond('if a is greater than b\n    say 1\nend')).toMatchObject({
        type: 'BinaryExpression', operator: '>',
      });
    });

    test('is at most → <=', () => {
      expect(getCond('if a is at most b\n    say 1\nend')).toMatchObject({
        type: 'BinaryExpression', operator: '<=',
      });
    });

    test('is at least → >=', () => {
      expect(getCond('if a is at least b\n    say 1\nend')).toMatchObject({
        type: 'BinaryExpression', operator: '>=',
      });
    });

    test('is at foo without least/most is a ParseError mentioning least', () => {
      expect(() => parseSource('if a is at 5\n    say 1\nend')).toThrow(/least/);
    });

    test('arithmetic binds tighter than comparison', () => {
      const cond = getCond('if a + 1 is at least 5\n    say 1\nend');
      expect(cond.operator).toBe('>=');
      expect(cond.left).toMatchObject({ type: 'BinaryExpression', operator: '+' });
    });
  });

  describe('return types', () => {
    test('function decl without returns has returnType null', () => {
      const ast = parseSource('function greet is\n    say "hi"\nend');
      expect(ast.body[0]).toMatchObject({
        type: 'FunctionDeclaration',
        name: 'greet',
        returnType: null,
      });
    });

    test('function decl with returns number', () => {
      const ast = parseSource('function double takes number n returns number is\n    return n * 2\nend');
      expect(ast.body[0]).toMatchObject({
        type: 'FunctionDeclaration',
        name: 'double',
        returnType: { kind: 'scalar', name: 'number' },
      });
    });

    test('function decl with returns string and zero args', () => {
      const ast = parseSource('function hello returns string is\n    return "hi"\nend');
      expect(ast.body[0]).toMatchObject({
        type: 'FunctionDeclaration',
        returnType: { kind: 'scalar', name: 'string' },
      });
    });

    test('function decl with returns boolean', () => {
      const ast = parseSource('function yep returns boolean is\n    return true\nend');
      expect(ast.body[0]).toMatchObject({ returnType: { kind: 'scalar', name: 'boolean' } });
    });

    test('bare return parses with null value', () => {
      const ast = parseSource('function f is\n    return\nend');
      const decl = ast.body[0] as FunctionDeclaration;
      expect(decl.body[0]).toMatchObject({ type: 'ReturnStatement', value: null });
    });

    test('return with expression parses with non-null value', () => {
      const ast = parseSource('function f returns number is\n    return 1 + 2\nend');
      const decl = ast.body[0] as FunctionDeclaration;
      const r = decl.body[0] as ReturnStatement;
      expect(r.value).not.toBeNull();
      expect(r.value).toMatchObject({ type: 'BinaryExpression', operator: '+' });
    });

    test('returns clause after multi-param takes list', () => {
      const ast = parseSource(
        'function raise takes number base to number exponent returns number is\n    return base ** exponent\nend',
      );
      expect(ast.body[0]).toMatchObject({
        returnType: { kind: 'scalar', name: 'number' },
        params: [
          { paramType: { kind: 'scalar', name: 'number' }, name: 'base', label: null },
          { paramType: { kind: 'scalar', name: 'number' }, name: 'exponent', label: 'to' },
        ],
      });
    });
  });

  describe('lists', () => {
    test('parses nonempty list literal', () => {
      const ast = parseSource('set l to list of 1, 2, 3');
      expect(ast.body[0]).toMatchObject({
        type: 'SetStatement',
        name: 'l',
        value: {
          type: 'ListLiteral',
          kind: 'nonempty',
          elements: [
            { type: 'NumberLiteral', value: 1 },
            { type: 'NumberLiteral', value: 2 },
            { type: 'NumberLiteral', value: 3 },
          ],
        },
      });
    });

    test('parses empty list literal with element type', () => {
      const ast = parseSource('set l to empty list of string');
      expect(ast.body[0]).toMatchObject({
        type: 'SetStatement',
        value: { type: 'ListLiteral', kind: 'empty', elementType: 'string', elements: [] },
      });
    });

    test('rejects nested list type in literal', () => {
      expect(() => parseSource('set l to list of list of 1, 2')).toThrow(/nested lists not supported/);
    });

    test('rejects nested list in type annotation', () => {
      expect(() => parseSource('function f takes list of list of number xs is\n    say 1\nend')).toThrow(/nested lists not supported/);
    });

    test('parses item N of L', () => {
      const ast = parseSource('say item 2 of xs');
      expect(ast.body[0]).toMatchObject({
        type: 'SayStatement',
        expressions: [{
          type: 'ItemAccessExpression',
          index: { type: 'NumberLiteral', value: 2 },
          target: { type: 'IdentifierExpression', name: 'xs' },
        }],
      });
    });

    test('parses first item of / last item of / length of', () => {
      const ast = parseSource('say first item of xs\nsay last item of xs\nsay length of xs');
      expect(ast.body[0]).toMatchObject({ expressions: [{ type: 'FirstItemExpression' }] });
      expect(ast.body[1]).toMatchObject({ expressions: [{ type: 'LastItemExpression' }] });
      expect(ast.body[2]).toMatchObject({ expressions: [{ type: 'LengthExpression' }] });
    });

    test('parses contains as binary operator', () => {
      const ast = parseSource('set r to xs contains 3');
      expect((ast.body[0] as SetStatement).value).toMatchObject({
        type: 'BinaryExpression',
        operator: 'contains',
      });
    });

    test('parses list mutation statements', () => {
      const ast = parseSource('append 1 to xs\nprepend 2 to xs\ninsert 3 at 1 in xs\nremove item 2 from xs\nchange item 1 of xs to 9');
      expect(ast.body[0]).toMatchObject({ type: 'AppendStatement', listName: 'xs' });
      expect(ast.body[1]).toMatchObject({ type: 'PrependStatement', listName: 'xs' });
      expect(ast.body[2]).toMatchObject({ type: 'InsertStatement', listName: 'xs' });
      expect(ast.body[3]).toMatchObject({ type: 'RemoveItemStatement', listName: 'xs' });
      expect(ast.body[4]).toMatchObject({ type: 'ChangeItemStatement', listName: 'xs' });
    });

    test('parses repeat with x in L', () => {
      const ast = parseSource('repeat with x in xs\n    say x\nend repeat');
      expect(ast.body[0]).toMatchObject({ type: 'RepeatStatement', kind: 'list', varName: 'x' });
    });

    test('parses list of TYPE and readonly list of TYPE param annotations', () => {
      const ast = parseSource('function f takes list of number xs other readonly list of string ys is\n    say 1\nend');
      const fn = ast.body[0] as FunctionDeclaration;
      expect(fn.params[0].paramType).toEqual({ kind: 'list', element: 'number', readonly: false });
      expect(fn.params[1].paramType).toEqual({ kind: 'list', element: 'string', readonly: true });
    });

    test('rejects readonly outside parameter annotations', () => {
      expect(() => parseSource('set l to readonly list of number')).toThrow(/readonly/);
    });
  });

  describe('string operations', () => {
    test('parses & as BinaryExpression', () => {
      const ast = parseSource('say "a" & "b"');
      expect((ast.body[0] as any).expressions[0]).toMatchObject({
        type: 'BinaryExpression',
        operator: '&',
        left: { type: 'StringLiteral', value: 'a' },
        right: { type: 'StringLiteral', value: 'b' },
      });
    });

    test('& is left-associative', () => {
      const ast = parseSource('say "a" & "b" & "c"');
      const expr = (ast.body[0] as any).expressions[0];
      expect(expr.operator).toBe('&');
      expect(expr.left.operator).toBe('&');
      expect(expr.left.left).toMatchObject({ value: 'a' });
      expect(expr.left.right).toMatchObject({ value: 'b' });
      expect(expr.right).toMatchObject({ value: 'c' });
    });

    test('+ binds tighter than & (precedence)', () => {
      const ast = parseSource('say "x=" & 1 + 2');
      const expr = (ast.body[0] as any).expressions[0];
      expect(expr.operator).toBe('&');
      expect(expr.right).toMatchObject({ type: 'BinaryExpression', operator: '+' });
    });

    test('parses character N of S', () => {
      const ast = parseSource('say character 1 of "hi"');
      expect((ast.body[0] as any).expressions[0]).toMatchObject({
        type: 'CharacterAccessExpression',
        index: { type: 'NumberLiteral', value: 1 },
        target: { type: 'StringLiteral', value: 'hi' },
      });
    });

    test('parses characters A to B of S', () => {
      const ast = parseSource('say characters 1 to 3 of "hello"');
      expect((ast.body[0] as any).expressions[0]).toMatchObject({
        type: 'SubstringExpression',
        from: { type: 'NumberLiteral', value: 1 },
        to: { type: 'NumberLiteral', value: 3 },
        target: { type: 'StringLiteral', value: 'hello' },
      });
    });

    test('parses first character of S', () => {
      const ast = parseSource('say first character of "hi"');
      expect((ast.body[0] as any).expressions[0]).toMatchObject({
        type: 'FirstCharacterExpression',
        target: { type: 'StringLiteral', value: 'hi' },
      });
    });

    test('parses last character of S', () => {
      const ast = parseSource('say last character of "hi"');
      expect((ast.body[0] as any).expressions[0]).toMatchObject({
        type: 'LastCharacterExpression',
        target: { type: 'StringLiteral', value: 'hi' },
      });
    });

    test('still parses first item of L (lists unaffected)', () => {
      const ast = parseSource('set l to list of 1\nsay first item of l');
      expect((ast.body[1] as any).expressions[0].type).toBe('FirstItemExpression');
    });
  });
});
