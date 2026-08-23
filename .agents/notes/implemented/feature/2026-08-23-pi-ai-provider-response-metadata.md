# Agent Note: pi-ai provider response metadata

Status: implemented

English | [中文](2026-08-23-pi-ai-provider-response-metadata.zh.md)

## Problem

A provider says things beside the response body that never reach the harness. The one that matters today is subscription accounting: a Codex route answers every request with `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, and `x-codex-primary-reset-at` — the state of the plan's rate-limit windows, refreshed on each request. A UI that wants to show how much of the week a subscription has spent has nowhere to read it.

Nothing in the harness reads provider response headers. `stream.ts` maps a closed union of pi-ai `AssistantMessageEvent`s, and pi-ai has already collapsed the HTTP response by then: the status is gone and the headers were never carried. The only place either exists is inside pi-ai's API implementations.

The obvious alternative source is the account endpoint the same backend serves, `GET /backend-api/codex/usage`, which returns the same numbers as JSON. It is unusable from the harness: Cloudflare answers a Node HTTP client with `cf-mitigated: challenge` and 403 there, while leaving `/codex/responses` alone. The data the harness can legitimately reach is the data riding the requests it already makes.

## Decision

`llm-pi-ai` passes pi-ai's `onResponse` stream option and re-publishes what it reports as a cordis event:

```
'llm-pi-ai/provider-response'(detail: {
  provider: string
  model: string
  status: number
  headers: Readonly<Record<string, string>>
}): void
```

Headers are verbatim and uninterpreted. This plugin is a generic bridge over every pi-ai route, and header vocabulary is per-provider — quota windows, deprecation notices, request ids — so naming any one provider's fields here would put that provider's format in the generic layer. A listener that understands a route interprets that route's headers itself.

The adapter reaches it through a `PiAiAdapterOptions.onProviderResponse` callback, matching `onReplayDegrade`: the adapter states the observation, `index.ts` decides it is an event. The option is passed to `streamSimple` only when a callback exists, so a composition with no listener adds nothing to the request path.

The emit is wrapped in try/catch at the wiring site. pi-ai `await`s this callback inside the request, before the body is read, so an uncontained listener throw would fail the generation it is only watching.

## What it does not promise

Two absences are contract, not oversight:

- **SSE only.** pi-ai's WebSocket transport has no HTTP response to observe and never calls `onResponse`. A deployment that needs this pins `transport: sse`.
- **Not every response.** Which responses reach `onResponse` is each pi-ai API's decision. The Codex path calls it immediately after `fetch`, before inspecting the status, so failures report. The OpenAI-completions path calls it only once the SDK call resolved, so a 401 never arrives. A listener reads an absent event as no information, never as success.

This is why the event informs a readout and not error handling: it cannot see every failure, and an observer cannot change a request's outcome.

## Alternatives considered

**Parse the headers here and emit a typed rate-limit event.** Rejected: it puts `x-codex-*` — one vendor's format — inside the plugin that serves every pi-ai route, and the next provider with its own accounting headers would either be bolted onto the same type or ignored. The generic layer reports what the transport saw; the consumer owns the vocabulary.

**Poll the provider's own usage endpoint from the consumer.** Rejected on evidence: `GET /backend-api/codex/usage` answers a Node client with a Cloudflare challenge (403) while curl on HTTP/1.1 gets 200. Reaching it would mean choosing a client to slip past a bot-management control the operator deliberately applied. The header path is first-party, needs no second request, no second credential read, and updates on every turn rather than on a poll interval.

**Extend `StreamChunk` with a metadata chunk.** Rejected: `StreamChunk` is the model-visible stream, and this is transport metadata that must not reach a request or the session log. Every consumer of the chunk union would gain a case for something none of them model.

**Put the event in `dsh-llm` so any adapter family can emit it.** Deferred: pi-ai is the only adapter family with the hook today, and the harness rule is that an abstraction needs a current owner. Moving it up is mechanical when a second family arrives.

## Consequences

A consumer can now read per-request provider metadata without owning the request path — which is what makes a Codex quota readout possible from a plugin, instead of requiring a fork of the Codex provider to get at its HTTP response.

The cost is a per-request notification whose delivery depends on the transport and on upstream pi-ai internals, documented as such. Because the payload is untyped headers, a consumer that misreads a header gets no compile-time help; the alternative was giving one provider's vocabulary to a generic package.

`Provider HTTP status is unavailable` in the package README narrowed rather than disappeared: the status is observable out of band, but not on every failure and not in the stream.

## Testing

`tests/adapter.spec.ts` covers the reported status and headers against the mock server, and that a throwing listener leaves the generation finishing `stop`. `tests/mock-server.ts` now applies scripted `headers` to the streaming 200 branch too, which it previously dropped.
