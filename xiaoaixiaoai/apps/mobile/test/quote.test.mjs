import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuotedMessage, previewQuoteText, splitQuotedPrefix } from "../src/lib/quote.ts";

test("previewQuoteText collapses whitespace and strips markdown fences cleanly", () => {
  const snippet = previewQuoteText("```ts\nconst x = 1;\n```\n\n> 第二行   细节说明");
  assert.equal(snippet, "const x = 1; 第二行 细节说明");
  assert.equal(previewQuoteText("你好".repeat(80), 20).length, 20);
});

test("formatQuotedMessage and splitQuotedPrefix round-trip cleanly", () => {
  const wire = formatQuotedMessage({ author: "爱弥斯", text: "测试通过了，\n还差一步部署" }, "先别部署，等我检查");
  assert.equal(wire, "> [引用 爱弥斯] 测试通过了， 还差一步部署\n\n先别部署，等我检查");
  assert.deepEqual(splitQuotedPrefix(wire), {
    quote: { author: "爱弥斯", text: "测试通过了， 还差一步部署" },
    body: "先别部署，等我检查",
  });
});

test("splitQuotedPrefix leaves normal messages and empty quotes untouched", () => {
  assert.deepEqual(splitQuotedPrefix("普通回复内容"), { body: "普通回复内容" });
  assert.equal(formatQuotedMessage(null, "  只回这句  "), "只回这句");
  assert.equal(formatQuotedMessage({ author: "我", text: "   " }, "继续"), "继续");
});
