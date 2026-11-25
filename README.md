# Santa's Sketchbook

A personal, local prototype for free drawing, brainstorming with an AI voice helper, and enhancing the drawing into a realistic image. Santa and a sleigh are an optional starting theme; the child can choose another subject. The entire window is textured drawing paper. A small floating orb reacts to the returned voice audio, with paint controls directly beneath it. Ask Santa's little helper to draw with a visible pen cursor, or to turn the picture into a photo. Snow blows across the page while the image is made, then clears to reveal the replacement. The previous picture remains available through Undo.

## Run locally

Requires Node.js 24 or later. The app has no runtime npm dependencies.

```powershell
cd 'C:\Users\mitch\source\repos\ai-projects\santas-sketchbook'
npm start
```

Open <http://localhost:3017>. The server binds to `127.0.0.1`; it is not a public site. Drawing, upload, undo, download and the snowfall preview work without an API key. Refreshing the page clears its drawing and conversation, so download anything you want to keep.

To connect an OpenAI Platform project:

```powershell
.\setup.ps1
npm run check:account
```

The setup script asks for the API key with hidden input and saves it to this project's ignored `.env` file, restricted to the current Windows user and SYSTEM. It does not print the key. An existing `OPENAI_API_KEY` environment variable takes precedence. Optional `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` values can be set in `.env` when needed. Never put keys in frontend files or commit `.env`.

Tap the voice orb to start. The child-facing UI has no setup screen or adult-test checkbox. The server rereads `.env` on requests, so saving a key needs no restart. A configured key does not prove model access or available credits. `check:account` lists model availability without generating content; it cannot retrieve the credit balance. API model access and billing must be enabled in the selected OpenAI project. There is no separate OpenAI model deployment step.

## Temporary Codex demo

With the Codex CLI installed and signed in using ChatGPT, run:

```powershell
npm run start:demo
```

This uses the installed `codex app-server` over private stdio for drawing plans, canvas assessment, visual review and native image generation. It consumes the signed-in ChatGPT plan's Codex allowance. It does not copy authentication tokens or pass the OpenAI API key to Codex. `CODEX_BIN` can specify a Codex executable if it is not on PATH.

Open **Our ideas** and type a request under **Ask Santa's little helper to draw or enhance**. Try “Draw a star in the upper-left corner”, then “Turn this into a cool image”. The normal pen animation, visual review, snow reveal and Undo still apply.

Voice remains GPT-Live with Willow through the OpenAI API, as requested. The installed Codex realtime route rejects ChatGPT authentication and requires API-key authentication, so demo mode does not fix the API voice billing issue. Typed requests demonstrate delegation and images without starting voice.

Codex turns are ephemeral and restricted to the drawing task. Temporary image inputs are written under the ignored `artifacts/codex-demo` directory and cleanup is attempted after each conversion; Windows file locks can defer cleanup. Codex retains generated images in its own per-thread image cache. Its normal service retention and plan limits still apply. Request cancellation preserves the canvas; already submitted Codex work may continue upstream.

Stop the server and use `npm start` to return to the normal API backend. Alternatively set `AI_BACKEND=codex` in the ignored `.env` file to make demo mode the default. There is no automatic fallback to the paid Images API when Codex image generation fails.

## Use the prototype

1. Draw anywhere on the page with a mouse, finger or pen. Use the controls beneath the orb for colours, thickness, image upload or **Start with a sleigh**. Uploads fit the canvas without cropping; they replace its contents and can be undone.
2. Tap the blue orb to talk to the AI helper. Explore shapes, colours and whatever subject you choose. Santa's little helper uses Willow, keeps a loose plan, offers occasional ideas and leaves space for quiet drawing. While voice is active, a picture helper checks changed canvases after a pause and gives Santa's little helper factual observations; uncertain marks stay uncertain. It does not draw from those observations alone. **Mute mic** pauses input; tapping the orb again stops the microphone and cancels pending page changes. Hiding the tab stops the conversation too. The orb follows actual output audio through a Web Audio analyser, settles during silence and resets on disconnect. Reduced-motion preferences suppress its movement.
3. Ask **“Draw a little man here”** to delegate a sketch. The helper plans against an aspect-preserving canvas snapshot and the real control locations. It renders a candidate offscreen and makes one visual check before a visible pen cursor draws the accepted strokes on the page. You can keep drawing while Santa's little helper thinks; changing the canvas makes the pending plan stale and it will not be applied. **Stop**, Escape, a new delegation while busy, stopping voice or resizing the page cancels pending work; partial drawings roll back. Completed sketches undo in one step. The helper cannot control the desktop cursor or execute code.
4. Ask **“Turn this into a photo”** to start the snowy transformation. There is no generate button. The current canvas, notes and selected conversation are submitted once after the delegated helper identifies an explicit conversion request. Controls lock during conversion. The returned picture is decoded before the canvas changes. Failure or cancellation clears the snow and preserves the original drawing. **Our ideas** lets you review the transcript, add notes or exclude chat from the image request; notes take precedence.
5. Draw on the result, discuss another change and submit again. **Undo** retains up to eight prior canvas states. **Save picture** downloads a PNG.

The snowfall under **Visit the ice floes** is only an animation preview. It does not generate or replace a picture and uses no credits. The starter sketch is a hand-coded drawing, not an AI result.

The bucket tool fills a connected area using the selected colour and supports Undo. The agent can also draw closed shapes with solid palette fills; filled shapes are previewed and checked before being drawn, and the whole delegated drawing can be undone in one step.

## Models and data

