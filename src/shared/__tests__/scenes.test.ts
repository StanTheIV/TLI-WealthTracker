import {describe, expect, it} from 'vitest';
import {
  ARCANA_FIGHT_SCENE, MAP_SCENE_PREFIXES, SANDLORD_HUB_SCENE, SEASONAL_SCENE_MARKERS,
  TARTARUS_PRISON_SCENE, TOWN_SCENE, VOREX_REWARD_SCENE,
} from '@/shared/scenes';
import {LOG_SUBPATH} from '@/shared/paths';

describe('shared scene markers', () => {
  it('pins the game scene substrings', () => {
    expect(TOWN_SCENE).toBe('YuJinZhiXiBiNanSuo');
    expect(ARCANA_FIGHT_SCENE).toBe('SuMingTaLuo');
    expect(VOREX_REWARD_SCENE).toBe('DiXiaZhenSuo');
    expect(TARTARUS_PRISON_SCENE).toBe('ZhongZuiDiYu');
    expect(SANDLORD_HUB_SCENE).toBe('YunDuanLvZhou');
    expect(MAP_SCENE_PREFIXES).toEqual(['/Game/Art/Maps/', '/Game/Art/Season/']);
  });

  it('SEASONAL_SCENE_MARKERS is exactly the arcana/vorex/tartarus scenes', () => {
    expect([...SEASONAL_SCENE_MARKERS].sort()).toEqual(['DiXiaZhenSuo', 'SuMingTaLuo', 'ZhongZuiDiYu']);
  });

  it('pins the log subpath', () => {
    expect(LOG_SUBPATH).toBe('TorchLight/Saved/Logs/UE_game.log');
  });
});
