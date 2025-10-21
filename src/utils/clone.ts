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
    return new Date(obj.getTime()) as T;
  }

  if (Array.isArray(obj)) {
    const arrCopy: unknown[] = [];
    for (let i = 0; i < obj.length; i++) {
       
      arrCopy[i] = cloneDeep(obj[i]);
    }
    return arrCopy as T;
  }

  const objCopy: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      objCopy[key] = cloneDeep((obj as Record<string, unknown>)[key]);
    }
  }

  return objCopy as T;
}