- Voice: `gpt-live-1.1`, using `POST /v1/live/sessions` and browser WebRTC. The API key and opening instructions stay on the server. Audio travels between the browser and OpenAI. The app receives transcript fragments over the data channel. Santa's little helper does not receive continuous video. It receives bounded, revisioned observations from the picture helper and is told when those observations become stale.
- Pictures: `gpt-image-2`, using `POST /v1/images/edits` with the actual canvas PNG, medium quality, one `1536x1024` output and automatic moderation. The browser sends no model name or instructions that can replace the server's fixed task.
- Delegated actions: `gpt-6.1-terra` through the Responses API, using medium reasoning for pen planning. The helper receives the current page snapshot, viewport dimensions, last pointer location, current-session transcript and a measured 20×20 ink map. The server derives occupied bounds, free-space options and pixel-to-coordinate conversions, including aspect-ratio guidance. A strict function schema selects draw, erase, undo, convert, cancel or no action, with at most 32 strokes and 64 points per stroke. The server validates colours, widths, coordinates and stroke/point limits. A rejected visual preview or a collision with controls permits one replacement plan against the unchanged original; a second rejection leaves the page intact. No automatic retries follow network or billing errors. GPT-Live receives the result linked to its original delegation ID. Duplicate events and stale requests do not start another action. Ordinary transcript events do not dispatch tools.
- Visual context: the drawing model assesses changed canvases at most six times per voice session, with at least twenty seconds between automatic checks. Each pen candidate is reviewed offscreen before drawing; there are at most two candidates for one request. Snapshots preserve the canvas aspect ratio, and controls and pointer locations share normalized canvas coordinates. Observation failures do not block free drawing.
- Conversations, scene plans and drawings stay in browser memory until submitted. The local server does not persist pictures, audio or transcripts, or log their contents. `store: false` is set for voice sessions, but this is **not** OpenAI zero data retention.
- An active voice session can trigger paid visual-assessment calls as well as requested drawing-helper, review and image-conversion calls. One rejected pen candidate can trigger one additional paid planning and review attempt. There are no retries for transport/account failures and no web search. Cancel prevents a late result from changing the page, but an upstream request may still finish and use credits. Voice sessions have no app-imposed time limit; stop the conversation when finished. Provider session limits and connection interruptions can still end a session.

The adult-test gate has been removed from the UI and API. Account-level child privacy and consent controls are separate from this interface change. Before children use the service, arrange appropriate consent/privacy controls and evaluate age-appropriate content and voice safeguards. OpenAI's [under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance) says not to process under-13 personal data without zero data retention. No such account setting has been verified here. Voice is played live: there is no application-level moderation buffer or server-side transcript monitoring in this prototype. Prompt instructions alone do not establish suitability for unsupervised use by children.

## Validation

```powershell
npm install
npm test
npx playwright install chromium
npm run test:browser
```

If Chromium is already installed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its full executable path instead of downloading it. Browser tests run a separate local server on port 3117. The tests mock paid OpenAI responses; they do not use credits and do not establish live model quality, microphone audio playback or account access. Screenshots are written to the ignored `artifacts` folder.

The API tests cover request boundaries, credentials, selected models, validated helper actions and strokes, provider errors and concurrent requests. Browser tests cover the moving delegated cursor, cancellation and late results, duplicate events, one-step Undo, voice-triggered photo replacement, uploads/downloads, snowfall, controls beneath the orb on desktop/mobile and a simulated voice lifecycle. A Web Audio tone verifies the orb's response to sound and silence. The Personal account has passed model listing and a small live text request. Composition quality, voice behaviour and image enhancement still need live acceptance testing; mocked checks cannot establish those qualities.

## Later Azure Foundry work

`lib/openai.mjs` contains the OpenAI-specific adapter. A later Foundry version should replace that adapter with the verified Azure endpoints, authentication and available deployment names. This repository does not claim API compatibility with an unverified Foundry GPT-Live deployment. Public hosting also needs authentication, server-enforced usage controls, appropriate child privacy safeguards and real voice/content evaluation. No Azure resources or work items have been created.

## Hosted Site and session recovery

The private hosted application lives in the separate Git checkout at `sites/santas-sketchbook`. Its Worker requires ChatGPT sign-in and reads `OPENAI_API_KEY` from the hosted environment. Run `npm run build` from that checkout to produce a Sites build. Changes to the root Node server do not update the Worker.

Use **New drawing** to clear the canvas with Undo available. **Our ideas → Forget this conversation** ends voice and clears the local chat while retaining the picture and notes. **Our ideas → Reset sketchbook** asks for confirmation before ending the session and discarding the picture, history and notes. Save a PNG first to keep a copy.

API references: [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [Live session events](https://developers.openai.com/api/docs/guides/live-conversations), [image edits](https://developers.openai.com/api/reference/resources/images/methods/edit).

## Imagination and feedback

Explicit requests such as “imagine this” and “turn this into an image” delegate immediately, without payment confirmation. Santa's little helper calls the drawing agent “my friend”. Undo restores the last canvas state; targeted deletion uses reviewed white shapes on white paper and preserves neighbours. For photographs, the agent should offer Undo rather than paint a white hole. An accepted image conversion continues after voice ends; Stop still cancels it.

The transition visits an animated Arctic ocean with fishing elves between two blizzards. Reduced-motion settings show a still scene. The preview uses no API calls.

Responses use explicit cache breakpoints after fixed developer instructions and tools, with a 30-minute cache lifetime. Fresh canvas images and changing conversation context stay outside the write boundary. Numeric usage logs report input/output tokens and cache reads/writes without logging drawings or conversation. Short visual-check prefixes may remain below the caching minimum; response chaining is not enabled and store remains false.
