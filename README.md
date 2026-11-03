# Santa's Sketchbook

A personal, local prototype for drawing Santa inside his sleigh, brainstorming with an AI voice helper, and turning the drawing into a realistic Christmas picture. The entire window is textured drawing paper. A small floating orb reacts to the returned voice audio, with paint controls directly beneath it. Ask Pip to draw with a visible pen cursor, or to turn the picture into a photo. Snow blows across the page while the image is made, then clears to reveal the replacement. The previous picture remains available through Undo.

## Run locally

Requires Node.js 24 or later. The app has no runtime npm dependencies.

```powershell
cd 'C:\Users\Mitchell003\repos\santas-sketchbook'
npm start
```

Open <http://localhost:3017>. The server binds to `127.0.0.1`; it is not a public site. Drawing, upload, undo, download and the snowfall preview work without an API key. Refreshing the page clears its drawing and conversation, so download anything you want to keep.

To connect an OpenAI Platform project:

```powershell
.\setup.ps1
npm run check:account
```

The setup script asks for the API key with hidden input and saves it to this project's ignored `.env` file, restricted to the current Windows user and SYSTEM. It does not print the key. An existing `OPENAI_API_KEY` environment variable takes precedence. Optional `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` values can be set in `.env` when needed. Never put keys in frontend files or commit `.env`.

In the controls beneath the orb, open **Grown-ups**, choose **Check connection again**, and enable **Adult test mode**. The server rereads `.env` on requests, so saving a key needs no restart. A configured key does not prove model access or available credits. `check:account` lists model availability without generating content; it cannot retrieve the credit balance. API model access and billing must be enabled in the selected OpenAI project. There is no separate OpenAI model deployment step.

## Use the prototype

1. Draw anywhere on the page with a mouse, finger or pen. Use the controls beneath the orb for colours, thickness, image upload or **Start with a sleigh**. Uploads fit the canvas without cropping; they replace its contents and can be undone.
2. Tap the blue orb to talk to the AI helper. Describe the drawing and explore colours, presents, reindeer and the setting. Pip uses short, warm language and waits for ideas. **Mute mic** pauses input; tapping the orb again stops the microphone and cancels pending page changes. Hiding the tab stops the conversation too. Each conversation ends after three minutes. The orb follows actual output audio through a Web Audio analyser, settles during silence and resets on disconnect. Reduced-motion preferences suppress its movement.
3. Ask **“Draw a little man here”** to delegate a sketch. A visible pen cursor draws the returned strokes on the page. **Stop**, Escape, a new delegation while busy, stopping voice or resizing the page cancels pending work; partial drawings roll back. Completed sketches undo in one step. The helper cannot control the desktop cursor or execute code.
4. Ask **“Turn this into a photo”** to start the snowy transformation. There is no generate button. The current canvas, notes and selected conversation are submitted once after the delegated helper identifies an explicit conversion request. Controls lock during conversion. The returned picture is decoded before the canvas changes. Failure or cancellation clears the snow and preserves the original drawing. **Our ideas** lets you review the transcript, add notes or exclude chat from the image request; notes take precedence.
5. Draw on the result, discuss another change and submit again. **Undo** retains up to eight prior canvas states. **Save picture** downloads a PNG.

The snowfall under **Grown-ups → Preview the snowfall** is only an animation preview. It does not generate or replace a picture and uses no credits. The starter sketch is a hand-coded drawing, not an AI result.

## Models and data

- Voice: `gpt-live-1`, using `POST /v1/live/sessions` and browser WebRTC. The API key and opening instructions stay on the server. Audio travels between the browser and OpenAI. The app receives transcript fragments over the data channel. Pip cannot see the canvas; it asks the participant to describe it.
- Pictures: `gpt-image-2`, using `POST /v1/images/edits` with the actual canvas PNG, medium quality, one `1536x1024` output and automatic moderation. The browser sends no model name or instructions that can replace the server's fixed task.
- Delegated actions: `gpt-6-luna` through the Responses API, with the current page snapshot, viewport dimensions, last pointer location and current-session transcript. A strict function schema selects draw, convert, cancel or no action. The server validates colours, widths, coordinates and stroke/point limits. GPT-Live receives the result linked to its original delegation ID. Duplicate events and stale requests do not start another action. Ordinary transcript events do not dispatch tools.
- Conversations and drawings stay in browser memory until submitted. The local server does not persist pictures, audio or transcripts, or log their contents. `store: false` is set for voice sessions, but this is **not** OpenAI zero data retention.
- Voice requests can trigger paid drawing-helper and image-conversion calls. There are no automatic paid retries or web search. Cancel prevents a late result from changing the page, but an upstream request may still finish and use credits. The three-minute voice timer is a browser convenience, not a billing guarantee or provider-side spending limit.

The live features currently require an adult test acknowledgement. This is a prototype gate, not verified age assurance. Before children use the service, arrange appropriate consent/privacy controls and evaluate age-appropriate content and voice safeguards. OpenAI's [under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance) says not to process under-13 personal data without zero data retention. No such account setting has been verified here. Voice is played live: there is no application-level moderation buffer or server-side transcript monitoring in this prototype. Prompt instructions alone do not establish suitability for unsupervised use by children.

## Validation

```powershell
npm install
npm test
npx playwright install chromium
npm run test:browser
```

If Chromium is already installed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its full executable path instead of downloading it. Browser tests run a separate local server on port 3117. The tests mock paid OpenAI responses; they do not use credits and do not establish live model quality, microphone audio playback or account access. Screenshots are written to the ignored `artifacts` folder.

The API tests cover request boundaries, credentials, selected models, validated helper actions and strokes, provider errors and concurrent requests. Browser tests cover the moving delegated cursor, cancellation and late results, duplicate events, one-step Undo, voice-triggered photo replacement, uploads/downloads, snowfall, controls beneath the orb on desktop/mobile and a simulated voice lifecycle. A Web Audio tone verifies the orb's response to sound and silence. Live OpenAI acceptance remains pending account reconnection.

## Later Azure Foundry work

`lib/openai.mjs` contains the OpenAI-specific adapter. A later Foundry version should replace that adapter with the verified Azure endpoints, authentication and available deployment names. This repository does not claim API compatibility with an unverified Foundry GPT-Live deployment. Public hosting also needs authentication, server-enforced usage controls, appropriate child privacy safeguards and real voice/content evaluation. No Azure resources or work items have been created.

## Deployment handoff

The prototype runs locally; it has not been deployed to Sites. The latest validation passed 13 server tests and 12 browser tests using simulated OpenAI responses. No API key has been provisioned, model access and credits remain unverified, and live voice, delegation and image conversion still need acceptance testing.

For Sites, retain the full-page paper, orb, paint controls underneath and voice-triggered actions. Host privately. Sites runs server code in Cloudflare Workers, so adapt the native Node HTTP server in `server.mjs` to the supported Sites runtime rather than uploading only `public/`. Preserve the request validation, authenticated access and anti-forgery protection; replace the localhost-only host/origin checks for the actual hosted origin. Keep `lib/openai.mjs` and `lib/drawing-agent.mjs` on the server. Configure `OPENAI_API_KEY` as a hosted runtime secret, never a browser asset or tracked file. No Site ID or deployment version exists yet.

API references: [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [Live session events](https://developers.openai.com/api/docs/guides/live-conversations), [image edits](https://developers.openai.com/api/reference/resources/images/methods/edit).
