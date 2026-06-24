/**
 * DocumentStorageService spec
 *
 * Covers the real filesystem behaviour. The critical case is a nested filename
 * like `previews/{hash}.png` — the intermediate `previews/` directory must be
 * created automatically, otherwise `writeFile` throws ENOENT.
 *
 * RED: this test FAILS before the Finding-1 fix (saveFile does not mkdir the
 *      full parent of the target file, only {root}/{id}).
 * GREEN: passes after the fix (mkdir uses dirname(filePath)).
 */
import { mkdtemp, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DocumentStorageService, DOCUMENT_STORAGE_ROOT } from './document-storage.service';

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'doc-storage-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('DocumentStorageService — real filesystem', () => {
  it('saves a flat filename under {root}/{id}/{filename}', async () => {
    await withTmpDir(async (root) => {
      const svc = new DocumentStorageService(root);
      const buf = Buffer.from('hello');

      const relPath = await svc.saveFile(7, 'doc.pdf', buf);

      expect(relPath).toBe(join('7', 'doc.pdf'));
      const fullPath = join(root, relPath);
      const s = await stat(fullPath);
      expect(s.isFile()).toBe(true);
    });
  });

  it('creates intermediate directories for nested filenames (e.g. previews/{hash}.png)', async () => {
    // This is the RED test: PreviewRenderer calls saveFile with filename
    // `previews/{hash}.png`. Before the fix, saveFile only mkdir's {root}/{id}
    // and the subsequent writeFile throws ENOENT because `previews/` does not
    // exist. After the fix (mkdir(dirname(filePath))), this passes.
    await withTmpDir(async (root) => {
      const svc = new DocumentStorageService(root);
      const buf = Buffer.from('fake-png-bytes');
      const hash = 'aabbccdd11223344556677889900aabb';

      const relPath = await svc.saveFile(42, `previews/${hash}.png`, buf);

      expect(relPath).toBe(join('42', 'previews', `${hash}.png`));
      const fullPath = join(root, relPath);
      const s = await stat(fullPath);
      expect(s.isFile()).toBe(true);
    });
  });

  it('readFile round-trips the saved buffer', async () => {
    await withTmpDir(async (root) => {
      const svc = new DocumentStorageService(root);
      const original = Buffer.from('round-trip-data');

      const relPath = await svc.saveFile(3, 'data.bin', original);
      const read = await svc.readFile(relPath);

      expect(read).toEqual(original);
    });
  });

  it('deleteFile removes the file and ignores a missing file', async () => {
    await withTmpDir(async (root) => {
      const svc = new DocumentStorageService(root);
      const relPath = await svc.saveFile(5, 'todelete.txt', Buffer.from('x'));

      await svc.deleteFile(relPath);

      await expect(stat(join(root, relPath))).rejects.toMatchObject({ code: 'ENOENT' });
      // Second delete must not throw.
      await expect(svc.deleteFile(relPath)).resolves.toBeUndefined();
    });
  });
});
