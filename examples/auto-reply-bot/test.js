import test from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, normalizeText } from "./index.js";

test("matches complete messages without reacting to bot or webhook messages", async () => {
  const sent = [];
  const client = { user: { id: "bot-self" } };
  const handler = createMessageHandler(client, "Xin Chào", "Chào @everyone");
  const message = {
    guildId: "guild-1",
    author: { id: "human", bot: false },
    webhookId: null,
    content: "  XIN CHÀO  ",
    reply: async (payload) => sent.push(payload),
  };
  await handler(message);
  assert.deepEqual(sent, [{ content: "Chào @everyone", allowedMentions: { parse: [], repliedUser: false } }]);
  await handler({ ...message, author: { id: "another-bot", bot: true } });
  await handler({ ...message, author: { id: "bot-self", bot: false } });
  await handler({ ...message, webhookId: "webhook" });
  await handler({ ...message, guildId: null });
  await handler({ ...message, content: "xin chào bạn" });
  assert.equal(sent.length, 1);
  assert.equal(normalizeText("xin cha\u0300o"), normalizeText("XIN CHÀO"));
});

test("validates trigger and response before registering the handler", () => {
  const client = { user: { id: "bot-self" } };
  assert.throws(() => createMessageHandler(client, " ", "hello"), /AUTO_REPLY_TRIGGER/);
  assert.throws(() => createMessageHandler(client, "hi", " "), /AUTO_REPLY_RESPONSE/);
  assert.throws(() => createMessageHandler(client, "hi", "x".repeat(2001)), /AUTO_REPLY_RESPONSE/);
});
