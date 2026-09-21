/**
 * Prisma Store over a generated Prisma client.
 *
 * The model (default `agentSession`) needs five fields, renameable through
 * `fieldMappings.sessions`:
 *
 * ```prisma
 * model AgentSession {
 *   id        String   @id
 *   version   Int
 *   blob      Json
 *   createdAt DateTime @default(now())
 *   updatedAt DateTime @updatedAt
 * }
 * ```
 *
 * A first save is `create`, and Prisma's unique violation (`P2002`) is the
 * conflict; later saves are `updateMany` filtered on `{ id, version }`, and
 * `count === 0` is the conflict. 3.x read, checked and wrote in three steps
 * and tolerated a model without `version`; neither survives.
 */

import { isRecord } from "../utils/json.js";
import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { readBlob, toBlob } from "./sessionRow.js";

/** The delegate a generated client exposes per model. */
export interface PrismaSessionModel {
  create(params: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findUnique(params: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  updateMany(params: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/** Matches a generated Prisma client: model delegates by name, plus `$disconnect`. */
export interface PrismaClient {
  [model: string]: unknown;
  $disconnect?: () => Promise<void>;
}

export type PrismaSessionField = "id" | "version" | "blob" | "createdAt" | "updatedAt";

export interface PrismaStoreOptions {
  prisma: PrismaClient;
  /** Model name on the client. Default `agentSession`. */
  tables?: { sessions?: string };
  /** Field names when the model uses other names. */
  fieldMappings?: { sessions?: Partial<Record<PrismaSessionField, string>> };
}

export class PrismaStore<D = unknown> implements Store<D> {
  private readonly prisma: PrismaClient;
  private readonly model: PrismaSessionModel;
  private readonly field: Record<PrismaSessionField, string>;

  constructor(options: PrismaStoreOptions) {
    const name = options.tables?.sessions ?? "agentSession";
    const model = options.prisma[name];
    if (!isSessionModel(model)) {
      throw new TypeError(
        `[TypeError] PrismaStore cannot use model "${name}": the client has no such delegate with create, findUnique and updateMany. ` +
          `Add the model to schema.prisma and run prisma generate, or pass tables.sessions with its name.`,
      );
    }
    this.prisma = options.prisma;
    this.model = model;
    const custom = options.fieldMappings?.sessions ?? {};
    this.field = {
      id: custom.id ?? "id",
      version: custom.version ?? "version",
      blob: custom.blob ?? "blob",
      createdAt: custom.createdAt ?? "createdAt",
      updatedAt: custom.updatedAt ?? "updatedAt",
    };
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect?.();
  }

  async load(id: string): Promise<Session<D> | null> {
    const row = await this.model.findUnique({ where: { [this.field.id]: id } });
    return row ? readBlob<D>(row[this.field.blob], id) : null;
  }

  async save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    const next = expectedVersion + 1;
    const blob = toBlob(session, next);
    const now = new Date();
    const { field } = this;
    if (expectedVersion === 0) {
      try {
        await this.model.create({
          data: { [field.id]: session.id, [field.version]: next, [field.blob]: blob, [field.createdAt]: now, [field.updatedAt]: now },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new SessionConflictError(session.id, 0, await this.storedVersion(session.id));
      }
      return blob;
    }
    const { count } = await this.model.updateMany({
      where: { [field.id]: session.id, [field.version]: expectedVersion },
      data: { [field.version]: next, [field.blob]: blob, [field.updatedAt]: now },
    });
    if (count === 0) throw new SessionConflictError(session.id, expectedVersion, await this.storedVersion(session.id));
    return blob;
  }

  private async storedVersion(id: string): Promise<number | undefined> {
    const row = await this.model.findUnique({ where: { [this.field.id]: id } });
    const version = row?.[this.field.version];
    return typeof version === "number" ? version : undefined;
  }
}

function isSessionModel(value: unknown): value is PrismaSessionModel {
  return (
    isRecord(value) &&
    typeof value.create === "function" &&
    typeof value.findUnique === "function" &&
    typeof value.updateMany === "function"
  );
}

/** Prisma's `PrismaClientKnownRequestError` for a unique constraint hit. */
const isUniqueViolation = (error: unknown): boolean => isRecord(error) && error.code === "P2002";
