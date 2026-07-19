# Contributing to Halo

Thanks for your interest in contributing to Halo! This guide will help you get started.

## About This Project

**Note**: This is a personal hobby project built for self-use and friends. Updates and PR merges happen whenever I find time (usually weekends, but no promises - life happens! 😄).

## Development Setup

```bash
# Clone the repository
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo

# Install dependencies
npm install

# Start development server
npm run dev
```

## Troubleshooting

**App Manager stuck on "not yet initialized" / `NODE_MODULE_VERSION` mismatch in logs**

The `better-sqlite3` native module was compiled for system Node instead of Electron. Rebuild it:

```bash
npx electron-rebuild -f -w better-sqlite3
```

This happens after `npm rebuild`, an interrupted `npm install`, or any `node-gyp` build run under system Node. A full `npm install` fixes it automatically via `postinstall`.

## Project Structure

```
src/
├── main/           # Electron Main Process
│   ├── services/   # Business logic (agent, config, space, conversation...)
│   ├── ipc/        # IPC handlers
│   └── http/       # Remote Access server
├── preload/        # Preload scripts
└── renderer/       # React Frontend
    ├── components/ # UI components
    ├── stores/     # Zustand state management
    ├── api/        # API adapter (IPC/HTTP)
    └── pages/      # Page components
```

## Tech Stack

- **Framework**: Electron + electron-vite
- **Frontend**: React 18 + TypeScript
- **Styling**: Tailwind CSS (use CSS variables, no hardcoded colors)
- **State**: Zustand
- **Icons**: lucide-react

## Code Guidelines

### Language

- **Code & Comments**: Must be in English (for i18n compatibility)
- **Commit messages**: English preferred
- **Issue/PR**: English, 中文, 日本語, Deutsch, Français, Español are welcome

### Styling

Use Tailwind CSS with theme variables:

```tsx
// Good
<div className="bg-background text-foreground border-border">

// Bad
<div className="bg-white text-black border-gray-200">
```

### Internationalization

All user-facing text must use `t()` for i18n support:

```tsx
// Good
<Button>{t('Save')}</Button>

// Bad - hardcoded text breaks i18n
<Button>Save</Button>
```

Run `npm run i18n` before committing to extract new strings.

**Important**: Never hardcode user-facing strings. The app supports multiple languages.

### Adding IPC Channels

When adding a new IPC event, update these 3 files:

1. `src/preload/index.ts` - Expose to `window.halo`
2. `src/renderer/api/transport.ts` - Add to `methodMap`
3. `src/renderer/api/index.ts` - Export unified API

## Pull Request Process

### 1. Get Started

⭐ **Star the repository** to show your support!

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/hello-halo.git
cd hello-halo
npm install

# Create a feature branch from main
git checkout -b fix/issue-number-description
# or
git checkout -b feat/new-feature-name
```

### 2. Find or Create an Issue

- Check existing [Issues](https://github.com/openkursar/hello-halo/issues)
- Create a new issue if needed
- Comment on the issue to let us know you're working on it

### 3. Development

💡 **Recommended**: Use **Halo + Claude Opus 4.5** for development!

- Follow the [Code Guidelines](#code-guidelines)
- Write code and comments in English
- Use `t()` for all user-facing text
- Run `npm run i18n` after adding new text

### 4. Testing

```bash
npm run dev    # Test your changes locally
```

### 5. Commit Your Changes

Use conventional commit format:

```bash
# Format: <type>: <description>
# Types: feat | fix | docs | style | refactor | test | chore

git commit -m "fix: resolve input method issue in chat"
git commit -m "feat: add multi-model support"
git commit -m "docs: update README translation"
```

### 6. Create Pull Request

```bash
git push origin your-branch-name
```

Then create a PR on GitHub:
- Link the related issue: `Fixes #issue_number`
- Describe what you changed and why
- Include screenshots for UI changes

### 7. Review Process

- Maintainers will review your code
- Address any feedback if requested
- Once approved, maintainers will merge and handle final testing/building

## Extending Halo

### Custom AI Providers

Halo supports custom AI source providers through a plugin architecture. You can create your own OAuth or API key-based providers.

See **[docs/custom-providers.md](docs/custom-providers.md)** for the complete guide, including:
- Provider interface definitions
- Type references (`@shared/interfaces`, `@shared/types`)
- Implementation examples
- Registration via `product.json`

## Areas We Need Help

- **Translations** - Add/improve translations in `src/renderer/i18n/`
- **Bug fixes** - Check GitHub Issues
- **Documentation** - Improve README, add guides
- **Features** - Discuss in GitHub Discussions first

## Questions?

- Open a [GitHub Discussion](https://github.com/openkursar/hello-halo/discussions)
- Check existing [Issues](https://github.com/openkursar/hello-halo/issues)

Thank you for contributing!
