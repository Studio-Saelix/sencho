/**
 * `linkSpellings`: the paths a file under the compose root has on the way to
 * what it names, which the directory fences match and register file work by.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkSpellings, UNPLACEABLE_LINK_CHAIN } from '../helpers/linkSpellings';

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
    const spellings = await linkSpellings(path.join(web, 'app.env'));
    expect(spellings).toContain(path.join(root, 'web', 'data', 'app.env'));
  });

  it('follows a hop spelled through an alias of a directory inside the compose root', async () => {
    const alias = path.join(scratch, 'web-alias');
    fs.symlinkSync(path.join(root, 'web'), alias);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    fs.symlinkSync(path.join(alias, 'mid.env'), path.join(web, 'app.env'));
    expect(await linkSpellings(path.join(web, 'app.env'))).toContain(path.join(web, 'data', 'app.env'));
  });

  it('follows a hop spelled by the real path when the compose root is configured through a link, and the reverse', async () => {
    const configured = path.join(scratch, 'configured');
    fs.symlinkSync(root, configured);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    // Configured through the link, the hop spelled by the real path.
    fs.symlinkSync(path.join(root, 'web', 'mid.env'), path.join(web, 'app.env'));
    const viaLink = await linkSpellings(path.join(configured, 'web', 'app.env'));
    expect(viaLink.some((s) => s.endsWith(path.join('web', 'data', 'app.env')))).toBe(true);
    // Configured by the real path, the hop spelled through the link.
    fs.rmSync(path.join(web, 'app.env'));
    fs.symlinkSync(path.join(configured, 'web', 'mid.env'), path.join(web, 'app.env'));
    expect(await linkSpellings(path.join(web, 'app.env'))).toContain(path.join(web, 'data', 'app.env'));
  });

  it('follows a hop through a link outside the compose root that points back into it, to a target that is gone', async () => {
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(root, 'web', 'data', 'app.env'), path.join(outside, 'link.env'));
    fs.symlinkSync(path.join(outside, 'link.env'), path.join(root, 'web', 'app.env'));
    expect(await linkSpellings(path.join(root, 'web', 'app.env'))).toContain(path.join(root, 'web', 'data', 'app.env'));
  });

  it('follows an alias outside the compose root of a directory that was moved aside', async () => {
    const alias = path.join(scratch, 'sub-alias');
    fs.symlinkSync(path.join(root, 'web', 'data', 'sub'), alias);
    fs.symlinkSync(path.join(alias, 'app.env'), path.join(root, 'web', 'app.env'));
    // data/sub does not exist: the restore moved it aside.
    expect(await linkSpellings(path.join(root, 'web', 'app.env'))).toContain(path.join(root, 'web', 'data', 'sub', 'app.env'));
  });

  it('resolves a relative hop that climbs above a compose root configured through a link from where the link really is', async () => {
    // The root is configured through a link two levels deeper than the real
    // root, so `..` from the configured spelling names a different directory.
    const nest = path.join(scratch, 'a', 'b');
    fs.mkdirSync(nest, { recursive: true });
    const configured = path.join(nest, 'configured');
    fs.symlinkSync(root, configured);
    const web = path.join(root, 'web');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(web, 'mid.env'));
    fs.symlinkSync(path.join('..', '..', 'compose', 'web', 'mid.env'), path.join(web, 'app.env'));
    // data/app.env does not exist: the restore moved it aside.
    expect(await linkSpellings(path.join(configured, 'web', 'app.env'))).toContain(path.join(web, 'data', 'app.env'));
  });

  it('takes a .. after a linked component of a target from where that link points, inside and outside the compose root', async () => {
    const web = path.join(root, 'web');
    fs.mkdirSync(path.join(web, 'data', 'inner'));
    // Inside: web/x -> data/inner, so x/../app.env is data/app.env, not web/app.env.
    fs.symlinkSync(path.join('data', 'inner'), path.join(web, 'x'));
    fs.symlinkSync(`x${path.sep}..${path.sep}app.env`, path.join(web, 'in.env'));
    expect(await linkSpellings(path.join(web, 'in.env'))).toContain(path.join(web, 'data', 'app.env'));
    // Outside: web/out.env -> <out>/x.env -> lnk/../app.env, with <out>/lnk -> web/data/inner.
    const out = path.join(scratch, 'out');
    fs.mkdirSync(out);
    fs.symlinkSync(path.join(web, 'data', 'inner'), path.join(out, 'lnk'));
    fs.symlinkSync(`lnk${path.sep}..${path.sep}app.env`, path.join(out, 'x.env'));
    fs.symlinkSync(path.join(out, 'x.env'), path.join(web, 'out.env'));
    expect(await linkSpellings(path.join(web, 'out.env'))).toContain(path.join(web, 'data', 'app.env'));
  });

  it('ends a chain whose spelling grows past the kernel path limit with a spelling no fence can place', async () => {
    const web = path.join(root, 'web');
    // l -> l/l/.../x: every hop makes the path longer.
    fs.symlinkSync(path.join(...Array.from({ length: 200 }, () => 'l'), 'x'), path.join(web, 'l'));
    const started = Date.now();
    const spellings = await linkSpellings(path.join(web, 'l'));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(spellings).toContain(UNPLACEABLE_LINK_CHAIN);
    expect(spellings.every((s) => Buffer.byteLength(s) <= 4096)).toBe(true);
  });

  it('ends a loop after the hop limit', async () => {
    const web = path.join(root, 'web');
    fs.symlinkSync('b.env', path.join(web, 'a.env'));
    fs.symlinkSync('a.env', path.join(web, 'b.env'));
    const spellings = await linkSpellings(path.join(web, 'a.env'));
    expect(spellings.sort()).toEqual([path.join(web, 'a.env'), path.join(web, 'b.env')].sort());
  });

  it('stops at a component that is not a directory', async () => {
    const web = path.join(root, 'web');
    fs.writeFileSync(path.join(web, 'plain'), 'x');
    expect(await linkSpellings(path.join(web, 'plain', 'below'))).toEqual([path.join(web, 'plain', 'below')]);
  });

  it('gives a plain path only itself', async () => {
    expect(await linkSpellings(path.join(root, 'web', 'data', 'missing.env')))
      .toEqual([path.join(root, 'web', 'data', 'missing.env')]);
  });
});
