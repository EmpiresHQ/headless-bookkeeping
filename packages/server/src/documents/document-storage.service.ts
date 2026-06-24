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
    const filePath = join(this.root, String(id), filename);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
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
