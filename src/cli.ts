import * as fs from 'fs';
import { loadProgram } from './moduleLoader';
import { VM } from './vm';
import { formatError, formatWarning } from './errors';

export function run(args: string[]): number {
  if (args.length < 1) {
    console.error('Usage: chatter <filepath> [arg1 arg2 ...]');
    return 1;
  }
  const filepath = args[0];
  const scriptArgs = args.slice(1);
  if (!fs.existsSync(filepath)) {
    console.error(`File does not exist: ${filepath}`);
    return 1;
  }

  let source = '';
  try {
    source = fs.readFileSync(filepath, 'utf8');
    const program = loadProgram(filepath, { args: scriptArgs });
    for (const w of program.warnings ?? []) {
      process.stderr.write(formatWarning(w, source, filepath) + '\n\n');
    }
    const vm = new VM(program);
    vm.run();
    if (process.env.CHATTER_PROFILE) vm.dumpOpProfile();
    return 0;
  } catch (e) {
    if (e instanceof Error) {
      console.error(formatError(e, source, filepath));
    } else {
      console.error(String(e));
    }
    return 1;
  }
}