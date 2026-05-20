import type { ScalarTypeName } from './ast';

export type ChatterType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: ChatterType }
  | { kind: 'uniqueList'; element: ChatterType }
  | { kind: 'dict'; keyType: ChatterType; valueType: ChatterType }
  | { kind: 'struct'; mangled: string }
  | { kind: 'typeVar'; name: string };

export function unmangleTypeName(s: string): string {
  const idx = s.indexOf('::');
  return idx === -1 ? s : s.slice(idx + 2);
}

export function typesEqual(a: ChatterType, b: ChatterType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'scalar': return b.kind === 'scalar' && a.name === b.name;
    case 'struct': return b.kind === 'struct' && a.mangled === b.mangled;
    case 'typeVar': return b.kind === 'typeVar' && a.name === b.name;
    case 'list': return b.kind === 'list' && typesEqual(a.element, b.element);
    case 'uniqueList': return b.kind === 'uniqueList' && typesEqual(a.element, b.element);
    case 'dict': return b.kind === 'dict' && typesEqual(a.keyType, b.keyType) && typesEqual(a.valueType, b.valueType);
  }
}

export function typeToString(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': return 'struct ' + unmangleTypeName(t.mangled);
    case 'typeVar': return t.name;
    case 'list': return 'list of ' + typeToString(t.element);
    case 'uniqueList': return 'unique list of ' + typeToString(t.element);
    case 'dict': return 'dictionary from ' + typeToString(t.keyType) + ' to ' + typeToString(t.valueType);
  }
}

export function typeCode(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': return 'struct:' + t.mangled;
    case 'typeVar': return 'typevar:' + t.name;
    case 'list': return 'list<' + typeCode(t.element) + '>';
    case 'uniqueList': return 'uniqueList<' + typeCode(t.element) + '>';
    case 'dict': return 'dict<' + typeCode(t.keyType) + '=>' + typeCode(t.valueType) + '>';
  }
}

export function substituteTypeVars(t: ChatterType, map: Map<string, ChatterType>): ChatterType {
  switch (t.kind) {
    case 'typeVar': return map.get(t.name) ?? t;
    case 'scalar': return t;
    case 'struct': return t;
    case 'list': return { kind: 'list', element: substituteTypeVars(t.element, map) };
    case 'uniqueList': return { kind: 'uniqueList', element: substituteTypeVars(t.element, map) };
    case 'dict': return {
      kind: 'dict',
      keyType: substituteTypeVars(t.keyType, map),
      valueType: substituteTypeVars(t.valueType, map),
    };
  }
}

export function bindTypeVars(
  annotated: ChatterType,
  concrete: ChatterType,
  bindings: Map<string, ChatterType>,
): boolean {
  if (annotated.kind === 'typeVar') {
    const existing = bindings.get(annotated.name);
    if (existing !== undefined) {
      return typesEqual(existing, concrete);
    }
    bindings.set(annotated.name, concrete);
    return true;
  }
  if (annotated.kind !== concrete.kind) return false;
  switch (annotated.kind) {
    case 'scalar': return concrete.kind === 'scalar' && annotated.name === concrete.name;
    case 'struct': return concrete.kind === 'struct' && annotated.mangled === concrete.mangled;
    case 'list': return concrete.kind === 'list' && bindTypeVars(annotated.element, concrete.element, bindings);
    case 'uniqueList': return concrete.kind === 'uniqueList' && bindTypeVars(annotated.element, concrete.element, bindings);
    case 'dict': return concrete.kind === 'dict' &&
      bindTypeVars(annotated.keyType, concrete.keyType, bindings) &&
      bindTypeVars(annotated.valueType, concrete.valueType, bindings);
  }
}

export const NUMBER_TYPE: ChatterType = { kind: 'scalar', name: 'number' };
export const STRING_TYPE: ChatterType = { kind: 'scalar', name: 'string' };
export const BOOLEAN_TYPE: ChatterType = { kind: 'scalar', name: 'boolean' };
