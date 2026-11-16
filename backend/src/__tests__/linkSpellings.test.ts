/**
 * `linkSpellings`: the paths a file under the compose root has on the way to
 * what it names, which the directory fences match and register file work by.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkSpellings } from '../helpers/linkSpellings';

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-spellings-')));
  root = path.join(scratch, 'compose');
  fs.mkdirSync(path.join(root, 'web', 'data'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('linkSpellings', () => {
  it('follows a chain whose middle hop is spelled through an alias of the compose root, to a target that is gone', async () => {
    const alias = path.join(scratch, 'alias');
    fs.symlinkSync(root, alias);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    fs.symlinkSync(path.join(alias, 'web', 'mid.env'), path.join(web, 'app.env'));
    // data/app.env does not exist: the restore moved it aside.
    const spellings = await linkSpellings(path.join(web, 'app.env'), root);
    expect(spellings).toContain(path.join(root, 'web', 'data', 'app.env'));
  });

  it('follows a hop spelled through an alias of a directory inside the compose root', async () => {
    const alias = path.join(scratch, 'web-alias');
    fs.symlinkSync(path.join(root, 'web'), alias);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    fs.symlinkSync(path.join(alias, 'mid.env'), path.join(web, 'app.env'));
    expect(await linkSpellings(path.join(web, 'app.env'), root)).toContain(path.join(web, 'data', 'app.env'));
  });

  it('follows a hop spelled by the real path when the compose root is configured through a link, and the reverse', async () => {
    const configured = path.join(scratch, 'configured');
    fs.symlinkSync(root, configured);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    // Configured through the link, the hop spelled by the real path.
    fs.symlinkSync(path.join(root, 'web', 'mid.env'), path.join(web, 'app.env'));
    const viaLink = await linkSpellings(path.join(configured, 'web', 'app.env'), configured);
    expect(viaLink.some((s) => s.endsWith(path.join('web', 'data', 'app.env')))).toBe(true);
    // Configured by the real path, the hop spelled through the link.
    fs.rmSync(path.join(web, 'app.env'));
    fs.symlinkSync(path.join(configured, 'web', 'mid.env'), path.join(web, 'app.env'));
    expect(await linkSpellings(path.join(web, 'app.env'), root)).toContain(path.join(web, 'data', 'app.env'));
  });

  it('does not read a link outside the compose root', async () => {
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(root, 'web', 'data', 'x'), path.join(outside, 'link'));
    fs.symlinkSync(path.join(outside, 'link'), path.join(root, 'web', 'app.env'));
    const spellings = await linkSpellings(path.join(root, 'web', 'app.env'), root);
    expect(spellings).toContain(path.join(outside, 'link'));
    expect(spellings).not.toContain(path.join(root, 'web', 'data', 'x'));
  });

  it('ends a loop after the hop limit', async () => {
    const web = path.join(root, 'web');
    fs.symlinkSync('b.env', path.join(web, 'a.env'));
    fs.symlinkSync('a.env', path.join(web, 'b.env'));
    const spellings = await linkSpellings(path.join(web, 'a.env'), root);
    expect(spellings.sort()).toEqual([path.join(web, 'a.env'), path.join(web, 'b.env')].sort());
  });

  it('stops at a component that is not a directory', async () => {
    const web = path.join(root, 'web');
    fs.writeFileSync(path.join(web, 'plain'), 'x');
    expect(await linkSpellings(path.join(web, 'plain', 'below'), root)).toEqual([path.join(web, 'plain', 'below')]);
  });

  it('gives a plain path only itself', async () => {
    expect(await linkSpellings(path.join(root, 'web', 'data', 'missing.env'), root))
      .toEqual([path.join(root, 'web', 'data', 'missing.env')]);
  });
});
