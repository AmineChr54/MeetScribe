/**
 * CPU threads for the live workers when the setting is 0 (auto). Pure.
 *
 * faster-whisper uses 4 threads whatever the CPU. On a big CPU that leaves the
 * live model slower than it needs to be: a small model at 8 threads keeps a
 * line under ~2 s where 4 threads can fall behind. Half the cores, shared by
 * the workers, between 4 (faster-whisper's own default) and 8 (gains flatten
 * out and the final pass and the app need the rest).
 */
const MIN_LIVE_THREADS = 4;
const MAX_LIVE_THREADS = 8;

function liveCpuThreads(cores, workers = 1) {
  const share = Math.floor((Number(cores) || 0) / 2 / Math.max(1, Number(workers) || 1));
  return Math.max(MIN_LIVE_THREADS, Math.min(MAX_LIVE_THREADS, share));
}

module.exports = { MIN_LIVE_THREADS, MAX_LIVE_THREADS, liveCpuThreads };
