# End-to-end testing

The live game flow is covered with Playwright. Unlike `demo.html`, this test uses the real Vite client, Node server, WebSockets, cookies, and four independent browser contexts.

## First-time setup

```powershell
npx playwright install chromium
```

## Run the flow

Headless, suitable for repeatable checks:

```powershell
npm run test:e2e
```

Four visible Chromium clients:

```powershell
npm run test:e2e:headed
```

To slow down each checkpoint while watching the windows:

```powershell
$env:E2E_STEP_DELAY = '1000'
npm run test:e2e:headed
```

To open the Playwright inspector at every checkpoint, set `E2E_PAUSE=1`. Resume the inspector to continue the game.

```powershell
$env:E2E_PAUSE = '1'
npm run test:e2e:headed
```

The test starts Vite on `5173` and the game server on `8080`, using a temporary `.e2e-data` authentication directory. The host is created through `/auth/e2e-login`, which only exists when `E2E_TEST_MODE=true` and the server is not running in production. Player contexts are unauthenticated and isolated from one another.

Playwright retains traces, screenshots, videos, and an HTML report when a test fails. These generated files are ignored by Git.
