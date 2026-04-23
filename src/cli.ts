import * as fs from 'fs';
import { lex } from './lexer';
import { parse } from './parser';
import { compile } from './compiler';
import { VM, RuntimeError } from './vm';

export function run(args: string[]): number {
  if (args.length !== 1) {
    console.error('Usage: chatter <filepath>');
    return 1;
  }
  const filepath = args[0];
  if (!fs.existsSync(filepath)) {
    console.error(`File does not exist: ${filepath}`);
    return 1;
  }

  try {
    const source = fs.readFileSync(filepath, 'utf8');
    const tokens = lex(source);
    const ast = parse(tokens, source);
    const program = compile(ast);
    const vm = new VM(program);
    vm.run();
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}