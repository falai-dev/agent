/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Deep clone utility to avoid adding large dependencies like lodash.
 * Handles objects, arrays, dates, and primitives.
 * @param obj - The object to clone
 * @returns A deep copy of the object
 */
export function cloneDeep<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (obj instanceof Date) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return new Date(obj.getTime()) as any;
  }

  if (Array.isArray(obj)) {
    const arrCopy = [] as any[];
    for (let i = 0; i < obj.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      arrCopy[i] = cloneDeep(obj[i]);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return arrCopy as any;
  }

  const objCopy = {} as { [key: string]: any };
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      objCopy[key] = cloneDeep((obj as Record<string, unknown>)[key]);
    }
  }

  return objCopy as T;
}
