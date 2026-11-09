# magpie-lobsterai-auth

Youdao **LobsterAI** as a magpie / OpenCode provider: browser sign-in, an SSE-only OpenAI-compatible chat endpoint, and the daily check-in with its credits.

## Install

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-lobsterai-auth"
```

Turn it on under Plugins, then sign in.

## Sign in

```powershell
magpie plugin login lobsterai
```

Pick **浏览器登录 LobsterAI**:

1. magpie opens the LobsterAI portal; finish signing in there.
2. The browser is then sent to a loopback address on `127.0.0.1`. **The page failing to load is expected** -- nothing listens on that port.
3. Copy the whole address from the address bar back into the prompt, or just the `code=` value.

The sign-in stores an access token and a refresh token. A refresh needs three client identity fields (`uuid`, `firstKeyfrom`, `latestKeyfrom`), minted by the plugin at sign-in and sent back unchanged on every refresh; losing one means signing in again.

## Models

18 of them, wire id kept apart from the display name because some upstream ids carry a vendor date stamp. See the table in [README.md](./README.md).

## Check-in

Four steps: resolve the client version, read the activity slot, read its context, claim. Idempotency is the client's job, not a server business code -- the claim carries a one-off key, and the plugin checks both `claimedToday` and that `check_in` is an available action first.

## Two load-bearing headers

`X-LobsterAI-Client-Capabilities` gates the model set and the thinking-level control; dropping it silently changes what the gateway serves. `X-LobsterAI-Client-Version` identifies the client. The Tencent attribution headers are deliberately not sent.

## Known limits

- The endpoint is SSE-only: `stream: false` is answered 500. Every request goes upstream streaming; a non-streaming caller gets the stream folded into one answer.
- Text only.
- No quota endpoint, so no usage card is offered rather than a made-up number.

## Licence

MIT. Protocol facts were read from ChatLink (GPL-3.0); the code is an independent rewrite.
