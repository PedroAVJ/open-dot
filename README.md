# Open Dot

Dot is a native iPhone app backed by the harness on your Mac mini.
The app is compiled from Bend using [PedroAVJ/f](https://github.com/PedroAVJ/f).
It keeps the existing dark conversation components and glass controls.
Bend owns UI state, layout, JSON decoding and commands. UIKit supplies native
text input and HTTPS requests; the fork's CoreGraphics painter draws the UI.
The Mac connects to the authenticated Codex app-server and Claude Code.
Dot keeps one ongoing conversation without a header. The composer has separate
attachment, text, camera and microphone controls; typing replaces the microphone with Send.

The phone connects to the private Tailscale harness. Tailscale must be connected,
and the Mac mini must stay on. Your ongoing conversation is saved on the Mac; an accepted turn continues when
the app closes. While a reply is running, Stop replaces the camera control.
The attachment control offers Camera, Photos and Files. Files keep their original
bytes, name and caption, and an unsent file draft survives app relaunch.

Open Dot is independently versioned in this repository (`package.json`).
The language fork includes its standard library at `bend2/std/F`; both are
pinned together by the compiler revision in `dependencies.lock.json`.
Keep the fork beside this repository at `../f`. Run `bun script/check_dependencies.ts`
to verify the pin; each build rejects changed or dirty dependency checkouts. The Mac needs Bun, Tailscale,
the Codex CLI, Claude Code and Xcode with iOS SDKs. Sign into both providers, then build and deploy:

```sh
cd harness && bun install --frozen-lockfile && cd ..
bun ../f/bend2/main.ts system build
bun ../f/bend2/main.ts system deploy
```

Build produces `dist/ios-simulator/Dot.app`, `dist/ios-device/Dot.app` and
`dist/ios-device/Dot.ipa`. It compiles `ios.bend` through the fork's C compiler,
links the fork's UIKit host and unchanged painter, and signs locally using an
existing development identity and provisioning profile. It freezes the sources
and records their hashes in each target's `build.json`. It does not register
devices or upload to Apple. The development IPA installs only on devices already
registered in its embedded profile; downloading it does not install it.

For a simulator build without a signing profile:

```sh
bun script/build_ios.ts simulator
xcrun simctl install booted dist/ios-simulator/Dot.app
xcrun simctl launch booted com.pedroavj.opendot.ios
```

For a connected registered iPhone, use its identifier from `xcrun devicectl list devices`:

```sh
xcrun devicectl device install app --device DEVICE_ID dist/ios-device/Dot.app
xcrun devicectl device process launch --device DEVICE_ID com.pedroavj.opendot.ios
```

Deploy installs `com.pedroavj.opendot.harness` as a user LaunchAgent and exposes
loopback port 19453 through Tailscale HTTPS port 9453. Only the configured
Tailscale owner can use it. Provider credentials stay on the Mac.
Session files live in `~/Library/Application Support/OpenDot` and logs in
`~/Library/Logs/OpenDot`. The signed IPA is available privately at
`/downloads/Dot.ipa` on the harness address.

Codex uses the available default model from its model catalog, with
approval policy `never` and approval reviewer `user`. The owner-configured Mac runtime has full filesystem access,
including adjacent repositories. Open Dot answers tool-access approval requests
affirmatively for the current request or turn, including Computer Use app access.
It does not store global permission grants.

The microphone records a retained M4A voice message. Tap Send while recording
to stop and send it, or stop first to preview it. A typed caption travels with
the recording. The original remains a playable message attachment; upload is
acknowledged before analysis, so processing continues if the phone closes.
The Mac transcribes with ElevenLabs Scribe v2 and annotates audible vocal delivery
with Gemini 3.8 Flash through OpenRouter. The agent receives the transcript,
separate tentative tone annotations, and the local path to the original audio.
Voice messages do not require Apple speech-recognition permission. Calls still
use iPhone speech recognition and speech output while Dot is in the foreground.

Text and voice messages remain available while Near works. Text follows up on
the active Codex task; voice is accepted immediately and delivered after audio
processing. Claude follow-ups wait for its current response. Receipts prevent
duplicate delivery on retries, and acknowledged messages are never replayed
automatically after a missing provider response.

Transcription uses the installed `elevenlabs` CLI and its Keychain credential
(`elevenlabs auth status --json`). Gemini uses `OPENROUTER_API_KEY` when explicitly
provided, otherwise the existing macOS Keychain service
`com.pedro.codexvoice.openrouter.v1`, account `api-key`. No keys enter the phone
bundle or conversation. New voice messages are sent to these two services for
processing. Existing recordings are processed only when retried.

Failed transcription keeps the playable audio and offers Retry audio. Pending
analysis resumes after a harness restart without replaying acknowledged agent
turns. A Gemini failure does not discard or block a successful transcript; its
unavailability is recorded separately. Captions and request IDs survive upload
retries and app restarts.

The plus button picks a photo, previews it in the conversation, and sends the
actual image with its caption when you tap Send. Stored images and audio remain
behind the same Tailscale authorization as the conversation.

The harness has both provider transports connected. Mobile routing currently
uses the stored provider, which defaults to Codex; there is no provider selector.
Automatic routing between the two providers has not been defined yet.

Run the shared client and harness checks:

```sh
bun ../f/bend2/main.ts tests mobile
cd harness && bun run typecheck && bun test
```

## Earlier macOS milestone

The previous native macOS app is retained under `macos_system.bend`; the mobile
deployment is now the default. Its release script remains a separate manual action.

Dot's native macOS milestone was written in F using the adjacent Bend2 fork
(`../f`, github.com/PedroAVJ/f). Bend owns application state, layout, tokens,
and interaction. AppKit supplies the window and text input; CoreGraphics and
CoreText paint the existing conversation components. No browser is required.

The app uses the accepted dark conversation UI: glass header controls,
chat bubbles and the pill composer. It opens in a 1000 × 760 desktop window
and redraws the layout when resized, with a centered conversation column,
a compact header and centered dialogs. The minimum content size is 640 × 560.
The earlier standalone connection and
stacked-input screens have been removed. `ui.bend` owns state;
`components/conversation.bend` composes the fork's Header, Conversation,
Bubble, Composer, and sheet components.

The original workflow
deferred the Codex/Claude subscription transport: sends append your message
and the placeholder reply `…`. The menu selects a provider; it does not
authenticate. Calls, attachments and dictation show their availability
notice. Conversation state is local to the current run, and Send clears the
controlled draft. No credentials or private artwork are bundled.
Very long messages use a preview in the compact thread; the menu's
"Ver conversación" opens the complete, scrollable conversation.

Requires Bun and Xcode Command Line Tools. Build, install and launch:

```sh
./script/build_and_run.sh --verify
```

`--debug` starts LLDB and `--logs` streams the app's logs. The old V declaration
is available explicitly:

```sh
bun ../f/bend2/main.ts macos_system diff
bun ../f/bend2/main.ts macos_system build
bun ../f/bend2/main.ts macos_system deploy
```

`macos_system.bend` declares only `Application.MacOS{"ui"}`. Build produces
`dist/mac.macos/Dot.app`; deploy verifies the signed bundle and its source
stamp, installs it as `~/Applications/Dot.app`, and opens it. No web target
or Tailscale service is launched by this declaration. Releases remain an
explicit separate action.

GitHub downloads need a Developer ID Application certificate and Apple
notarization. The local build's Apple Development signature is for development
and Gatekeeper blocks it when downloaded. The release script signs with a
secure timestamp and hardened runtime, submits to Apple, staples the ticket,
and requires Gatekeeper acceptance before packaging or publishing:

```sh
./script/release_macos.sh --tag v1.0.0-preview.2 \
  --identity 'Developer ID Application: YOUR NAME (TEAM_ID)' \
  --notary-profile YOUR_KEYCHAIN_PROFILE --publish
```

The script builds committed snapshots of both repositories; local fork edits
are excluded. Open Dot must have a clean checkout and both commits must match
their remote main branches when publishing. Notarization credentials stay in Keychain;
configure a profile with `xcrun notarytool store-credentials`. Without
`--publish`, the script saves the verified ZIP, checksum and Apple receipts
under `dist/`.

Use `--keychain /absolute/path/to/signing.keychain-db` when the signing
identity is in a separate, unlocked build keychain. The script temporarily
includes it in the signing search list and restores the original list after
signing, including on failure. The notarization profile stays in the default
Keychain.

Run the state/geometry regression, including draft retention and control
bounds at narrow and wide window sizes, with:

```sh
bun ../f/bend2/main.ts tests state
```

## Web client

`web.bend` uses the same `mobile.bend` state machine and conversation components
as iPhone. The browser host supplies scrolling, text editing, local media drafts,
recording, and network IO. It does not contain a second conversation implementation.
Keep the adjacent F checkout with its application-host adapter and web-only
Asyncify evaluator boundary.

```sh
bun script/build_web.ts
bun script/preview_web.ts
```

The preview binds only `127.0.0.1:19454` and uses synthetic messages. It never
starts an agent or sends media to a provider. The build produces `dist/dot.web`;
Emscripten must be installed. The build uses `-O1` and F's pure-evaluator
Asyncify exclusion to keep compilation bounded on the development Mac.
Dot uses a bounded 128 MiB evaluation heap, matching its iPhone client.

The harness can serve the bundle using `DOT_WEB_DIRECTORY` (default
`dist/dot.web`). Assets and conversation endpoints share the existing
Tailscale authorization; building the web client neither restarts the personal
harness nor publishes it. A separate deployment needs its own authorized
harness and data directory, not a connection to the personal conversation.
Set `DOT_WORKSPACE`, `DOT_DATA_DIRECTORY`, `DOT_PORT`, `DOT_PUBLIC_HOST`, and
`DOT_ALLOWED_TAILSCALE_LOGIN` for that instance before starting `harness/server.ts`.
Its session, audio, and image files stay under `DOT_DATA_DIRECTORY`.

Voice messages and photos retain their original browser draft and receipt ID
until acknowledgment, including across reloads. Browser recordings use MP4
where supported, otherwise WebM, with a five-minute limit. Native playback of
browser WebM recordings has not been verified. Calls require the browser's
speech-recognition and speech-synthesis APIs; unsupported browsers report that
limitation. Audio output is selected through the device's controls.

## iPhone notifications

The iPhone requests notification permission once, on the first active launch with
a push-enabled build and a configured, available notification service. Denial is
not prompted again. Alerts say that Near's
reply is ready or that Dot needs attention; they do not include conversation
text. Foreground alerts are suppressed. Tapping an alert returns to the existing
conversation without clearing its draft. The harness exposes only one ongoing
conversation: other saved threads cannot be selected, submitted, resumed, or
stopped through the app. Notification taps therefore refresh that conversation
rather than introducing a thread-switching route. Completion and error transitions are
deduplicated in a private, durable outbox. Cancelling a turn does not send an alert.

Background delivery requires both:

- A development profile for the explicit `com.pedroavj.opendot.ios` App ID with
  Push Notifications enabled and an `aps-environment` entitlement. Pass the
  cached profile to `script/build_ios.ts device --profile PATH`. The build
  preserves that entitlement only when the profile explicitly authorizes it;
  wildcard profiles remain usable for builds without push.
- An APNs provider key configured on the harness through `DOT_APNS_TEAM_ID`,
  `DOT_APNS_KEY_ID`, and `DOT_APNS_KEY_FILE`. The last value points to a private
  `.p8` file outside the repository. The key is never copied into the app.

Building does not create Apple credentials, modify provisioning, install the
app, or restart the harness. Without those prerequisites the app does not
request notification permission. Device registrations remain behind
the harness's existing Tailscale authorization and same-origin write checks.

Attention alerts currently cover turn failures and voice messages needing a
transcript. `Notifications.attention(requestId, threadId)` is the deduplicated
integration point for a future interactive approval flow; it does not change
or intercept the current approval protocol. Browser push is not implemented.

Local checks use a fake push sender and the actual native payload validator:

```sh
(cd harness && bun run typecheck && bun test tests/notifications.test.ts tests/harness.test.ts)
bun script/test_ios_notifications.ts
bun script/build_ios.ts simulator
```

These checks do not prove delivery through APNs to a physical device. That
requires a provisioned build, the configured provider, user permission, and a
background completion followed by tapping the received alert.

## Claude speaker and Codex worker

`harness/claude-front.ts` runs the user-facing conversation on loopback port
19455 while the existing Codex harness keeps running on 19453. It uses
`claude-front-session.json`; it never writes the worker's `mobile-session.json`.
The launch agent is `com.pedroavj.opendot.claude-front`. The HTTPS handler on
port 9453 points to the front. Do not restart the worker to update the front.

The initial handoff copies history and media ownership. After the HTTPS route
has been verified, SIGUSR1 captures messages received during staging and asks
real Claude to acknowledge the switch. New Codex output stays in the worker's
saved conversation. Claude can read its live status and reports terminal worker
results through genuine Claude replies. The app's Stop button stops Claude;
Codex is stopped only by an explicit user request through the worker tool.

The relay accepts no generated task text from Claude. It forwards the accepted
user request, original media, and unsent conversation context with preserved
roles and wording. A private immutable relay envelope keeps retries identical;
the worker receipt ID is derived from the front request ID. A correction such
as “I just said that” therefore carries the actual preceding exchange.

Timestamped `claude-front-facts.json` records verified per-issue evidence for
status replies; global worker activity is not proof that a feature is unfinished
or dependent on other work. Internal completion/approval notices can read worker
status but cannot submit or stop work without a real active user message.
A private `claude-front-notice.json` with `id` and `prompt`, delivered with SIGHUP,
requests a deduplicated genuine Claude notice. It never creates an assistant
message directly or grants approval for an action.

## General file attachments

`POST /api/file` accepts multipart `file` and JSON `metadata` containing
`requestId`, `threadId`, `text`, and `fileId`. Files can be any format up to
20 MiB; the server stores exact bytes privately under their SHA-256 hash and does
not execute them. Acknowledgments retain the existing `acceptedRequestIds`
contract. Messages expose `file: {id, url, name, mimeType, size}`.

Native clients encode the multipart filename using RFC3986 percent encoding
and send the original filename in `metadata.name`; the server verifies that
pair before retaining the original. This preserves quotes and Unicode despite
Bun's multipart decoder ignoring `filename*`. Names are limited to 255 UTF-16
code units and exclude controls, path separators, `.` and `..`. Optional
metadata MIME/size values must match the actual part. MIME parameters are
normalized to the base MIME type.

Authenticated, owned `GET` and `HEAD /api/file/:id` return verified bytes as a
download, never active inline HTML. Both providers receive a verified local
file reference and the original caption. The front relays documents to the
existing worker turn endpoint with a labeled attachment reference, so new
uploads do not require restarting the active Codex worker. File content is
untrusted data, not instructions.
