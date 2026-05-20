import * as fs from 'fs';
import * as path from 'path';
import { lex } from './lexer';
import { parse } from './parser';
import { Compiler, CompileError, CompiledModule, ImportedFunction, ImportedStruct, ImportedAlias } from './compiler';
import { Instruction, FunctionDef, BytecodeProgram } from './bytecode';
import { Program, UseStatement } from './ast';
import { SourceLocation } from './errors';

interface ModuleInfo {
  absPath: string;
  // Registry key: for user modules this is the absolute filesystem path; for
  // stdlib modules it is the synthetic string `std:<NAME>`. These two
  // namespaces can never collide because `std:` is not a valid absolute path.
  registryKey: string;
  moduleId: string;
  source: string;
  ast: Program;
  compiled?: CompiledModule;
  isStdlib: boolean;
}

const STD_PREFIX = 'std:';

export interface LoadProgramOptions {
  /** Override the directory used to resolve `std:` imports (for tests). */
  stdlibDir?: string;
  /** CLI arguments exposed to the program via `use args from "std:cli"`. */
  args?: string[];
}

function defaultStdlibDir(): string {
  // Resolved relative to this source file. In dev this points to
  // <repo>/stdlib; once compiled to dist/, it points to <repo>/stdlib because
  // the stdlib/ directory is shipped as a sibling of dist/.
  return path.resolve(__dirname, '..', 'stdlib');
}

interface ResolvedUse {
  absPath: string;
  registryKey: string;
  isStdlib: boolean;
}

function validateStdName(name: string): string | null {
  if (name.length === 0) return 'stdlib module name is empty';
  if (name.includes('/') || name.includes('\\')) {
    return `stdlib module name '${name}' must not contain path separators`;
  }
  if (name.includes('..')) {
    return `stdlib module name '${name}' must not contain '..'`;
  }
  if (name.endsWith('.chatter')) {
    return `stdlib module name '${name}' must not include the .chatter extension`;
  }
  return null;
}

function resolveUse(userPath: string, fromDir: string, stdlibDir: string): ResolvedUse {
  if (userPath.startsWith(STD_PREFIX)) {
    const name = userPath.slice(STD_PREFIX.length);
    const err = validateStdName(name);
    if (err) {
      throw new CompileError(`invalid stdlib import "${userPath}": ${err}`);
    }
    return {
      absPath: path.join(stdlibDir, name + '.chatter'),
      registryKey: `std:${name}`,
      isStdlib: true,
    };
  }
  const withExt = userPath.endsWith('.chatter') ? userPath : userPath + '.chatter';
  const resolved = path.resolve(fromDir, withExt);
  return { absPath: resolved, registryKey: resolved, isStdlib: false };
}

function useLocation(u: UseStatement): SourceLocation | undefined {
  if (u.pathLoc) return { line: u.pathLoc.line, col: u.pathLoc.col, length: u.pathLoc.length, file: u.pathLoc.file };
  const anyU = u as any;
  if (anyU.line !== undefined && anyU.col !== undefined) {
    return { line: anyU.line, col: anyU.col, length: anyU.length, file: anyU.file };
  }
  return undefined;
}

function nameLocation(u: UseStatement, idx: number): SourceLocation | undefined {
  if (u.nameLocs && u.nameLocs[idx]) {
    const n = u.nameLocs[idx];
    return { line: n.line, col: n.col, length: n.length, file: n.file };
  }
  return useLocation(u);
}

