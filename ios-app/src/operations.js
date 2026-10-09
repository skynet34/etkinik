// UI actions and TaskManager events share one ordered lane in the JS runtime.
// A failed action must not prevent the next action from running.
let tail = Promise.resolve();
export function serialize(action) {
  const result = tail.then(action);
  tail = result.catch(() => {});
  return result;
}
