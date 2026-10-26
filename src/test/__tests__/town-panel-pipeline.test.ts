/**
 * End to end: an Arcana panel opened and backed out in town, reopened, then the
 * Fateful Contest. Only the fight's loot belongs in the session. The same log
 * is pinned as the `town-panel-activity` golden master.
 */
import {describe, expect, it} from 'vitest';
import {createDispatcher} from '@/worker/create-dispatcher';
import {runPipeline, pipelineInvariants} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {BODY, CUBE, FE, SYNTHETIC_FIXTURES} from '../golden/synthetic';

const townPanelActivity = SYNTHETIC_FIXTURES['town-panel-activity'];

describe('the synthetic S9 markers', () => {
  it('are recognised by the real dispatcher', () => {
    const d = createDispatcher();
    expect(d.dispatch(BODY.s9Minigame)).toEqual([{type: 's9_minigame'}]);
    expect(d.dispatch(BODY.s9Close)).toEqual([{type: 's9_close'}]);
  });
});

describe('town Arcana panel, backed out, then the fight', () => {
  it('credits exactly the fight loot to the session, and the per-source split adds up', async () => {
    const result = await runPipeline(townPanelActivity, {items: GOLDEN_ITEMS});

    expect(result.sessions).toHaveLength(1);
    const {id, session} = result.sessions[0];
    expect(session).not.toBeNull();
    // Item ids are object keys, hence strings.
    expect(session!.drops).toEqual({[FE]: 12, [CUBE]: 2});
    expect(session!.dropsBySource).toEqual({arcana: {[FE]: 12, [CUBE]: 2}});
    expect(pipelineInvariants(result)[id].dropsBySourceSumsToDrops.ok).toBe(true);
  });

  it('starts no map', async () => {
    const result = await runPipeline(townPanelActivity, {items: GOLDEN_ITEMS});
    expect(result.sessions[0].session!.mapCount).toBe(0);
    expect(result.events.some(e => e.event.type === 'map_started')).toBe(false);
  });
});