// Build the synthetic `std:cli` module. It exports one typed function:
//   args returns list of string is return <LOAD_ARGS> end
// with no .chatter source file backing it. The function body is a literal
// LOAD_ARGS + RETURN bytecode sequence; the VM resolves the CLI arguments
// at LOAD_ARGS-execution time from BytecodeProgram.args.
function buildStdCliModule(moduleId: string, registryKey: string, absPath: string): ModuleInfo {
  const mangledArgs = `${moduleId}::args`;
  const fn: FunctionDef = {
    name: mangledArgs,
    params: [],
    instructions: [
      { op: 'LOAD_ARGS' },
      { op: 'RETURN' },
    ],
  };
  const functions = new Map<string, FunctionDef>();
  functions.set(mangledArgs, fn);

  const argsImport: ImportedFunction = {
    mangled: mangledArgs,
    signature: [],
    returnType: { kind: 'list', element: { kind: 'scalar', name: 'string' } },
    paramNames: [],
  };
  const exportsMap = new Map<string, ImportedFunction>();
  exportsMap.set('args', argsImport);

  const compiled: CompiledModule = {
    functions,
    topLevel: [],
    exports: exportsMap,
    structExports: new Map(),
    aliasExports: new Map(),
    structFormatters: new Map(),
  };

  // Synthetic AST: an empty Program is enough; the loader only consults `ast`
  // to walk UseStatements (none here) and never re-parses this module.
  const ast: Program = { type: 'Program', body: [] } as Program;

  return {
    absPath,
    registryKey,
    moduleId,
    source: '',
    ast,
    compiled,
    isStdlib: true,
  };
}

