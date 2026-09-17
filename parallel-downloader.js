// Bounded parallel download worker pool for the Ghosts launcher.
// The caller supplies already-filtered manifest entries and a worker function.
async function downloadMany(items, worker, concurrency = 8) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= list.length) return;

      try {
        results[index] = {
          ok: true,
          value: await worker(list[index], index)
        };
      } catch (error) {
        results[index] = {
          ok: false,
          error
        };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

module.exports = { downloadMany };
