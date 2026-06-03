export interface SourceLocation {
  line: number;
  col: number;
  length?: number;
  file?: string;
}

export class ChatterError extends Error {
  public location?: SourceLocation;
  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.location = location;
  }
}

// Aggregates multiple compile-time diagnostics into a single throwable. The
// CLI / formatError unpacks it and renders each inner error individually.
export class AggregateChatterError extends Error {
  constructor(public errors: ChatterError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'AggregateChatterError';
  }
}

export class CompileWarning extends ChatterError {
  constructor(message: string, location?: SourceLocation) {
    super(message, location);
    this.name = 'CompileWarning';
  }
}

function hasLocation(e: Error): e is Error & { location?: SourceLocation } {
  return 'location' in (e as object);
}

function formatDiagnostic(prefix: string, error: Error, source: string, filename: string): string {
  const fname = filename || '<source>';
  const loc = hasLocation(error) ? error.location : undefined;
  const header = `${prefix}: ${error.message}`;

  if (!loc) return header;

  if (loc.file && loc.file !== filename) {
    return `${header}\n --> ${loc.file}:${loc.line}:${loc.col + 1}`;
  }

  const lines = source.split('\n');
  if (loc.line < 1 || loc.line > lines.length) {
    return `${header}\n --> ${fname}:${loc.line}:${loc.col + 1}`;
  }

  const srcLine = lines[loc.line - 1];
  const lineNumStr = String(loc.line);
  const gutterWidth = lineNumStr.length;
  const gutterPad = ' '.repeat(gutterWidth);
  const caretCol = Math.max(0, loc.col);
  const caretLen = Math.max(1, loc.length ?? 1);
  const caretPad = ' '.repeat(caretCol);
  const carets = '^'.repeat(caretLen);

  return [
    header,
    `${gutterPad}--> ${fname}:${loc.line}:${loc.col + 1}`,
    `${gutterPad} |`,
    `${lineNumStr} | ${srcLine}`,
    `${gutterPad} | ${caretPad}${carets}`,
  ].join('\n');
}

export function formatWarning(warning: CompileWarning, source: string, filename: string): string {
  return formatDiagnostic('warning', warning, source, filename);
}

export function formatError(error: Error, source: string, filename: string): string {
  if (error instanceof AggregateChatterError) {
    return error.errors.map((e) => formatError(e, source, filename)).join('\n\n');
  }
  return formatDiagnostic('error', error, source, filename);
}
