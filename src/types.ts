import type { ScalarTypeName } from './ast';

export type ChatterType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'list'; element: ChatterType }
  | { kind: 'uniqueList'; element: ChatterType }
  | { kind: 'dict'; keyType: ChatterType; valueType: ChatterType }
  | { kind: 'struct'; mangled: string; genericBase?: string; typeArgs?: ChatterType[] }
  | { kind: 'mutableStruct'; mangled: string; genericBase?: string; typeArgs?: ChatterType[] }
  | { kind: 'typeVar'; name: string }
  | { kind: 'optional'; element: ChatterType };

export function unmangleTypeName(s: string): string {
  const idx = s.indexOf('::');
  const unprefixed = idx === -1 ? s : s.slice(idx + 2);
  const genIdx = unprefixed.indexOf('$');
  return genIdx === -1 ? unprefixed : unprefixed.slice(0, genIdx);
}

/** Encode a type for monomorphized generic names and aggregate metadata. */
export function typeCode(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': return 'struct:' + t.mangled;
    case 'mutableStruct': return 'mstruct:' + t.mangled;
    case 'typeVar': return 'typevar:' + t.name;
    case 'list': return 'list:' + typeCode(t.element);
    case 'uniqueList': return 'uniqueList:' + typeCode(t.element);
    case 'dict': return 'dict:' + typeCode(t.keyType) + ':to:' + typeCode(t.valueType);
    case 'optional': return 'opt:' + typeCode(t.element);
  }
}

/** Build the concrete mangled name for one generic struct instantiation. */
export function monomorphizedStructName(baseMangled: string, args: ChatterType[]): string {
  return `${baseMangled}$${args.map(typeCode).join('$')}`;
}

export function typesEqual(a: ChatterType, b: ChatterType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'scalar': return b.kind === 'scalar' && a.name === b.name;
    case 'struct': {
      if (b.kind !== 'struct') return false;
      if (a.genericBase && b.genericBase && a.genericBase === b.genericBase && a.typeArgs && b.typeArgs && a.typeArgs.length === b.typeArgs.length) {
        return a.typeArgs.every((arg, i) => typesEqual(arg, b.typeArgs![i]));
      }
      return a.mangled === b.mangled;
    }
    case 'mutableStruct': {
      if (b.kind !== 'mutableStruct') return false;
      if (a.genericBase && b.genericBase && a.genericBase === b.genericBase && a.typeArgs && b.typeArgs && a.typeArgs.length === b.typeArgs.length) {
        return a.typeArgs.every((arg, i) => typesEqual(arg, b.typeArgs![i]));
      }
      return a.mangled === b.mangled;
    }
    case 'typeVar': return b.kind === 'typeVar' && a.name === b.name;
    case 'list': return b.kind === 'list' && typesEqual(a.element, b.element);
    case 'uniqueList': return b.kind === 'uniqueList' && typesEqual(a.element, b.element);
    case 'dict': return b.kind === 'dict' && typesEqual(a.keyType, b.keyType) && typesEqual(a.valueType, b.valueType);
    case 'optional': return b.kind === 'optional' && typesEqual(a.element, b.element);
  }
}

export function typeToString(t: ChatterType): string {
  switch (t.kind) {
    case 'scalar': return t.name;
    case 'struct': {
      if (t.genericBase && t.typeArgs && t.typeArgs.length > 0) {
        return `${unmangleTypeName(t.genericBase)} of ${t.typeArgs.map(typeToString).join(' and ')}`;
      }
      return 'struct ' + unmangleTypeName(t.mangled);
    }
    case 'mutableStruct': {
      if (t.genericBase && t.typeArgs && t.typeArgs.length > 0) {
        return `mutable ${unmangleTypeName(t.genericBase)} of ${t.typeArgs.map(typeToString).join(' and ')}`;
      }
      return 'mutable ' + unmangleTypeName(t.mangled);
    }
    case 'typeVar': return t.name;
    case 'list': return 'list of ' + typeToString(t.element);
    case 'uniqueList': return 'unique list of ' + typeToString(t.element);
    case 'dict': return 'dictionary from ' + typeToString(t.keyType) + ' to ' + typeToString(t.valueType);
    case 'optional': return 'optional ' + typeToString(t.element);
  }
}

export function substituteTypeVars(t: ChatterType, map: Map<string, ChatterType>): ChatterType {
  switch (t.kind) {
    case 'typeVar': return map.get(t.name) ?? t;
    case 'scalar': return t;
    case 'struct':
    case 'mutableStruct': {
      if (!t.typeArgs) return t;
      const typeArgs = t.typeArgs.map(arg => substituteTypeVars(arg, map));
      const genericBase = t.genericBase;
      return {
        kind: t.kind,
        genericBase,
        typeArgs,
        mangled: genericBase ? monomorphizedStructName(genericBase, typeArgs) : t.mangled,
      };
    }
    case 'list': return { kind: 'list', element: substituteTypeVars(t.element, map) };
    case 'uniqueList': return { kind: 'uniqueList', element: substituteTypeVars(t.element, map) };
    case 'dict': return {
      kind: 'dict',
      keyType: substituteTypeVars(t.keyType, map),
      valueType: substituteTypeVars(t.valueType, map),
    };
    case 'optional': return { kind: 'optional', element: substituteTypeVars(t.element, map) };
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
    case 'struct':
    case 'mutableStruct': {
      if (concrete.kind !== annotated.kind) return false;
      if (annotated.genericBase && concrete.genericBase && annotated.genericBase === concrete.genericBase && annotated.typeArgs && concrete.typeArgs && annotated.typeArgs.length === concrete.typeArgs.length) {
        for (let i = 0; i < annotated.typeArgs.length; i++) {
          if (!bindTypeVars(annotated.typeArgs[i], concrete.typeArgs[i], bindings)) return false;
        }
        return true;
      }
      return annotated.mangled === concrete.mangled;
    }
    case 'list': return concrete.kind === 'list' && bindTypeVars(annotated.element, concrete.element, bindings);
    case 'uniqueList': return concrete.kind === 'uniqueList' && bindTypeVars(annotated.element, concrete.element, bindings);
    case 'dict': return concrete.kind === 'dict' &&
      bindTypeVars(annotated.keyType, concrete.keyType, bindings) &&
      bindTypeVars(annotated.valueType, concrete.valueType, bindings);
    case 'optional': return concrete.kind === 'optional' && bindTypeVars(annotated.element, concrete.element, bindings);
  }
}

export const NUMBER_TYPE: ChatterType = { kind: 'scalar', name: 'number' };
export const STRING_TYPE: ChatterType = { kind: 'scalar', name: 'string' };
export const BOOLEAN_TYPE: ChatterType = { kind: 'scalar', name: 'boolean' };
