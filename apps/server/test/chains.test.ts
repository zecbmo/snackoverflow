import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainDto, ChainMenuItemDto } from '@snackoverflow/shared';
import { loadChainSeed, syncChains } from '../src/services/chains';
import { client, makeTestApp, setupAdmin, type TestApp } from './helpers';

const fixtures = fileURLToPath(new URL('./fixtures/chains', import.meta.url));

let t: TestApp | null = null;
let tmp: string | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

async function setup() {
  t = await makeTestApp();
  const seed = loadChainSeed(fixtures);
  expect(seed.problems).toEqual([]);
  expect(await syncChains(t.ctx.db, seed.chains)).toEqual({ updated: 3 });
  return setupAdmin(t.app);
}

describe('chains', () => {
  it('lists every chain with its menu size and calorie range', async () => {
    const api = await setup();
    const list = await api.get<ChainDto[]>('/api/chains');
    expect(list.map((c) => [c.name, c.category, c.itemCount, c.kcalMin, c.kcalMax])).toEqual([
      ['Burger Barn', 'Burgers and fried chicken', 6, 170, 540],
      ['Noodle Bar', 'Asian', 3, 300, 1050],
      ['Pizza Place', 'Pizza', 0, null, null],
    ]);
    expect(list[0]).toMatchObject({ aliases: ['bb', 'the barn'], sourceUrl: 'https://example.com/burger-barn/nutrition', retrievedOn: '2026-11-01', notes: null });
    expect(list[2]).toMatchObject({ notes: 'Closed some sites; check', sourceUrl: null, retrievedOn: null });
  });

  it("shows a chain's menu in the order of its file, with what isn't published left empty", async () => {
    const api = await setup();
    const { chain, items } = await api.get<{ chain: ChainDto; items: ChainMenuItemDto[] }>('/api/chains/burger_barn');
    expect(chain.name).toBe('Burger Barn');
    expect(items.map((i) => i.name)).toEqual(['Barn Burger', 'Cheese Burger', 'Chips (Small)', 'Chips (Large)', 'Cola (Medium)', 'Apple Pie']);
    expect(items[0]).toMatchObject({ chainName: 'Burger Barn', section: 'Burgers', serving: '1 burger', servingG: 220, kcal: 540, fat: 27, saturates: 10, carbs: 44, sugars: 9, fibre: 3, protein: 28, salt: 2.3 });
    expect(items[4]).toMatchObject({ kcal: 170, sugars: 42, fat: null, protein: null, servingG: null });
    const res = await api.raw('GET', '/api/chains/nowhere');
    expect(res.statusCode).toBe(404);
  });

  it('finds menu items by name, chain or nickname', async () => {
    const api = await setup();
    const names = (items: ChainMenuItemDto[]) => items.map((i) => `${i.chainName}: ${i.name}`);
    expect(names(await api.get('/api/chain-items?q=chips'))).toEqual(['Burger Barn: Chips (Small)', 'Burger Barn: Chips (Large)', 'Noodle Bar: Chips (Small)']);
    expect(names(await api.get('/api/chain-items?q=bb%20chips'))).toEqual(['Burger Barn: Chips (Small)', 'Burger Barn: Chips (Large)']);
    expect(names(await api.get('/api/chain-items?q=chips&chain=noodle_bar'))).toEqual(['Noodle Bar: Chips (Small)']);
    // Names that start with the words come before ones that only contain them.
    expect(names(await api.get('/api/chain-items?q=burger&chain=burger_barn'))).toEqual([
      'Burger Barn: Barn Burger',
      'Burger Barn: Cheese Burger',
      'Burger Barn: Chips (Small)',
      'Burger Barn: Chips (Large)',
      'Burger Barn: Cola (Medium)',
      'Burger Barn: Apple Pie',
    ]);
    expect(names(await api.get('/api/chain-items?q=curry&limit=1'))).toEqual(['Noodle Bar: Katsu Curry']);
    // The nickname matches every item; the one with more words in its own name comes first.
    expect(names(await api.get('/api/chain-items?q=bb%20cheese%20burger'))).toEqual(['Burger Barn: Cheese Burger']);
    expect((await api.raw('GET', '/api/chain-items?q=')).statusCode).toBe(400);
  });

  it('needs a signed-in person', async () => {
    await setup();
    const anon = client(t!.app);
    expect((await anon.raw('GET', '/api/chains')).statusCode).toBe(401);
    expect((await anon.raw('GET', '/api/chain-items?q=chips')).statusCode).toBe(401);
  });

  it('follows the seed files: unchanged chains are skipped, changed menus keep the ids of items still listed', async () => {
    const api = await setup();
    expect(await syncChains(t!.ctx.db, loadChainSeed(fixtures).chains)).toEqual({ updated: 0 });
    const before = (await api.get<{ items: ChainMenuItemDto[] }>('/api/chains/burger_barn')).items;

    tmp = mkdtempSync(join(tmpdir(), 'chains-'));
    cpSync(fixtures, tmp, { recursive: true });
    // Pizza Place is gone; Burger Barn drops the apple pie, changes the cola and adds a shake.
    writeFileSync(join(tmp, 'chains.csv'), 'key,name,category,aliases,notes,source_url,retrieved_on\nburger_barn,Burger Barn,Burgers and fried chicken,bb,,,\nnoodle_bar,Noodle Bar,Asian,,,https://example.com/noodle-bar/menu.pdf,2026-10-20\n');
    writeFileSync(
      join(tmp, 'chain-menus', 'burger_barn.csv'),
      'item,section,serving,serving_g,kcal,fat_g,sat_fat_g,carbs_g,sugars_g,fibre_g,protein_g,salt_g\nBarn Burger,Burgers,1 burger,220,540,27,10,44,9,3,28,2.3\nCola (Medium),Drinks,Medium,,180,,,,44,,,\nShake,Desserts,Regular,,400,,,,,,,\n',
    );
    expect(await syncChains(t!.ctx.db, loadChainSeed(tmp).chains)).toEqual({ updated: 1 });

    expect((await api.get<ChainDto[]>('/api/chains')).map((c) => c.name)).toEqual(['Burger Barn', 'Noodle Bar']);
    const after = (await api.get<{ items: ChainMenuItemDto[] }>('/api/chains/burger_barn')).items;
    expect(after.map((i) => [i.name, i.kcal])).toEqual([
      ['Barn Burger', 540],
      ['Cola (Medium)', 180],
      ['Shake', 400],
    ]);
    const id = (items: ChainMenuItemDto[], name: string) => items.find((i) => i.name === name)!.id;
    expect(id(after, 'Barn Burger')).toBe(id(before, 'Barn Burger'));
    expect(id(after, 'Cola (Medium)')).toBe(id(before, 'Cola (Medium)'));
  });
});
