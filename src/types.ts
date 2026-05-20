import type { ScalarTypeName } from './ast';

export type ChatterType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: ChatterType }
  | { kind: 'uniqueList'; element: ChatterType }
  | { kind: 'dict'; keyType: ChatterType; valueType: ChatterType }
  | { kind: 'struct'; mangled: string };

export function unmangleTypeName(s: string): string {
  const idx = s.indexOf('::');
  return idx === -1 ? s : s.slice(idx + 2);
}

export function typesEqual(a: ChatterType, b: ChatterType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'scalar': return b.kind === 'scalar' && a.name === b.name;
    case 'struct': return b.kind === 'struct' && a.mangled === b.mangled;
    case 'list': return b.kind === 'list' && typesEqual(a.element, b.element);
    case 'uniqueList': return b.kind === 'uniqueList' && typesEqual(a.element, b.element);
    case 'dict': return b.kind === 'dict' && typesEqual(a.keyType, b.keyType) && typesEqual(a.valueType, b.valueType);
  }
}

export function typeToString(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': return 'struct ' + unmangleTypeName(t.mangled);
    case 'list': return 'list of ' + typeToString(t.element);
    case 'uniqueList': return 'unique list of ' + typeToString(t.element);
    case 'dict': return 'dictionary from ' + typeToString(t.keyType) + ' to ' + typeToString(t.valueType);
  }
}

export function typeCode(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': return 'struct:' + t.mangled;
    case 'list': return 'list<' + typeCode(t.element) + '>';
    case 'uniqueList': return 'uniqueList<' + typeCode(t.element) + '>';
    case 'dict': return 'dict<' + typeCode(t.keyType) + '=>' + typeCode(t.valueType) + '>';
  }
}

export const NUMBER_TYPE: ChatterType = { kind: 'scalar', name: 'number' };
export const STRING_TYPE: ChatterType = { kind: 'scalar', name: 'string' };
export const BOOLEAN_TYPE: ChatterType = { kind: 'scalar', name: 'boolean' };
