/**
 * Compile-time drift guard for the duplicated EngineEvent union.
 *
 * The engine event shape is declared in TWO places, kept in sync by convention:
 *   - src/main/engine/types.ts   (main-process `EngineEvent`)
 *   - src/types/electron.d.ts    (renderer `EngineEvent`)
 *
 * This file is NOT a runtime test — it has no `.test.ts` suffix, so the vitest
 * include glob (`src/**\/*.test.ts`) skips it. It exists purely so that `tsc`
 * fails if the two unions drift apart. Both assignments below must typecheck:
 * each direction proves the other union is assignable to it, i.e. they describe
 * the same set of shapes.
 *
 * If either line errors, reconcile the two definitions (prefer moving the
 * renderer copy toward the main-process definition) until both compile.
 */
import type {EngineEvent as MainEngineEvent} from '@/main/engine/types';
import type {EngineEvent as RendererEngineEvent} from '@/types/electron';

// Every MainEngineEvent must be a valid RendererEngineEvent…
const _mainToRenderer: RendererEngineEvent = {} as MainEngineEvent;
// …and every RendererEngineEvent must be a valid MainEngineEvent.
const _rendererToMain: MainEngineEvent = {} as RendererEngineEvent;

// Reference the bindings so `noUnusedLocals`-style rules stay quiet without
// widening either type through a function boundary.
export const __typeSyncCheck = [_mainToRenderer, _rendererToMain] as const;
