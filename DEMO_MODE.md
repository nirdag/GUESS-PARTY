# Demo Mode Guide

The demo mode allows you to quickly visualize and test any game screen state without needing to simulate full multi-browser game flows. Perfect for styling iterations, animation testing, and UI verification.

## Quick Start

1. **Start the dev server**:
   ```bash
   npm run dev
   ```

2. **Open demo mode**:
   ```
   http://localhost:5173/demo.html
   ```

3. **Select a state from the dropdown** and watch the UI render instantly with the demo state applied.

## Available Demo States

| State | Description |
|-------|-------------|
| **lobby** | Lobby screen with host view and joined players |
| **answer-collection** | Answer collection phase - players submitting responses |
| **player-guessing** | Player's guessing screen with countdown timer |
| **round-end-correct** | Round end with celebration overlay (correct guess) |
| **round-end-incorrect** | Round end with wrong guess overlay |
| **round-end-no-guess-eligible** | Round end with yellow no-guess overlay for an eligible player |
| **round-end-no-guess** | Round end answer-author view (no overlay, not eligible to guess) |
| **game-end** | Final leaderboard screen |
| **host-managing** | Host's view managing multiple guesses |
| **ask-question-overlay** | Host-as-player: asker's "your turn" confirmation overlay |
| **ask-question-form** | Host-as-player: asker writing the next question |
| **waiting-for-question** | Host-as-player: non-asker waiting for the question |
| **game-end-host-pending** | Game end (host-as-player): host view with "Continue to next question" plus the next-asker notice |
| **game-end-player-pending** | Game end (host-as-player): player view showing only the next-asker notice |

## Features

✅ **1-click State Selection** — Instantly switch between any game screen  
✅ **Persistent Animations** — See all CSS animations (celebration overlays, countdowns, etc.)  
✅ **Hot Reload Support** — Modify CSS/HTML and refresh to see changes  
✅ **Responsive Testing** — Resize browser to test mobile/tablet layouts  
✅ **Shareable URLs** — Each state has a unique URL:
   - `http://localhost:5173/demo.html?state=round-end-correct`
   - `http://localhost:5173/demo.html?state=player-guessing`

## Adding New Demo States

Edit `demo-states.json` to add new game states:

```json
{
  "my-new-state": {
    "label": "My New State - Description",
    "role": "player",
    "playerId": "p1",
    "playerName": "Player Name",
    "roomCode": "DEMO1",
    "state": {
      "code": "DEMO1",
      "phase": "guessing",
      "players": [...],
      "answers": [...],
      ...
    }
  }
}
```

The `state` object should match the `RoomState` type structure in `src/main.ts`.

## Technical Details

### How It Works

1. `demo.html` detects demo mode via URL parameters
2. Sets `window.__DEMO_MODE__ = true` and `window.__DEMO_STATE__ = 'state-name'`
3. `src/main.ts` loads `demo-states.json` and injects the demo state
4. WebSocket connection is skipped in demo mode
5. App renders with the demo state immediately

### Files Involved

- **demo.html** — Entry point with state picker dropdown
- **demo-states.json** — Pre-defined game states for testing
- **src/main.ts** — Demo mode detection and state injection logic

### Demo Mode vs Live Game

| Feature | Demo Mode | Live Game |
|---------|-----------|-----------|
| WebSocket Connection | ❌ Disabled | ✅ Active |
| State Management | Manual (from JSON) | Server-driven |
| Animations | ✅ Visible | ✅ Visible |
| Interactivity | ⚠️ Limited (no state changes) | ✅ Full |
| Use Case | Design/styling | Actual gameplay |

## Tips

- **Testing Celebrations**: Use `round-end-correct` and `round-end-incorrect` states to see the new celebration overlays
- **Responsive Design**: Open browser DevTools and use device emulation while viewing demo states
- **Animation Timing**: Modify animation durations in `src/style.css` and refresh demo.html to see changes immediately
- **Component Isolation**: Each demo state represents a complete screen snapshot, so you can test one component without other game mechanics

## Environment Notes

- Demo mode is **development-only** (demo.html is not deployed)
- Demo states are **not** affected by WebSocket or server changes
- Demo files are ignored by the deployment pipeline (`.github/workflows/deploy.yml`)