export function loadProgram(entryFilePath: string, opts: LoadProgramOptions = {}): BytecodeProgram {
  const stdlibDir = opts.stdlibDir ?? defaultStdlibDir();
  const entryAbs = path.resolve(entryFilePath);
  const registry = new Map<string, ModuleInfo>();   // registryKey -> info
  const pathToWritten = new Map<string, string>();  // registryKey -> original user-written path (for errors)
  pathToWritten.set(entryAbs, entryFilePath);
  let nextId = 0;

  // DFS: returns ordered list (post-order) of ModuleInfo.
  const orderPostOrder: ModuleInfo[] = [];
  const loading = new Map<string, string>();  // registryKey -> userDisplayPath (stack entry)
  const loadingStack: Array<{ registryKey: string; display: string }> = [];

  function visit(
    absPath: string,
    registryKey: string,
    isStdlib: boolean,
    displayPath: string,
    useStmtLoc?: SourceLocation,
  ): ModuleInfo {
    if (registry.has(registryKey)) {
      const existing = registry.get(registryKey)!;
      if (loading.has(registryKey)) {
        // Cycle: build path from cycle start to current + back
        const cycleStartIdx = loadingStack.findIndex(e => e.registryKey === registryKey);
        const cyclePath = loadingStack.slice(cycleStartIdx).map(e => e.display);
        cyclePath.push(displayPath);
        throw new CompileError(
          `circular import: ${cyclePath.join(' → ')}`,
          useStmtLoc,
        );
      }
      return existing;
    }
    // Synthetic stdlib module: std:cli — exposes a single typed function
    // `args` whose body is just LOAD_ARGS; RETURN. No .chatter file involved.
    if (registryKey === 'std:cli') {
      const info = buildStdCliModule(`m${nextId++}`, registryKey, absPath);
      registry.set(registryKey, info);
      orderPostOrder.push(info);
      return info;
    }
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      throw new CompileError(
        `cannot find module "${displayPath}"`,
        useStmtLoc,
      );
    }
    const source = fs.readFileSync(absPath, 'utf8');
    let ast: Program;
    try {
      const tokens = lex(source, displayPath);
      ast = parse(tokens, source);
    } catch (e) {
      // Attach module file path to the error by re-throwing as-is; the caller
      // surfaces it with the formatError helper using the entry path. We want
      // better module-level error context, but keep it simple for v1.
      throw e;
    }

    const moduleId = `m${nextId++}`;
    const info: ModuleInfo = { absPath, registryKey, moduleId, source, ast, isStdlib };
    registry.set(registryKey, info);
    loading.set(registryKey, displayPath);
    loadingStack.push({ registryKey, display: displayPath });

    // Visit dependencies (use statements) first.
    const fromDir = path.dirname(absPath);
    const depModules = new Map<string, ModuleInfo>();  // userPath -> depInfo
    for (const stmt of ast.body) {
      if (stmt.type !== 'UseStatement') continue;
      const stmtLoc = useLocation(stmt);
      let resolved: ResolvedUse;
      try {
        resolved = resolveUse(stmt.path, fromDir, stdlibDir);
      } catch (e) {
        if (e instanceof CompileError && !e.location) {
          throw new CompileError(e.message, stmtLoc);
        }
        throw e;
      }
      pathToWritten.set(resolved.registryKey, stmt.path);
      // Cycle check inline: if dep is on the loading stack, build cycle.
      if (loading.has(resolved.registryKey)) {
        const cycleStartIdx = loadingStack.findIndex(e => e.registryKey === resolved.registryKey);
        const cyclePath = loadingStack.slice(cycleStartIdx).map(e => e.display);
        cyclePath.push(stmt.path);
        throw new CompileError(
          `circular import: ${cyclePath.join(' → ')}`,
          stmtLoc,
        );
      }
      const depInfo = visit(resolved.absPath, resolved.registryKey, resolved.isStdlib, stmt.path, stmtLoc);
      depModules.set(stmt.path, depInfo);
    }

    // Now all deps are compiled (post-order). Compile this module with imports.
    const imports = new Map<string, ImportedFunction>();
    const structImports = new Map<string, ImportedStruct>();
    const aliasImports = new Map<string, ImportedAlias>();
    for (const stmt of ast.body) {
      if (stmt.type !== 'UseStatement') continue;
      const depInfo = depModules.get(stmt.path)!;
      const depExports = depInfo.compiled!.exports;
      const depStructExports = depInfo.compiled!.structExports;
      const depAliasExports = depInfo.compiled!.aliasExports;
      for (let i = 0; i < stmt.names.length; i++) {
        const n = stmt.names[i];
        const nameLoc = nameLocation(stmt, i);
        const isFunc = depExports.has(n);
        const isStruct = depStructExports.has(n);
        const isAlias = depAliasExports.has(n);
        if (!isFunc && !isStruct && !isAlias) {
          throw new CompileError(
            `module "${stmt.path}" does not export '${n}'`,
            nameLoc,
          );
        }
        if (imports.has(n) || structImports.has(n) || aliasImports.has(n)) {
          throw new CompileError(
            `name '${n}' is already defined`,
            nameLoc,
          );
        }
        if (isFunc) {
          imports.set(n, depExports.get(n)!);
        } else if (isStruct) {
          structImports.set(n, depStructExports.get(n)!);
        } else {
          aliasImports.set(n, depAliasExports.get(n)!);
        }
      }
    }

    const compiler = new Compiler();
    const compiled = compiler.compileModule(ast, { moduleId, imports, structImports, aliasImports });
    info.compiled = compiled;

    loading.delete(registryKey);
    loadingStack.pop();
    orderPostOrder.push(info);
    return info;
  }

  const entryInfo = visit(entryAbs, entryAbs, false, entryFilePath);

  // Build combined program.
  const functions = new Map<string, FunctionDef>();
  for (const m of orderPostOrder) {
    for (const [k, v] of m.compiled!.functions) {
      functions.set(k, v);
    }
  }

  // Assemble main: non-entry modules' top-level (in post-order) + entry's top-level.
  // JUMP/JUMP_IF_FALSE targets are instruction indices within their block and
  // need to be shifted when concatenated.
  const main: Instruction[] = [];
  const concatShifted = (block: Instruction[]) => {
    const shift = main.length;
    for (const instr of block) {
      if (instr.op === 'JUMP' || instr.op === 'JUMP_IF_FALSE' || instr.op === 'JUMP_BOOL_OP') {
        const copy: Instruction = { ...instr, target: instr.target + shift } as Instruction;
        if (instr.loc) Object.defineProperty(copy, 'loc', { value: instr.loc, enumerable: false, writable: true, configurable: true });
        main.push(copy);
      } else {
        main.push(instr);
      }
    }
  };
  for (const m of orderPostOrder) {
    if (m.absPath === entryInfo.absPath && m.registryKey === entryInfo.registryKey) continue;
    concatShifted(m.compiled!.topLevel);
  }
  concatShifted(entryInfo.compiled!.topLevel);

  // Aggregate structFormatters from every module into a single program-level
  // map. Each module's CompiledModule already carries entries for both its
  // own local structs and any imported structs that have formatters; the
  // union here is therefore safe even if some entries are repeated.
  const structFormatters = new Map<string, string>();
  for (const m of orderPostOrder) {
    for (const [k, v] of m.compiled!.structFormatters) {
      structFormatters.set(k, v);
    }
  }

  return { functions, main, args: opts.args ?? [], structFormatters };
}
