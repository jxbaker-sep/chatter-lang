import * as fs from 'fs';
import * as path from 'path';
import { lex } from './lexer';
import { parse } from './parser';
import { Compiler, CompileError, CompiledModule, ImportedFunction } from './compiler';
import { Instruction, FunctionDef, BytecodeProgram } from './bytecode';
import { Program, UseStatement } from './ast';
import { SourceLocation } from './errors';

interface ModuleInfo {
  absPath: string;
  moduleId: string;
  source: string;
  ast: Program;
  compiled?: CompiledModule;
}

function resolveUsePath(userPath: string, fromDir: string): string {
  // Always append .chatter
  const withExt = userPath.endsWith('.chatter') ? userPath : userPath + '.chatter';
  const resolved = path.resolve(fromDir, withExt);
  return resolved;
}

function useLocation(u: UseStatement): SourceLocation | undefined {
  if (u.pathLoc) return { line: u.pathLoc.line, col: u.pathLoc.col, length: u.pathLoc.length };
  const anyU = u as any;
  if (anyU.line !== undefined && anyU.col !== undefined) {
    return { line: anyU.line, col: anyU.col, length: anyU.length };
  }
  return undefined;
}

function nameLocation(u: UseStatement, idx: number): SourceLocation | undefined {
  if (u.nameLocs && u.nameLocs[idx]) {
    const n = u.nameLocs[idx];
    return { line: n.line, col: n.col, length: n.length };
  }
  return useLocation(u);
}

export function loadProgram(entryFilePath: string): BytecodeProgram {
  const entryAbs = path.resolve(entryFilePath);
  const registry = new Map<string, ModuleInfo>();   // absPath -> info
  const pathToWritten = new Map<string, string>();  // absPath -> original user-written path (for errors)
  pathToWritten.set(entryAbs, entryFilePath);
  let nextId = 0;

  // DFS: returns ordered list (post-order) of ModuleInfo.
  const orderPostOrder: ModuleInfo[] = [];
  const loading = new Map<string, string>();  // absPath -> userDisplayPath (stack entry)
  const loadingStack: Array<{ absPath: string; display: string }> = [];

  function visit(absPath: string, displayPath: string, useStmtLoc?: SourceLocation): ModuleInfo {
    if (registry.has(absPath)) {
      const existing = registry.get(absPath)!;
      if (loading.has(absPath)) {
        // Cycle: build path from cycle start to current + back
        const cycleStartIdx = loadingStack.findIndex(e => e.absPath === absPath);
        const cyclePath = loadingStack.slice(cycleStartIdx).map(e => e.display);
        cyclePath.push(displayPath);
        throw new CompileError(
          `circular import: ${cyclePath.join(' → ')}`,
          useStmtLoc,
        );
      }
      return existing;
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
      const tokens = lex(source);
      ast = parse(tokens, source);
    } catch (e) {
      // Attach module file path to the error by re-throwing as-is; the caller
      // surfaces it with the formatError helper using the entry path. We want
      // better module-level error context, but keep it simple for v1.
      throw e;
    }

    const moduleId = `m${nextId++}`;
    const info: ModuleInfo = { absPath, moduleId, source, ast };
    registry.set(absPath, info);
    loading.set(absPath, displayPath);
    loadingStack.push({ absPath, display: displayPath });

    // Visit dependencies (use statements) first.
    const fromDir = path.dirname(absPath);
    const depModules = new Map<string, ModuleInfo>();  // userPath -> depInfo
    for (const stmt of ast.body) {
      if (stmt.type !== 'UseStatement') continue;
      const depAbs = resolveUsePath(stmt.path, fromDir);
      pathToWritten.set(depAbs, stmt.path);
      const stmtLoc = useLocation(stmt);
      // Cycle check inline: if depAbs is on the loading stack, build cycle.
      if (loading.has(depAbs)) {
        const cycleStartIdx = loadingStack.findIndex(e => e.absPath === depAbs);
        const cyclePath = loadingStack.slice(cycleStartIdx).map(e => e.display);
        cyclePath.push(stmt.path);
        throw new CompileError(
          `circular import: ${cyclePath.join(' → ')}`,
          stmtLoc,
        );
      }
      const depInfo = visit(depAbs, stmt.path, stmtLoc);
      depModules.set(stmt.path, depInfo);
    }

    // Now all deps are compiled (post-order). Compile this module with imports.
    const imports = new Map<string, ImportedFunction>();
    for (const stmt of ast.body) {
      if (stmt.type !== 'UseStatement') continue;
      const depInfo = depModules.get(stmt.path)!;
      const depExports = depInfo.compiled!.exports;
      for (let i = 0; i < stmt.names.length; i++) {
        const n = stmt.names[i];
        const nameLoc = nameLocation(stmt, i);
        if (!depExports.has(n)) {
          throw new CompileError(
            `module "${stmt.path}" does not export '${n}'`,
            nameLoc,
          );
        }
        if (imports.has(n)) {
          throw new CompileError(
            `name '${n}' is already defined`,
            nameLoc,
          );
        }
        imports.set(n, depExports.get(n)!);
      }
    }

    const compiler = new Compiler();
    const compiled = compiler.compileModule(ast, { moduleId, imports });
    info.compiled = compiled;

    loading.delete(absPath);
    loadingStack.pop();
    orderPostOrder.push(info);
    return info;
  }

  const entryInfo = visit(entryAbs, entryFilePath);

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
      if (instr.op === 'JUMP' || instr.op === 'JUMP_IF_FALSE') {
        const copy: Instruction = { ...instr, target: instr.target + shift } as Instruction;
        if (instr.loc) Object.defineProperty(copy, 'loc', { value: instr.loc, enumerable: false, writable: true, configurable: true });
        main.push(copy);
      } else {
        main.push(instr);
      }
    }
  };
  for (const m of orderPostOrder) {
    if (m.absPath === entryInfo.absPath) continue;
    concatShifted(m.compiled!.topLevel);
  }
  concatShifted(entryInfo.compiled!.topLevel);

  return { functions, main };
}
