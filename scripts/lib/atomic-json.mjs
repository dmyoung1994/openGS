import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';

// Write a JSON checkpoint through a same-directory rename. A benchmark may be
// interrupted while Chrome is still alive; readers must see either the previous
// complete report or this complete snapshot, never a truncated report.json.
export async function atomicJsonCheckpoint(path, value) {
  const directory = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '.';
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* preserve the original write error */ }
    throw error;
  }
}
