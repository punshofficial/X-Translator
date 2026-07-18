"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "tweet-data.js"), "utf8");
const bridgeSource = fs.readFileSync(path.join(__dirname, "..", "x-data-bridge.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const tweetData = context.XTranslatorTweetData;
const bridgeDataContext = vm.createContext({ URL });
vm.runInContext(bridgeSource, bridgeDataContext);
const pageBridge = bridgeDataContext.XTranslatorPageBridge;

function sampleTimelineResponse() {
  return {
    data: {
      home: {
        instructions: [{
          entries: [{
            content: {
              itemContent: {
                tweet_results: {
                  result: {
                    __typename: "Tweet",
                    rest_id: "100",
                    legacy: {
                      full_text: "Main post is truncated",
                      lang: "en",
                      display_text_range: [0, 22],
                      entities: {},
                    },
                    note_tweet: {
                      note_tweet_results: {
                        result: {
                          text: "Main post is complete 🚀\nhttps://t.co/main",
                          entity_set: {
                            hashtags: [],
                            symbols: [],
                            user_mentions: [],
                            urls: [{
                              indices: [29, 46],
                              url: "https://t.co/main",
                              display_url: "example.com/main",
                              expanded_url: "https://example.com/main",
                            }],
                          },
                        },
                      },
                    },
                    quoted_status_result: {
                      result: {
                        __typename: "TweetWithVisibilityResults",
                        tweet: {
                          __typename: "Tweet",
                          rest_id: "200",
                          legacy: {
                            full_text: "Quoted post has its own complete text.",
                            lang: "en",
                            display_text_range: [0, 38],
                            entities: {
                              user_mentions: [{
                                indices: [0, 6],
                                screen_name: "alice",
                              }],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }],
        }],
      },
    },
  };
}

function longQuotedPostResponse() {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{
                entries: [{
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: "Tweet",
                          rest_id: "400",
                          legacy: {
                            full_text: "Outer post",
                            lang: "en",
                            entities: {},
                          },
                          quoted_status_result: {
                            result: {
                              __typename: "Tweet",
                              rest_id: "2078493463910215970",
                              legacy: {
                                full_text: "This is the truncated preview that",
                                lang: "en",
                                display_text_range: [0, 34],
                                entities: {},
                              },
                              note_tweet: {
                                is_expandable: true,
                                note_tweet_results: {
                                  result: {
                                    text: "This is the truncated preview that continues to the real ending.",
                                    entity_set: {
                                      hashtags: [],
                                      symbols: [],
                                      user_mentions: [],
                                      urls: [],
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                }],
              }],
            },
          },
        },
      },
    },
  };
}

test("collectTweetRecords keeps the main post and quoted post as different resources", () => {
  const records = pageBridge.collectTweetRecords(sampleTimelineResponse());
  const byId = new Map(records.map((record) => [record.id, record]));

  assert.equal(byId.size, 2);
  assert.equal(byId.get("100").text, "Main post is complete 🚀\nhttps://t.co/main");
  assert.equal(byId.get("100").quotedId, "200");
  assert.equal(byId.get("100").textSource, "note");
  assert.equal(byId.get("100").entities[0].type, "url");
  assert.equal(byId.get("100").entities[0].href, "https://example.com/main");
  assert.equal(byId.get("200").text, "Quoted post has its own complete text.");
  assert.equal(byId.get("200").quotedId, "");
});

test("collectTweetRecords supports the current schema with legacy fields moved to the Tweet", () => {
  const records = pageBridge.collectTweetRecords({
    data: {
      tweetResult: {
        result: {
          __typename: "Tweet",
          rest_id: "300",
          legacy: null,
          full_text: "Tom &amp; Jerry @cat #cartoon $TV",
          lang: "en",
          display_text_range: [0, 36],
          entities: {
            user_mentions: [{ indices: [16, 20], screen_name: "cat" }],
            hashtags: [{ indices: [21, 29], text: "cartoon" }],
            symbols: [{ indices: [30, 33], text: "TV" }],
          },
        },
      },
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, "300");
  assert.equal(records[0].text, "Tom & Jerry @cat #cartoon $TV");
  assert.deepEqual(
    Array.from(records[0].entities, (entity) => entity.type),
    ["mention", "hashtag", "cashtag"],
  );
});

test("collectTweetRecords prefers the complete Note Tweet inside a quoted post", () => {
  const records = pageBridge.collectTweetRecords(longQuotedPostResponse());
  const quoted = records.find((record) => record.id === "2078493463910215970");

  assert.ok(quoted);
  assert.equal(
    quoted.text,
    "This is the truncated preview that continues to the real ending.",
  );
  assert.equal(quoted.textSource, "note");
});

test("sanitizeTweetDataEnvelope rejects spoofed records and keeps bounded valid data", () => {
  const envelope = tweetData.sanitizeTweetDataEnvelope({
    version: 1,
    operation: "HomeTimeline",
    records: [
      { id: "100", text: "Valid post", lang: "en", quotedId: "200", entities: [] },
      { id: "not-an-id", text: "Invalid post", entities: [] },
      { id: "200", text: "", entities: [] },
    ],
  });

  assert.equal(envelope.operation, "HomeTimeline");
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].id, "100");
});

test("the page bridge observes a GraphQL response without replacing its result", async () => {
  const events = [];
  const response = {
    ok: true,
    type: "basic",
    headers: { get: () => "application/json" },
    clone() {
      return { json: async () => sampleTimelineResponse() };
    },
  };
  const bridgeContext = vm.createContext({
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document: { dispatchEvent: (event) => events.push(event) },
    fetch: async () => response,
    setTimeout,
    URL,
  });
  vm.runInContext(bridgeSource, bridgeContext);

  const returned = await bridgeContext.fetch("https://x.com/i/api/graphql/hash/HomeTimeline");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(returned, response);
  assert.equal(events.length, 1);
  const envelope = JSON.parse(events[0].detail);
  assert.equal(envelope.operation, "HomeTimeline");
  assert.deepEqual(envelope.records.map((record) => record.id).sort(), ["100", "200"]);
});

test("the page bridge observes an XHR UserTweets response with a complete long post", () => {
  const events = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.responseType = "json";
      this.response = longQuotedPostResponse();
      this.status = 200;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type) {
      for (const listener of [...(this.listeners.get(type) || [])]) listener.call(this);
    }

    getResponseHeader(name) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }

    open(method, url) {
      this.method = method;
      this.url = url;
      return "open-result";
    }

    send() {
      this.emit("load");
      this.emit("loadend");
      return "send-result";
    }
  }

  const bridgeContext = vm.createContext({
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document: { dispatchEvent: (event) => events.push(event) },
    fetch: async () => {
      throw new Error("fetch must not be used by this test");
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    URL,
  });
  vm.runInContext(bridgeSource, bridgeContext);

  const request = new bridgeContext.XMLHttpRequest();
  assert.equal(
    request.open("GET", "https://x.com/i/api/graphql/hash/UserTweets"),
    "open-result",
  );
  assert.equal(request.send(), "send-result");

  assert.equal(events.length, 1);
  const envelope = JSON.parse(events[0].detail);
  assert.equal(envelope.operation, "UserTweets");
  const quoted = envelope.records.find((record) => record.id === "2078493463910215970");
  assert.ok(quoted);
  assert.equal(
    quoted.text,
    "This is the truncated preview that continues to the real ending.",
  );
  assert.equal(quoted.textSource, "note");

  const textRequest = new bridgeContext.XMLHttpRequest();
  textRequest.responseType = "";
  textRequest.response = null;
  textRequest.responseText = JSON.stringify(longQuotedPostResponse());
  textRequest.open("GET", "https://x.com/i/api/graphql/hash/UserTweets");
  textRequest.send();

  assert.equal(events.length, 2);
  const textEnvelope = JSON.parse(events[1].detail);
  assert.ok(textEnvelope.records.some((record) => (
    record.id === "2078493463910215970" && record.textSource === "note"
  )));
});
