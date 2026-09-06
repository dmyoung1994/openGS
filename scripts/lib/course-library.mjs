import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function readCourseLibrary(root) {
  const directory = path.join(root, 'public/courses');
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [{ id: 'current', url: '/course.json', file: path.join(root, 'course.json') },
    ...names.filter(name => /^[a-z0-9][a-z0-9-]*\.json$/.test(name) && name !== 'index.json')
      .sort().map(name => ({ id: name.slice(0, -5), url: `/courses/${name}`, file: path.join(directory, name) }))];
  return Promise.all(files.map(async ({ file, ...entry }) => {
    const course = JSON.parse(await readFile(file, 'utf8'));
    if (!course.meta?.name) throw new Error(`Saved course has no name: ${entry.id}`);
    return { ...entry, name: course.meta.name, holes: course.routing?.holes?.length || 1 };
  }));
}

export function courseLibraryPlugin() {
  let root, command;
  return {
    name: 'saved-course-library',
    configResolved(config) { root = config.root; command = config.command; },
    configureServer(server) {
      server.middlewares.use('/courses/index.json', async (_req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(await readCourseLibrary(root)));
        } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
      });
    },
    async buildStart() {
      if (command !== 'build') return;
      this.emitFile({ type: 'asset', fileName: 'courses/index.json',
        source: JSON.stringify(await readCourseLibrary(root)) });
    },
  };
}
