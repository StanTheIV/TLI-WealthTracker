# Contributing

Thanks for your interest!

## How to contribute

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Open a pull request to `main`

## Development setup

```bash
bun install
bun run dev
```

Run tests before submitting:

```bash
bun run test
```

## Notes

- Direct pushes to `main` are disabled
- Pull requests require review before merging
- Keep PRs focused and small when possible
- Follow the existing code style (TypeScript strict, Tailwind for all styling)
- Use `bun add` / `bun remove` — never npm or yarn
- All user-facing strings must go through i18n (see `src/i18n/`)
