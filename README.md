# TLI Wealth Tracker

A real-time farming session tracker for Torchlight: Infinite, built as a desktop overlay application.

## Features

### In-Game Overlay

An always-on-top transparent overlay sits over your game while you farm. It shows your live drop totals and elapsed time without interrupting gameplay.

- Frameless, transparent window — no borders, no chrome
- Click-through when active — all clicks pass to the game
- Draggable via a slim handle at the top
- Adjustable opacity (0–100%) — at or below 50% it becomes fully click-through
- Automatically resizes to fit content

### Session Tracking

Track a full farming run from start to finish.

- Start, pause, resume, and stop controls in the bottom playbar
- Live elapsed timer (HH:MM:SS)
- Tracks every item drop as you pick it up
- Detects zone and map transitions automatically
- Continue a previous session — reload it and keep adding to the totals
- Sessions are saved locally (name, date, total time, map time, maps run, total income)

### Wealth Calculation

All drops are converted to Farm Essence (FE) using live in-game market prices.

- Prices are captured automatically from the in-game market — no manual entry required
- Each item has a stored unit price and last-update timestamp
- FE totals are calculated per item (quantity × unit price) and summed
- Display rate: FE per hour or FE per minute (your choice)

### Three-Tier Drop Tracking

Drops are tracked independently at three scopes simultaneously:

| Scope | What it covers |
|---|---|
| **Session** | Everything picked up since you started |
| **Map** | Only the current map run |
| **Seasonal** | Only the current seasonal event instance |

Each scope has its own elapsed timer and item breakdown.

### Seasonal Content Support

The tracker automatically detects and tracks these seasonal farming mechanics:

- **Dream (Season 5)** — Detected via level type transitions
- **Clockwork (Season 7)** — Tracks the Clockwork Ballet seasonal event from entry to exit
- **Sandlord (Season 10)** — Covers the Sandlord hub and all its sub-maps as a single tracker; starts on entering the hub and stops on returning to town
- **Carjack (Season 11)** — Combat timer with post-combat loot window (5 seconds)
- **Overrealm (Season 12)** — Multi-stage tracking; captures loot collected after exiting the portal (5-second collection window)
- **Vorex (Season 13)** — Tracks window open/close/abandon states; correctly attributes reward-zone loot even after the window closes

Each seasonal tracker starts and stops independently, pauses when the event pauses, and only counts loot that belongs to that event.

### Item Database & Pricing

A local database of every item you've encountered, with names, types, and prices.

- 9 item types: Ember, Fuel, Compass, Dream, Cube, Fluorescent (card), Skill, Equipment, Map Material, Other
- Search by item ID or name
- Filter view: All items / Unknown (no name) / No Price
- Optional Serper API key for automatic item name lookups (10/day limit)
- Export all item data as `full_table.json`; import it back or share with others

### Dashboard & Analytics

- **Wealth chart** — Area chart of cumulative FE over time, with a range selector (1D / 3D / 7D / 1M / All) and an x-axis that adapts to the selected range — hour-level detail on 1D and 3D, dates on 7D and longer
- **Item breakdown table** — All items with quantity, unit price, and total value columns; sortable by any column; filterable by item type
- **Live event feed** — Real-time log of drops, zone changes, map starts/ends, and errors with color coding and timestamps

### Session History

- List of all saved sessions with sortable columns (name, date, duration, maps run, income)
- Session detail panel: saved date, total time, map time, maps run, unique items, total income
- Per-map breakdown table with a cost-vs-income chart per run, showing entry material spend against drops earned, colour-coded by item type (ember, fuel, dream, cube, card, skill, etc.)
- Rename or delete sessions
- Continue any past session to add new drops to its totals

### Filter System

Control exactly which items are counted in each tracking scope.

- Rule-based: rules are evaluated in order, first match wins
- Two rule types: match by **item type** (e.g. hide all Embers) or match by **specific item**
- Two actions per rule: **Show** (always count) or **Hide** (never count)
- Nine independent scopes: Session, Map, Vorex, Dream, Overrealm, Carjack, Clockwork, Sandlord, Wealth chart
- Multiple named filter sets — enable/disable per set
- Rules can be reordered via drag-and-drop
- Changes take effect live, even mid-session

### Settings

- **Game path** — Point to your Torchlight: Infinite install folder
- **Theme** — System / Dark / Light
- **Language** — Full i18n support
- **FE rate** — Per hour or per minute
- **Overlay opacity** — Slider with live preview
- **Serper API key** — Optional, for item name resolution
- **Logging** — Enable/disable console and file logging per feature area (engine, database, IPC, session, price, etc.)

## Requirements

- Windows 10/11
- [Bun](https://bun.sh) (for development)
- Node.js 18+ (bundled via Electron)

## Installation

### Pre-built release

Download the latest installer from the [Releases](../../releases) page and run the `.exe`.

### Development setup

1. Install [Bun](https://bun.sh):
   ```bash
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Start the dev server:
   ```bash
   bun run dev
   ```

## Building

```bash
bun run build
```

The packaged installer will be output to the `release/` directory.

## Project Structure

```
TLI-WealthTacker/
├── src/
│   ├── main/           # Electron main process (engine, IPC, windows)
│   ├── components/     # Shared React components
│   ├── windows/        # Per-window root components (main, overlay)
│   ├── state/          # Zustand stores (engineStore, etc.)
│   ├── hooks/          # Custom React hooks
│   ├── i18n/           # Translations (feature-split namespaces)
│   ├── types/          # TypeScript types and Electron API declarations
│   └── styles/         # Global CSS / Tailwind theme
├── public/             # Static assets
├── index.html          # Electron renderer entry point
├── vite.config.ts
└── package.json
```

## Configuration

On first launch the app will prompt you to set your Torchlight: Infinite game path. You can change it later in **Settings**.

**Steam default path:**
```
C:/Program Files (x86)/Steam/steamapps/common/Torchlight Infinite/UE_game
```

## Testing

```bash
bun run test
```

## License

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License** (CC BY-NC-SA 4.0).

**You are free to:**
- Share and redistribute the software
- Modify and adapt the source code

**Under these conditions:**
- **Attribution**: Give appropriate credit to the original author
- **NonCommercial**: You may not use this software for commercial purposes
- **ShareAlike**: Distribute your modifications under the same license

See the [LICENSE](LICENSE) file for full details.
