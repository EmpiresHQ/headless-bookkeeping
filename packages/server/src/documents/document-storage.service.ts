import { Injectable, Inject, Optional } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { dataDir } from '../common/paths';

export const DOCUMENT_STORAGE_ROOT = Symbol('DOCUMENT_STORAGE_ROOT');

@Injectable()
export class DocumentStorageService {
  private readonly root: string;

  constructor(
    @Optional()
    @Inject(DOCUMENT_STORAGE_ROOT)
    private readonly injectedRoot: string | undefined,
  ) {
    this.root = this.injectedRoot ?? join(dataDir(), 'documents');
  }

  /**
   * Save a file to the filesystem under `{root}/{id}/{filename}`.
   * Returns the relative storage path.
   */
  async saveFile(
    id: number,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    const storagePath = this.pathFor(id, filename);
    const filePath = join(this.root, storagePath);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return storagePath;
  }

  /**
   * The relative path `saveFile(id, filename)` writes to — known BEFORE the
   * write, so a caller can clean up bytes a failed write left behind.
   */
  pathFor(id: number, filename: string): string {
    return join(String(id), filename);
  }

  /**
   * Save a file under a NAMESPACED directory — `{root}/{namespace}/{id}/{filename}`.
   *
   * For evidence that is NOT a document but is stored on the same seam (a
   * bank import's raw CSV, issue #403): the namespace separates its ids from
   * the document namespace entirely — a document id is always a bare numeric
   * segment, so a non-numeric namespace can never collide with — or
   * overwrite — a stored document's bytes, whichever root this service owns.
   * Returns the root-relative path.
   */
  async saveNamespacedFile(
    namespace: string,
    id: number,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    const storagePath = join(namespace, String(id), filename);
    const filePath = join(this.root, storagePath);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return storagePath;
  }

  async readFile(storagePath: string): Promise<Buffer> {
    const filePath = join(this.root, storagePath);
    return fs.readFile(filePath);
  }

  /** Best-effort delete of a stored file; ignores a missing file. */
  async deleteFile(storagePath: string): Promise<void> {
    try {
      await fs.unlink(join(this.root, storagePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
