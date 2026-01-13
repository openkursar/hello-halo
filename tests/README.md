# Halo Test Suite

This directory contains the automated test infrastructure for Halo.

## Test Layers

| Layer | Tool | Purpose | Run Command |
|-------|------|---------|-------------|
| Pre-build Check | Shell/Node | Verify binary dependencies before packaging | `npm run test:check` |
| Unit Tests | Vitest | Test core service logic without Electron | `npm run test:unit` |
| E2E Smoke Tests | Playwright | Verify app launches and core flows work | `npm run test:e2e` |

## Directory Structure

```
tests/
├── check/                    # Pre-build verification scripts
│   └── binaries.mjs          # Binary dependency checker
├── unit/                     # Unit tests (Vitest)
│   └── services/             # Service layer tests
│       ├── config.test.ts    # Config service tests
│       └── space.test.ts     # Space service tests
├── e2e/                      # E2E tests (Playwright + Electron)
│   ├── specs/                # Test specifications
│   │   └── smoke.spec.ts     # Smoke tests
│   └── fixtures/             # Test fixtures and helpers
│       └── electron.ts       # Electron app fixture
├── vitest.config.ts          # Vitest configuration
├── playwright.config.ts      # Playwright configuration
└── README.md                 # This file
```

## Running Tests

### All Tests (Recommended before release)
```bash
npm run test
```

### Individual Test Layers
```bash
# Pre-build checks only
npm run test:check

# Unit tests only
npm run test:unit

# E2E tests only (requires built app)
npm run test:e2e
```

## Pre-release Checklist

The deploy script (`scripts/deploy_local_M4.sh`) automatically runs:
1. `test:check` - Verify binary dependencies
2. `test:unit` - Run unit tests
3. Build the application
4. `test:e2e:smoke` - Run smoke tests on built app

## Writing Tests

### Unit Tests
- Place in `tests/unit/services/`
- Use `.test.ts` extension
- Mock Electron APIs when needed

### E2E Tests
- Place in `tests/e2e/specs/`
- Use `.spec.ts` extension
- Use the `electronApp` fixture for launching the app

## CI Integration

Tests are designed to run locally on the build machine (M4 Mac).
Future: GitHub Actions integration for automated testing.
