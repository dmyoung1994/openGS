let pending;
export function loadCourseLibrary() {
  return pending ??= fetch('/courses/index.json').then(async response => {
    if (!response.ok) throw new Error('Saved courses could not be loaded.');
    const entries = await response.json();
    if (!Array.isArray(entries) || entries.some(entry => !entry?.name
      || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)
      || !(entry.url === '/course.json' || /^\/courses\/[a-z0-9][a-z0-9-]*\.json$/.test(entry.url)))) {
      throw new Error('Saved course list is invalid.');
    }
    return entries;
  }).catch(error => { pending = null; throw error; });
}

export function savedCoursePath(entries, id) {
  const entry = entries.find(entry => entry.id === id);
  if (!entry) throw new Error(`Saved course not found: ${id}`);
  return entry.url;
}
