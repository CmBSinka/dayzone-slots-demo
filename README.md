# Dayzone Slots Demo

STALKER-inspired browser slot demo built with React, Vite, PixiJS, and a minimal PHP backend stub.

The project is designed as a visual prototype rather than a production gambling platform. It focuses on animation, symbol logic, bonus flows, audio feedback, and a themed interface inside a device-like frame.

## Overview

The application simulates a 5x5 slot experience with:

- pay-anywhere win logic
- cascading reels
- scatter-triggered bonus mechanics
- free spins and retriggers
- buy-bonus flow
- ante-bet mode with increased bonus chance
- RTP and volatility guardrails in the spin generation logic
- themed sound effects and background music
- PixiJS-based rendering for selected visual effects

The backend currently contains a simple PHP API endpoint used as a connectivity stub and can be extended later if game state, persistence, analytics, or remote balancing are needed.

## Tech Stack

- React 19
- Vite 8
- PixiJS
- `@pixi/react`
- `pixi-filters`
- GSAP
- PHP for the backend API stub

## Project Structure

```text
backend/
  api/
    state.php          # simple JSON API stub
docs/
  codex-handoff.md    # project handoff notes
  scatter.md          # bonus/scatter-related design notes
  vfx_spec.md         # VFX direction and implementation notes
frontend/
  public/             # images, sound effects, music, frame assets
  src/
    App.jsx           # main game logic
    styles/main.css   # main styling
    index.css         # global page-level styling
  package.json
README.md             # this file
```

## Core Gameplay

Current implementation includes:

- 5x5 board generation
- 10 symbol types including a scatter symbol
- weighted symbol distribution for base game and free spins
- symbol payouts based on total matching symbols on the board
- scatter payouts handled separately
- free spins with retrigger support
- bonus purchase mode
- ante bet mode
- autospin support
- turbo mode
- session reset
- audio controls and fullscreen mode

Some balancing values are intentionally hardcoded in [frontend/src/App.jsx](/c:/OSPanel/domains/research-slot/frontend/src/App.jsx) because this project behaves like a controlled gameplay prototype.

## Requirements

To run the project locally you will typically need:

- Node.js 20+ recommended
- npm
- PHP 8+ recommended if you want to use the backend endpoint

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/CmBSinka/dayzone-slots-demo.git
cd dayzone-slots-demo
```

### 2. Install frontend dependencies

```bash
cd frontend
npm install
```

### 3. Start the frontend development server

```bash
npm run dev
```

By default Vite will print a local development URL in the terminal, usually something like:

```text
http://localhost:5173
```

### 4. Optional: run the backend API

From the project root:

```bash
php -S localhost:8000 -t backend
```

The stub endpoint will then be available at:

```text
http://localhost:8000/api/state.php
```

Expected response:

```json
{
  "ok": true,
  "message": "PHP API works"
}
```

## Production Build

Build the frontend with:

```bash
cd frontend
npm run build
```

Preview the production bundle locally:

```bash
npm run preview
```

The compiled frontend output is generated in:

```text
frontend/dist
```

## Deployment Notes

### Frontend

The frontend is a static Vite application and can be deployed to:

- GitHub Pages
- Netlify
- Vercel
- any Nginx/Apache static hosting

### Backend

The backend is plain PHP and can be hosted separately on:

- shared hosting with PHP support
- Apache or Nginx + PHP-FPM
- local Open Server / OSPanel setups

If you connect the frontend to the backend later, make sure API URLs are configured for the target environment.

## Important Files

- [frontend/src/App.jsx](/c:/OSPanel/domains/research-slot/frontend/src/App.jsx): main gameplay logic, balancing constants, bonus flow, UI state
- [frontend/src/styles/main.css](/c:/OSPanel/domains/research-slot/frontend/src/styles/main.css): game layout and visual styling
- [frontend/src/main.jsx](/c:/OSPanel/domains/research-slot/frontend/src/main.jsx): frontend entry point
- [backend/api/state.php](/c:/OSPanel/domains/research-slot/backend/api/state.php): backend JSON test endpoint
- [docs/codex-handoff.md](/c:/OSPanel/domains/research-slot/docs/codex-handoff.md): historical context and implementation notes

## Assets

The repository includes:

- symbol PNGs
- sound effects for scatter and special events
- looping background music
- UI and frame assets

Large media assets are stored directly in `frontend/public`.

## Known Characteristics

- The backend is currently minimal and does not persist user data.
- Game balance is controlled in code, not through an admin panel or config service.
- A number of gameplay constants are tuned for demo behavior and may require further balancing.
- The project contains internal design notes in `docs/` that are useful for future iteration but are not user-facing documentation.

## Suggested Verification After Setup

After launching the project, it is worth checking:

- the game loads correctly in the browser
- music can be toggled on and off
- spins animate correctly
- scatter and free spins trigger as expected
- fullscreen mode behaves correctly
- Russian UI labels display correctly
- assets load without missing file errors

## Commands Summary

```bash
# install dependencies
cd frontend
npm install

# start dev server
npm run dev

# build production bundle
npm run build

# preview production bundle
npm run preview

# optional backend
cd ..
php -S localhost:8000 -t backend
```

## Disclaimer

This repository is a demo/prototype project intended for interface, animation, and gameplay experimentation. It is not a licensed gambling product and should be treated as a technical showcase or research build.
