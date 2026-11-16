# STUDIO SHALOM kiosk on iPadOS 15

The supported legacy baseline is **Safari / iPadOS 15.6–15.8.x**. Update the iPad mini 4 to its latest available iPadOS 15 patch. Use HTTPS and a normal Safari tab with local browser storage available.

## Routing

| Browser signature                                                    | Auto                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Explicit iPhone/iPad/iPod OS below 16.4                              | Standalone legacy renderer                                                    |
| Explicit iPhone/iPad/iPod OS 16.4 or later                           | Existing Next kiosk                                                           |
| Macintosh WebKit (including desktop-site iPad) or missing User-Agent | HTML capability probe. Modern if CSS color-mix is available, legacy otherwise |
| Other recognizable modern browsers                                   | Existing Next kiosk                                                           |

[Next.js 16 supports Safari 16.4 and later](https://nextjs.org/docs/app/getting-started/installation#supported-browsers). PR #61 added capture and CSS fallbacks that need a working runtime. The Vite build compiles the shared React booth directly for Safari 15 and is served by a route handler that emits standalone HTML without Next.js scripts or hydration. Both versions use the same enrollment, camera APIs, composition, consent, upload queues, moderation and QR APIs.

The probe checks capability before fetching either renderer. It reloads the same URL once with a scoped session-only routing cookie. If script cookie storage is blocked, it uses a validated query marker and retains other parameters such as camera mode. If the probe script fails, the page contains a link to the legacy renderer. Camera permission and enrollment play no part in routing. Kiosk responses are private/no-store.

### Staff override

On the enrolled booth browser, open `/kiosk/enroll` → **키오스크 화면 설정** (or `/kiosk/frontend`). Choose **Auto**, **Modern** or **Legacy** and apply. Use the existing operator password when enabled, or an existing staff session on that browser. The override is stored as an HttpOnly preference cookie scoped to the kiosk. Auto clears it and rechecks the browser. Switch only between guests. The enrollment cookie remains valid.

## Legacy build and behavior

- **Build.** `npm run build:kiosk-legacy` targets Safari/iOS 15 for JavaScript and 15.6 for CSS. It generates `public/kiosk-legacy-assets/` before `npm run build` and `npm run dev`. Use Node 22.12+ for a new installation. Stable entry files revalidate and font assets are fingerprinted. The build has plain viewport and sRGB fallbacks, secure UUID v4 generation via getRandomValues, and a FileReader fallback for reading blobs.
- **Memory.** The browser camera asks for an ideal 1280×720 stream, audio off. Seven 960×720 capture canvases use about 18.5 MiB of RGBA backing stores. The largest output is 600×1800 or about 4.2 MiB RGBA. Frame thumbnails use a 0.35 scale. The kiosk releases capture surfaces after composition or reset, and guest object URLs on reset or unmount. Browser, video-stream and decoded-image memory are additional. Legacy disables optional video recording. Existing remote camera and mobile-upload code is included, with physical Safari 15 remote pairing pending.
- **Outages and privacy.** Finished JPEGs and wall answers use the existing same-origin IndexedDB stores. Retry uses the original session ID, and the displayed QR comes from the server response. If storage is unavailable, the kiosk marks temporary storage, holds the active session, and prompts staff to keep the tab open. Unfinished captures stay in memory. The first page load needs access to the kiosk server. After a reload with a durable queued photo, retry resumes and staff can recover issued QR codes in recent sessions.

## Preview and physical device acceptance

The Vercel project's branch Previews check the build. For a runtime trial, configure separate preview storage, a preview public origin, kiosk enrollment and session credentials, and a cron secret (see DEPLOYMENT.md). An unenrolled request to `/kiosk` with an iPadOS 15 UA should show enrollment with no Next scripts. After enrollment the legacy renderer should load `/kiosk-legacy-assets/entry.js` and `entry.css` with the proper MIME types and no `/_next/` scripts. On a supported browser, confirm the Next kiosk. Verify the response caching and cookie continuity on both. Use synthetic photos for preview tests.

Run the following on the physical iPad mini 4 with the event network. Record the OS patch, deployment SHA, orientation and each result.

| Check              | Pass condition                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enrollment         | Opening the kiosk URL selects Legacy. Native enrollment succeeds and survives closing and reopening Safari.                                                                                                              |
| Desktop-site mode  | Request desktop and mobile sites in turn and reopen the URL. Auto selects Legacy and enrollment persists.                                                                                                                |
| Touch and viewport | Attract opens on first touch. Rotate with Safari bars shown and hidden. All frame, review, consent and delivery controls stay reachable.                                                                                 |
| Camera             | Deny permission, then allow it and retry. Lock/unlock or background/resume the booth. Captures remain visible, mirrored and correctly cropped.                                                                           |
| Memory and flash   | Run ten consecutive sessions with seven shots, flash on and off, tall and square frames, and Korean and Chinese. No tab reloads, black captures or camera still on after reset.                                          |
| Consent and QR     | Try both consent answers. Scan the resulting QR from a second phone on mobile data. Download the correct JPEG. Confirm the moderation queue follows consent and the guest QR clears after reset.                         |
| Network outage     | Disconnect during composition. Observe the queued indicator and absence of a QR. Reconnect and retry. Repeat with a reload after durable queueing. Verify one photo per session and recover the QR from recent sessions. |
| Staff and modern   | Exercise all three preferences while idle; restore Auto. Verify Modern on a supported iPad and desktop, including video/remote camera where configured.                                                                  |

CI uses Playwright Chromium and current WebKit with iPadOS 15 routing and viewport simulation. [Sauce Labs offers real devices on iPadOS 15](https://docs.saucelabs.com/mobile-apps/supported-devices/) and [BrowserStack selects Safari according to the device OS](https://www.browserstack.com/support/faq/live/browsers-amp-platforms-live/i-want-to-test-on-a-particular-browser-version-on-mobile-devices-is-that-supported). Verify exact model and OS availability before using either. Physical mini 4 testing is required for camera, touch, memory and event-network sign-off.
