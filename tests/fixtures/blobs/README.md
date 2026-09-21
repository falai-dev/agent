# Session blob fixtures

Input for `tests/migrate.test.ts`.

- `prospectar-midflow.json`: a 3.x `SessionState` parked mid-flow (`currentFlow` + `currentStep`), with data, one completed flow in `flowHistory` and dated metadata.
- `ilojista-signals.json`: mid-flow plus `signals.triggers` with three once-fired signals (`not_interested_detection`, `pediu_preco`, `bot_detected`), one cooldown signal (`lembrete_carrinho`) and a `pendingDirective` that must be dropped.
- `v4.json`: a session already in the v4 shape; it must pass through unchanged.

These are synthetic, written from the 3.x types in `git show 3.x:src/types/session.ts` and `3.x:src/types/signals.ts`. Phase D replaces them with anonymised real rows from prospectar and ilojista.
