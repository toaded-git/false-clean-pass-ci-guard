export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return serializeJsonValue(value, "$");
}

function serializeJsonValue(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serializeJsonValue(item, `${path}[${index}]`)).join(",")}]`;
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number at ${path}.`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (!isPlainObject(value)) {
        throw new TypeError(`Cannot canonicalize non-plain object at ${path}.`);
      }
      const entries = Object.keys(value)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined) {
            throw new TypeError(`Cannot canonicalize undefined value at ${path}.${key}.`);
          }
          return `${JSON.stringify(key)}:${serializeJsonValue(item, `${path}.${key}`)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}.`);
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
