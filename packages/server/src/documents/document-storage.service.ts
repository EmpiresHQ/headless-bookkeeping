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
