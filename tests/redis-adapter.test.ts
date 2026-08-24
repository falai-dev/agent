import { describe, test, expect } from "bun:test";
import { RedisAdapter } from "../src/adapters/RedisAdapter";
import { createRedisStub } from "./redis-stub";
import type { MessageData } from "../src/types/persistence";
import { MessageRole } from "../src/types/history";


describe("RedisMessageRepository.findBySessionId", () => {
  test("sorts ISO-string timestamps chronologically before applying limit", async () => {
    const redis = createRedisStub();
    const adapter = new RedisAdapter({ redis });
    const base = 1_700_000_000_000;

    // Seed through the client exactly as create() stores them: createdAt
    // serializes to an ISO string inside the message JSON. Hash fields are
    // inserted out of time order so hash order can't masquerade as sort order.
    for (const i of [3, 1, 0, 4, 2]) {
      const message: MessageData = {
        id: `msg_${i}`,
        sessionId: "sess_1",
        role: MessageRole.USER,
        content: `message ${i}`,
        createdAt: new Date(base + i * 1000),
      };
      await redis.setex(`agent:message:msg_${i}`, 60, JSON.stringify(message));
      await redis.hset(
        "agent:session:sess_1:messages",
        `msg_${i}`,
        message.createdAt.toISOString()
      );
    }

    // Regression: with >= 2 messages the old comparator called .getTime()
    // on an ISO string and threw; and the old code applied the limit to
    // hash order before sorting, keeping an arbitrary subset.
    const messages = await adapter.messageRepository.findBySessionId(
      "sess_1",
      3
    );

    expect(messages.map((m) => m.id)).toEqual(["msg_0", "msg_1", "msg_2"]);
    for (const message of messages) {
      expect(message.createdAt).toBeInstanceOf(Date);
    }
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].createdAt.getTime()).toBeGreaterThan(
        messages[i - 1].createdAt.getTime()
      );
    }
  });

  test("returns all messages in chronological order under the default limit", async () => {
    const redis = createRedisStub();
    const adapter = new RedisAdapter({ redis });
    const base = 1_700_000_000_000;

    for (const i of [4, 0, 2, 1, 3]) {
      await redis.setex(
        `agent:message:msg_${i}`,
        60,
        JSON.stringify({
          id: `msg_${i}`,
          sessionId: "sess_1",
          role: MessageRole.USER,
          content: `message ${i}`,
          createdAt: new Date(base + i * 1000).toISOString(),
        })
      );
      await redis.hset(
        "agent:session:sess_1:messages",
        `msg_${i}`,
        new Date(base + i * 1000).toISOString()
      );
    }

    const messages = await adapter.messageRepository.findBySessionId("sess_1");
    expect(messages.map((m) => m.id)).toEqual([
      "msg_0",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
    ]);
  });
});

describe("RedisSessionRepository.delete", () => {
  test("removes the session from its user index so lookups stop chasing it", async () => {
    const redis = createRedisStub();
    const adapter = new RedisAdapter({ redis });

    await adapter.sessionRepository.create({
      id: "sess_9",
      userId: "user_1",
      status: "active",
      agentName: "test-agent",
    });
    expect(Object.keys(await redis.hgetall("agent:user:user_1:sessions"))).toEqual([
      "sess_9",
    ]);

    const deleted = await adapter.sessionRepository.delete("sess_9");
    expect(deleted).toBe(true);

    // Regression: delete() used to remove only the session key, leaving dead
    // ids in user:{id}:sessions forever.
    expect(await redis.hgetall("agent:user:user_1:sessions")).toEqual({});
    expect(await adapter.sessionRepository.findById("sess_9")).toBeNull();
    expect(
      await adapter.sessionRepository.findActiveByUserId("user_1")
    ).toBeNull();

    // Deleting an unknown session still reports false without touching indexes
    expect(await adapter.sessionRepository.delete("sess_9")).toBe(false);
    expect(await adapter.sessionRepository.delete("sess_missing")).toBe(false);
  });
});
