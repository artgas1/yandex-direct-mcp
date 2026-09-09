# yandex-direct-mcp

An MCP server and command-line tool for the Yandex Direct API v5. All **113 methods**
are covered, generated from the machine-readable schema; nine are declared by
default — the ones you read with. The rest is one variable away, writes are off.

mcp-name: io.github.artgas1/yandex-direct-api-mcp

[![npm](https://img.shields.io/npm/v/yandex-direct-api-mcp)](https://www.npmjs.com/package/yandex-direct-api-mcp)
[![CI](https://github.com/artgas1/yandex-direct-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/artgas1/yandex-direct-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

*[Русский](./README.md)*

It runs as an MCP server for Claude Code, Cursor, Codex and other clients, and as
an ordinary command if you don't need MCP at all.

## What it does — in five seconds

<img src="https://raw.githubusercontent.com/artgas1/yandex-direct-mcp/main/assets/demo.gif" alt="A terminal recording: a direct_campaigns_get call and two columns — on the left the response body parsed with plain JSON.parse, on the right the same data after the server. Budget 1000000000 against 1000, an ad identifier mangled by parsing against the exact one, an Items wrapper against a plain list, and a failure carrying HTTP 202 recognised as a failure." width="100%">

<sup>Both columns are real: the left one is the response body parsed with plain
<code>JSON.parse</code>, exactly as any client would get it; the right one is what the
server returned over JSON-RPC. The identifier row proves itself — the left value is
mangled not because the picture says so, but because parsing genuinely mangles it.
No token, no network: requests go to a local stub, so the run repeats anywhere,
CI included. Run it yourself with <code>npm run demo</code>, re-record with <code>npm run demo:record</code>
(needs <a href="https://github.com/charmbracelet/vhs">vhs</a>).</sup>


```bash
npx -y yandex-direct-api-mcp
```

## Coverage

| what is covered | services | methods | of them in `core` | example tools |
| --- | ---: | ---: | ---: | --- |
| Campaigns and ads | 9 | 37 | 3 | `direct_adgroups_get`, `direct_ads_get` |
| Targeting | 9 | 45 | 1 | `direct_keywords_get` |
| Bids and strategies | 4 | 15 | 2 | `direct_bidmodifiers_get`, `direct_keywordbids_get` |
| Reports and dictionaries | 6 | 9 | 2 | `direct_dictionaries_get`, `direct_reports_get` |
| Clients and agencies | 2 | 7 | 1 | `direct_clients_get` |
| **total** | **30** | **113** | **9** | plus four service tools: `direct_catalog`, `direct_fields`, `direct_schema`, `direct_inventory` |

The table is computed from the spec (`npm run coverage`) rather than typed by
hand: numbers in prose drift away from the schema silently, and a stale number
looks exactly like a true one.

## Quick start

You need a Yandex OAuth token with the `direct:api` scope — https://oauth.yandex.ru/
(the application must have an approved request for access to the Direct API).

**MCP:**

```json
{
  "mcpServers": {
    "yandex-direct": {
      "command": "npx",
      "args": ["-y", "yandex-direct-api-mcp"],
      "env": { "YANDEX_DIRECT_TOKEN": "your-token" }
    }
  }
}
```

**Command line:**

```bash
export YANDEX_DIRECT_TOKEN="your-token"

yandex-direct-mcp catalog --service campaigns
yandex-direct-mcp describe campaigns.get
yandex-direct-mcp call campaigns.get --FieldNames Id --FieldNames Name
```

## What this server handles for you

Not conveniences. Every item below is a place where a direct call to Direct goes
wrong **silently**: the response looks fine, nothing raises an error, and the
number or the conclusion drawn from it is wrong. All of it was taken from runs
against the live API, not read out of the documentation.

### Money always arrives multiplied by a million

```
DailyBudget.Amount = 1000000000     ← this is 1000 units of the account currency
Cost               = 1234500000     ← this is 1234.50 units of the account currency
```

The error is off by exactly one million, and it doesn't look like an error: the
number is plausible, you can add it up, divide it and plot it. The
`returnMoneyInMicros` header, which switches micro-units off in reports, **has no
effect on ordinary services** — checked against `campaigns`, the value did not
change.

The server converts amounts into the account currency and lists in the response
exactly which fields it converted:

```json
"_мета": { "суммы_переведены_из_микроединиц": ["Amount", "Refund", "Spend"] }
```

The server's own envelope keys are Russian, and they stay that way: `_мета` is
the metadata block attached to every response, and
`суммы_переведены_из_микроединиц` means "amounts converted from micro-units".

### Ad ids do not fit into a JavaScript number

A typical ad `Id` is `1234567890123456789` — nineteen digits. `JSON.parse` holds
fifteen and turns it into `1234567890123456800`.

This is not a one-off curiosity: nineteen-digit ids showed up in every account
checked, and not as isolated specimens. Yandex's schema declares 358 fields as
`xsd:long`, so a range of up to 19 digits is normal by contract.

The dangerous part is not the shift itself but how it surfaces: **Direct accepts
the mangled id** and answers `HTTP 200` with the body `{"result":{}}`. There is no
failure — there is a message saying "no such ad". Emptiness passed off as proof of
absence.

The server parses the body so that long integers stay exact. It was separately
verified that the API accepts an id as a string, so precision holds along the
whole path — on reads and on writes alike.

### Success is decided by the body, not by the status code

| what was asked | code | what's in the body |
|---|---|---|
| invalid `FieldNames` | **200** | `error_code: 8000` |
| unknown method | **202** | `error_code: 55` |
| error in a report | **400** | `error_code: "8000"` — a string, not a number |
| report queued | **201** | empty, `retryIn: 1` |
| report still computing | **202** | empty, `retryIn: 10` |

The same `202` means a rejection for `campaigns` and "still computing" for
`reports`. A `res.ok` check waves through the first three rows of that table: the
rejection reaches the model as a successful answer.

### A report does not arrive right away

`201` → `202` → `200`. Measured: three requests before it was ready. The retry
goes out with the same `ReportName` — the name *is* the key of the queued job. The
server does the waiting for you.

### The version in the path changes the data

One and the same request:

```
/json/v5/campaigns    → N campaigns, all with Type = TEXT_CAMPAIGN
/json/v501/campaigns  → the same N,  all with Type = UNIFIED_CAMPAIGN
```

These are two different representations with two different sets of deep fields,
and a mismatch takes those fields away without any sign that it happened:

| path | field set | deep fields |
|---|---|---|
| `v5` | `TextCampaignFieldNames` | returned |
| `v5` | `UnifiedCampaignFieldNames` | **empty, no error** |
| `v501` | `TextCampaignFieldNames` | **empty, no error** |
| `v501` | `UnifiedCampaignFieldNames` | returned |

Strategy, settings and counters are simply missing — which reads as "nothing is
configured on this campaign". The default is `v501` (the documentation gives that
address and no other); `DIRECT_API_VERSION=v5` switches it, the chosen version is
printed in every response, and a field set that doesn't match the version raises a
warning.

### The campaign list is incomplete

Campaigns created through Campaign Wizard (Мастер кампаний) are not returned by
`campaigns.get` at all — not in a listing, not by explicit `Ids`; the response is
empty and carries no error. Neither `v5` nor `v501` changes that.

So the inventory of an account is assembled by a separate tool,
**`direct_inventory`**: it joins the campaign list with a report and tags every
row with the source it came from. A warning in the tool description is not enough
here — it would require the reader to remember it at the moment of drawing a
conclusion, and the conclusion is drawn from data that looks perfectly normal.

Run against a live account: the union came out one campaign longer than the list,
and that row was visible only to the report. A campaign invisible to
`campaigns.get` can still be spending, and it may carry **the bulk of the
impressions** — from the campaign list there is no way to notice.

```
ВНИМАНИЕ: 1 кампаний откручивались, но методом campaigns.get НЕ отдаются
          (10000017). Управлять ими через API нельзя — только в интерфейсе.
```

That is the server's warning, verbatim: "1 campaigns were delivering impressions
but are NOT returned by `campaigns.get` (10000017). They cannot be managed through
the API — only in the web interface."

### A warning means applied, not rejected

In the response to `add`/`update`, every input element gets an output element
back. You tell them apart by `Errors`; `Warnings` means "applied, with a remark".
Counting by the presence of any content at all gives you "everything rejected"
where in fact everything was applied. The server states the outcome on a line of
its own:

```
UpdateResults: применено 2, отклонено 1, с предупреждениями 1
```

That is: 2 applied, 1 rejected, 1 with warnings.

### The shape of a list is set by its type, not by the direction of travel

```
RegionIds            (maxOccurs=unbounded) → [225, 977]
RestrictedRegionIds  (type ArrayOfLong)    → {"Items": [225]}
```

Both shapes behave identically on reads and on writes. The server strips and
restores the wrapper according to the type graph, not according to what the value
happens to look like, so the read → edit → write loop does not break. From where
you sit, both are ordinary arrays.

### The account is named in every response

`Client-Login` really does switch accounts, and getting it wrong is silent. A
login that doesn't exist is rejected with code 8800 — you see that immediately. A
login that exists but isn't the one you meant returns complete, correct data,
just from a different account: by the shape of the response the two are
indistinguishable.

So the server asks the API who is answering, and writes the answer into every
envelope:

```json
"_мета": { "кабинет": "example-login (ClientId 1234567)", "версия_api": "v501" }
```

`кабинет` is the advertising account that actually served the request, and
`версия_api` is the API path version it was served under.

It is asked once per process and cached — `clients.get` costs 10 points.

## Surface

The descriptions of every declared tool sit in the model's context **on every
turn**, whether you call them or not. So by default the server declares not
everything the API can do, but the part that gets used.

<img src="https://raw.githubusercontent.com/artgas1/yandex-direct-mcp/main/assets/surface.gif" alt="All 113 Direct API methods listed: nine kept and highlighted, 104 struck out. The default manifest is 27,028 bytes against 143,706 for the full catalogue." width="100%">

`tools/list` measured against the built server (`npm run surface`):

| profile | tools | bytes | ≈ tokens |
|---|---|---|---|
| **`core`** (default) | 13 | 27,028 | 12,455 |
| `read` | 37 | 61,158 | 28,183 |
| `all` + `DIRECT_ALLOW_WRITES=1` | 117 | 143,706 | 66,224 |

The default is 5.3× lighter than the full set. The main lever is that nested types
are not expanded into the schema: taken transitively, `campaigns.add` is 1083
fields and 54 KB for a single tool. Instead of expanding them, the makeup of a
type is spelled out in words in the description, and the exact schema is served on
request by the `direct_schema` tool.

Whatever you can't see, the server will tell you about itself: the
`direct_catalog` tool lists all 113 methods and says which of them are hidden and
how to switch them on.

## Writes are off by default

Of the 113 methods, **80 change data and 16 delete it**. Direct has no
confirmation step: `suspend` stops impressions at the moment of the call, `archive`
takes a campaign out of service, `delete` is irreversible — and there is money on
the other end.

Mutating tools **are not declared at all** until `DIRECT_ALLOW_WRITES=1` is set.
Declaring them and then refusing at call time is the worst of both worlds: you pay
the full context price and still can't call them.

An unknown profile name is a startup failure, not a fall back to the full surface:
a misconfigured restriction must not turn into the absence of a restriction.

There is a sandbox: `DIRECT_SANDBOX=1` (it needs its own registration and its own
token). The fact that it is on is printed at startup and in every response.

## Settings

| variable | default | what it does |
|---|---|---|
| `YANDEX_DIRECT_TOKEN` | — | OAuth token, `direct:api` scope. Required |
| `YANDEX_DIRECT_LOGIN` | — | account login (**not** the email). Really does switch accounts: under one and the same token it serves a different account with its own quota. The server names the account it actually reached in every response |
| `DIRECT_PROFILE` | `core` | `core`, `read`, `all` |
| `DIRECT_TOOLS` | — | explicit list of services or tools; overrides the profile |
| `DIRECT_ALLOW_WRITES` | off | declare the tools that change data |
| `DIRECT_API_VERSION` | `v501` | `v501` or `v5` — changes the campaign representation |
| `DIRECT_SANDBOX` | off | sandbox instead of the live account |
| `DIRECT_MAX_OUTPUT_CHARS` | `60000` | ceiling on the response; truncation is stated out loud |

## Where the tools come from

Not a single method is described by hand.

| source | what it gives | why it's needed |
|---|---|---|
| WSDL of 29 services + 3 shared XSDs | structure, types, requiredness, arity, enumerations | the only complete one: the documentation index has no `vcards`, `smartadtargets`, `dynamictextadtargets`, `dynamicfeedadtargets` |
| documentation pages | human-readable descriptions | there is not a single `xs:documentation` in the WSDL |
| described explicitly | the `reports` service | Direct does not serve a WSDL for it (404) |

The result: **30 services, 113 methods, 609 types, 240 enumerations.**

```bash
npm run spec:fetch    # download the WSDL and the documentation into .cache/
npm run spec:build    # build spec/direct-api.json
```

⚠️ **The enumerations in the schema lag behind the live API**, and for that reason
they are not turned into a hard filter — they go into the description as a hint.
Checked against the live API: `campaigns` accepts `CreateTime`, and `keywords`
accepts `AutotargetingBrief`, `AutotargetingBriefSuggests` and
`AutotargetingMode`, none of which are in the schema. Filtering against a lagging
list would forbid what the API can actually do, and the refusal would look like a
missing capability. The right to decide stays with the API.

## Checks


```bash
npm test         # 67 tests, negative controls included
npm run surface  # measure the surface per profile
npm run coverage # the coverage table for the README
npm run graphic  # rebuild the surface graphic (SVG and GIF)
npm run smoke    # run the built server against the live API (token required)
```

The tests carry a negative control for every invariant — that is, they are able to
fail on the very defect they were written for: on a mangled id, on an error
carrying code 202, on an empty `get` schema, on a service going missing, and on
warnings read as rejections.

## Skill — working without MCP

For agents that don't need MCP, or can't have it:

```bash
npx skills add artgas1/yandex-direct-mcp
```

This installs a single canonical copy into `.agents/skills/yandex-direct/` and
links it into the agents' directories. The skill is a thin layer over the same
command: it has no logic of its own, so there is nothing in it that could drift
away from the server.

## If you're choosing between servers

Plenty of servers for Direct have been written. The useful questions to put to any
of them are the ones listed above: does it convert amounts out of micro-units; do
nineteen-digit ids survive parsing; does it treat `HTTP 200` with an `error` body
as success; does it wait for the report after `201`; does it tell `Warnings` from
`Errors`; what does it do with a typo in the profile name. Each answer costs one
call.

## License

MIT.
