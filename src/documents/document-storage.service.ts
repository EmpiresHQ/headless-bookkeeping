import { Injectable, Inject, Optional } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';

export const DOCUMENT_STORAGE_ROOT = Symbol('DOCUMENT_STORAGE_ROOT');

@Injectable()
export class DocumentStorageService {
  private readonly root: string;

  constructor(
    @Optional()
    @Inject(DOCUMENT_STORAGE_ROOT)
    private readonly injectedRoot: string | undefined,
  ) {
    this.root = this.injectedRoot ?? join(process.cwd(), 'data', 'documents');
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
    const dir = join(this.root, String(id));
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, filename);
    await fs.writeFile(filePath, buffer);
    return join(String(id), filename);
  }

  async readFile(storagePath: string): Promise<Buffer> {
    const filePath = join(this.root, storagePath);
    return fs.readFile(filePath);
  }
}
