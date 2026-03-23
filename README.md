# TLI Wealth Tracker

A real-time farming session tracker for Torchlight: Infinite, built as a desktop overlay application.

## Features

- Real-time session tracking with start/pause/resume/stop controls
- Always-on-top transparent overlay — stays visible while you play
- Tracks drops, zone transitions, phases, and session elapsed time
- Dual-window architecture: main app window + in-game overlay
- Multi-language support (i18n)

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
