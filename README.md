# 691SIM

FRC robot wiring and power verification simulator. Place devices, connect wires, and check voltage drop, brownout risk, wire ampacity, CAN topology, and related diagnostics before you build the harness.

## Monorepo layout

| Path | Role |
|------|------|
| `packages/core` | Shared types, severity, sample robot models |
| `packages/registry` | Device definitions (ports, metadata, ratings) |
| `packages/serialization` | Load / save robot project JSON |
| `packages/verifier` | Static wiring rule checks |
| `packages/simulation` | Circuit solver, voltage / brownout, match-log helpers |
| `packages/estimator` | Lightweight load / brownout estimates |
| `apps/web` | Browser UI for editing and simulating a robot model |

## Install and run

```bash
pnpm install
pnpm run build   # required before tests — packages must be built first
pnpm test
pnpm typecheck
pnpm lint
pnpm dev:web     # local web app
```

Use **pnpm** (packageManager `9.15.0`). Do not rely on `package-lock.json` if present; `pnpm-lock.yaml` is authoritative.

## Match-log comparison script

After `pnpm run build` (so `packages/simulation/dist` exists):

```bash
node scripts/match-log-compare.mjs <input.csv> <output.csv> [robot.json]
```

- `input.csv` — match log with measured voltages (see `packages/simulation/src/fixtures/match-log-SYNTHETIC.csv`)
- `output.csv` — written comparison stats
- `robot.json` — optional robot model (or project JSON with a `model` field); defaults to a built-in swerve sample

## Current limitations

- The web app currently wires up the circuit solver and verifier only.
- Kraken / Talon supply-current helpers, swerve model builders, battery state-of-charge, match-run, and match-log comparison are tested library code in `packages/simulation` and are **not** exposed in the UI yet.
- Most non-roboRIO minimum voltages in `packages/simulation/src/limits.ts` are still `null` until datasheet values are filled in.
- The only match-log fixture is synthetic (`match-log-SYNTHETIC.csv`), not a real robot log.
