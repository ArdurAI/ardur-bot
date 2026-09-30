function serializeString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("Lone surrogate");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Lone surrogate");
    }
  }
  return JSON.stringify(value);
}

/** RFC 8785 with the independent checker's safe-integer restriction. */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return serializeString(value);
    if (typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      const encoded = JSON.stringify(value);
      if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value) && !encoded.includes("e")) {
        throw new TypeError("Unsafe integer");
      }
      return encoded;
    }
    if (typeof value !== "object") throw new TypeError("Unsupported JSON value");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      throw new TypeError("Expected a plain object");
    }
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Symbol key");
    if (ancestors.has(value)) throw new TypeError("Circular JSON value");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const entries: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) throw new TypeError("Array hole");
          entries.push(encode(value[i]));
        }
        return `[${entries.join(",")}]`;
      }
      return `{${Object.keys(value)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) throw new TypeError("Accessor property");
          return `${serializeString(key)}:${encode(descriptor.value)}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(value);
}
